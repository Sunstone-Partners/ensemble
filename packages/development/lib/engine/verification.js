'use strict';

/**
 * TRD-014 (TRD-2026-d571763f): the completion-verification recipe, as a deterministic function.
 *
 * `skills/completion-verification/SKILL.md` describes six steps an agent was asked to carry out
 * by hand. Every one of them is a decision over values -- is this bead closed, does any closed
 * task satisfy this requirement, did the suite exit zero -- so the agent's judgement adds
 * nothing and its forgetfulness takes something away. The steps run here instead, in the skill's
 * own order, printing the skill's own texts.
 *
 * Two properties are what make this worth having and are asserted by the suite:
 *
 * - A gap is never silently dropped. `gapCount` is the length of the gap list, and `COMPLETE` is
 *   only reachable at zero, so no path can report a verdict its own evidence does not support.
 * - The same inputs give the same report. The only clock reading is the report's date, taken
 *   from the dispatcher's `now`, which is why a second run on the same inputs writes the same
 *   bytes.
 *
 * A step that cannot be trusted stops the steps that depend on it: a TRD the parser may have
 * misread produces a `PARSE-FAILURE` gap and steps 2 to 4 are skipped, rather than a confident
 * verdict over an inventory nobody believes.
 */

const fs = require('fs');
const path = require('path');

const MESSAGES = require('./messages');
const { redact } = require('./envelope');
const { callCapability, classify, isClosed, isTaskLevel } = require('./tracker');
const { resolveCallerPath } = require('./validate');
const { resolvePrdPath, toProjectRelative } = require('./trd-source');

/**
 * `completion-verification/SKILL.md:74` -- a task marker is a checkbox followed by a `TRD-` id,
 * bold or not. Counting these independently of the parser is the whole point of step 1: a
 * formatting deviation that makes the parser return fewer tasks than the file holds is exactly
 * the bug the skill exists to catch.
 */
const TASK_LINE_RE = /^\s*- \[[ xX]\]\s+\*{0,2}TRD-[A-Za-z0-9-]+\*{0,2}/;

/** `completion-verification/SKILL.md:86` -- the warning that says the parser found nothing. */
const NO_TASKS_RE = /no tasks found/i;

/**
 * A failing suite names its files this way; `npm`, `jest` and `pytest` all print it. The first
 * line is not anchored to the start of a line because a failing capability arrives as the
 * toolchain's own one-line failure message, which carries the suite's first output line after a
 * prefix naming the adapter -- anchoring would drop exactly the first failing file.
 */
const FAIL_LINE_RE = /(?:^|\s)FAIL\s+(\S+)/gm;

/** How much of a suite's output is kept, matching the toolchain's own failure-detail cap. */
const MAX_SUITE_OUTPUT = 4000;

/** The gap classes, in the order the report prints them. */
const GAP_CLASSES = Object.freeze([
  'PARSE-FAILURE',
  'REQ-PRIORITY-UNPARSED',
  'TASK-OPEN',
  'TEST-GAP',
  'REQ-UNSATISFIED',
  'TEST-SUITE-FAILURE',
]);

/** The priorities a requirement must be covered for (`completion-verification/SKILL.md:163`). */
const BINDING_PRIORITIES = Object.freeze(['Must', 'Should']);

/**
 * Step 1: is the task inventory trustworthy?
 *
 * @param {{parsed: object|null, text: string}} input
 * @returns {{class: string, detail: string}[]} the parse gaps, empty when the inventory holds
 */
function parseGaps({ parsed, text }) {
  if (!parsed) return [{ class: 'PARSE-FAILURE', detail: MESSAGES.PARSE_FAILED_CLI }];

  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  const noTasks = warnings.find(warning => NO_TASKS_RE.test(String(warning)));
  if (noTasks !== undefined) {
    return [{ class: 'PARSE-FAILURE', detail: MESSAGES.parserWarning(String(noTasks)) }];
  }

  const tasksById = parsed.tasksById && typeof parsed.tasksById === 'object' ? parsed.tasksById : {};
  const parsedCount = Object.keys(tasksById).length;
  if (parsedCount === 0) {
    return [{ class: 'PARSE-FAILURE', detail: MESSAGES.TASKS_BY_ID_EMPTY }];
  }

  const independentCount = text.split('\n').filter(line => TASK_LINE_RE.test(line)).length;
  if (parsedCount !== independentCount) {
    return [
      { class: 'PARSE-FAILURE', detail: MESSAGES.parseCountMismatch(parsedCount, independentCount) },
    ];
  }
  return [];
}

/**
 * Step 2: every task the TRD lists, against the status the tracker reports right now.
 *
 * A TEST task is checked through its implementation task, which is what makes a half-finished
 * pair visible; a TEST task with no implementation task of its own is checked directly, because
 * otherwise it would be checked by nobody.
 *
 * @param {{beadByTask: Map<string, object>, tasksById: object}} input
 * @returns {{checked: number, gaps: object[], rows: object[]}}
 */
function inventoryGaps({ beadByTask, tasksById }) {
  const ids = Object.keys(tasksById);
  const closedOf = id => {
    const bead = beadByTask.get(id);
    return bead !== undefined && isClosed(bead);
  };

  const gaps = [];
  const rows = [];
  let checked = 0;

  for (const id of ids) {
    const task = tasksById[id] || {};
    const bead = beadByTask.get(id);
    rows.push({
      bead: bead ? bead.id : null,
      closed: closedOf(id),
      description: String(task.description || task.title || ''),
      id,
    });

    // A TEST task whose implementation task is in the inventory is covered by the pair check
    // below; one without is an orphan, and is checked here or not at all.
    const orphanTest = task.isTest === true && tasksById[id.replace(/-TEST$/, '')] === undefined;
    if (task.isTest === true && !orphanTest) continue;

    checked += 1;
    if (!closedOf(id)) {
      gaps.push({ class: 'TASK-OPEN', detail: MESSAGES.taskStillOpen(id), task: id });
    }
  }

  for (const id of ids) {
    const testId = `${id}-TEST`;
    if (tasksById[testId] === undefined || closedOf(testId)) continue;
    gaps.push({
      class: 'TEST-GAP',
      detail: MESSAGES.testPairOpen(id),
      task: id,
      testTask: testId,
    });
  }

  return { checked, gaps, rows };
}

/**
 * Step 3: does a closed task satisfy every requirement the PRD calls binding?
 *
 * The chain itself is built by `verify-requirements-evidence.js`, the module the skill already
 * uses, so the satisfying tasks named in the report are the ones that module resolved. Whether a
 * requirement is covered is decided here, from step 2's closure answer: a requirement whose only
 * satisfying task is still open is not satisfied.
 *
 * @param {{beadByTask: Map<string, object>, projectRoot: string, slug: string, tasksById: object,
 *   trd: object, trdPath: string}} input
 * @returns {{gaps: object[], rows: object[]|null}} rows is null when there is no PRD to read
 */
function requirementGaps({ beadByTask, projectRoot, slug, tasksById, trd, trdPath }) {
  const prdReference = typeof trd.prdReference === 'string' ? trd.prdReference : '';
  if (prdReference.trim() === '') return { gaps: [], rows: null };

  const prdPath = resolvePrdPath(projectRoot, trdPath, prdReference);
  if (prdPath === null) {
    return {
      gaps: [{ class: 'REQ-UNSATISFIED', detail: MESSAGES.prdUnresolvable(prdReference) }],
      rows: null,
    };
  }

  const { extractPrdContext, extractReqPriorities } = require('../prd-parser');
  const { buildChain } = require('../verify-requirements-evidence');
  const prdText = fs.readFileSync(prdPath, 'utf8');

  // A requirement is declared once; a later repetition of its heading does not redefine its
  // priority, so the first reading wins.
  const priorities = new Map();
  for (const { id, priority } of extractReqPriorities(prdText)) {
    if (!priorities.has(id)) priorities.set(id, priority);
  }

  const relativePrd = toProjectRelative(projectRoot, prdPath);
  const classifiable = [...priorities.values()].filter(priority => priority !== null);
  if (priorities.size === 0 || classifiable.length === 0) {
    return {
      gaps: [
        {
          class: 'REQ-PRIORITY-UNPARSED',
          detail: MESSAGES.reqPriorityUnparsed(relativePrd, priorities.size),
        },
      ],
      rows: null,
    };
  }

  const prdContext = extractPrdContext(prdText);
  const requirements = Object.fromEntries(
    Object.values(prdContext.requirements).map(req => [req.id, { acs: req.acIds, description: req.title }])
  );
  const chain = buildChain({
    beads_evidence: Object.fromEntries(
      Object.keys(tasksById).map(id => {
        const bead = beadByTask.get(id);
        return [id, { status: bead ? bead.status : 'open' }];
      })
    ),
    checkbox_evidence: Object.fromEntries(
      Object.keys(tasksById).map(id => {
        const bead = beadByTask.get(id);
        const targetFiles = Array.isArray(tasksById[id].targetFiles) ? tasksById[id].targetFiles : [];
        return [
          id,
          {
            commit_evidence: [],
            complete: bead !== undefined && isClosed(bead),
            file_evidence: targetFiles.map(file => ({
              commit_date: null,
              commit_sha: null,
              exists: fs.existsSync(path.resolve(projectRoot, file)),
              path: file,
            })),
          },
        ];
      })
    ),
    helper_options: { run_tests: false },
    mode: 'beads',
    mode_effective: 'beads',
    parsed_trd_json: { ok: true, trd },
    prd_path: relativePrd,
    prd_requirements: Object.keys(requirements).length > 0 ? requirements : null,
    trd_path: trdPath,
    trd_slug: slug,
  });
  const byReq = new Map(
    (Array.isArray(chain.chain) ? chain.chain : []).map(link => [link.req_id, link])
  );

  const gaps = [];
  const rows = [];
  for (const [req, priority] of priorities) {
    const link = byReq.get(req);
    const tasks = link && Array.isArray(link.impl_task_ids) ? link.impl_task_ids : [];
    const satisfied = tasks.some(id => {
      const bead = beadByTask.get(id);
      return bead !== undefined && isClosed(bead);
    });
    const binding = priority !== null && BINDING_PRIORITIES.includes(priority);
    if (binding && !satisfied) {
      gaps.push({
        class: 'REQ-UNSATISFIED',
        detail: MESSAGES.reqUnsatisfied(req, priority),
        priority,
        req,
      });
    }
    rows.push({
      priority,
      req,
      status: binding ? (satisfied ? 'SATISFIED' : 'UNSATISFIED') : 'informational only',
      tasks,
    });
  }
  return { gaps, rows };
}

/**
 * Step 4: the whole suite, run again now.
 *
 * A phase gate's recorded pass proves the suite passed when that phase ended, not that it still
 * passes after every later phase, so the suite is run once more here. A runner that cannot
 * answer is a gap for the same reason a failing suite is: neither one is evidence that the
 * tests pass.
 *
 * @param {object} call the dispatcher's call object
 * @returns {{gap: object|null, output: string|null, result: object|null}} result is a toolchain
 *   gate to be returned unchanged
 */
function suiteGap(call) {
  // The npm adapter interpolates both declared arguments, so the empty `args` must be supplied
  // rather than left out.
  const answer = classify(
    callCapability(call, 'package-runner.run-script', { args: '', script: 'test' }),
    'package-runner.run-script'
  );
  if (answer.kind === 'gate') return { gap: null, output: null, result: answer.result };

  const raw =
    answer.kind === 'ok'
      ? String((answer.data && answer.data.output) || '')
      : String(answer.message || '');
  const output = redact(raw.slice(-MAX_SUITE_OUTPUT));
  if (answer.kind === 'ok') return { gap: null, output, result: null };

  const failures = [...output.matchAll(FAIL_LINE_RE)].map(match => `FAIL ${match[1]}`);
  const detail = failures.length > 0 ? failures.join(', ') : output.trim() || 'see full output above';
  return { gap: { class: 'TEST-SUITE-FAILURE', detail }, output, result: null };
}

/**
 * Step 5: the report, in the layout `completion-verification/SKILL.md:218` prints.
 *
 * @param {{date: string, gaps: object[], inventory: object[], requirements: object[]|null,
 *   slug: string, suite: {output: string|null, passed: boolean|null}, trdPath: string}} input
 * @returns {string} the report's whole text
 */
function renderReport({ date, gaps, inventory, requirements, slug, suite, trdPath }) {
  const lines = [
    `# Completion Verification Report: ${slug}`,
    '',
    `- TRD file: ${trdPath}`,
    `- TRD slug: ${slug}`,
    `- Date: ${date}`,
    '- Tracking mode: beads',
    '',
    '## Task Inventory',
    '',
    '| ID | Description | Status | Evidence |',
    '|----|--------------|--------|----------|',
  ];
  for (const row of inventory) {
    const status = row.closed ? 'closed' : 'open';
    const evidence = row.bead
      ? `tracker.list ${row.bead} work item \u2192 ${status}`
      : 'no work item found for this task';
    lines.push(`| ${row.id} | ${row.description} | ${status} | ${evidence} |`);
  }

  if (requirements !== null) {
    lines.push('', '## Requirement Coverage', '');
    lines.push('| REQ-NNN | Priority | Satisfying Task(s) | Status |');
    lines.push('|---------|----------|---------------------|--------|');
    for (const row of requirements) {
      const tasks = row.tasks.length > 0 ? row.tasks.join(', ') : '(none)';
      lines.push(`| ${row.req} | ${row.priority || '\u2014'} | ${tasks} | ${row.status} |`);
    }
  }

  lines.push('', '## Gap Summary', '', `Total gaps: ${gaps.length}`);
  for (const gapClass of GAP_CLASSES) {
    const members = gaps.filter(gap => gap.class === gapClass);
    lines.push('', `### ${gapClass} (${members.length})`);
    for (const gap of members) {
      lines.push(
        gapClass === 'REQ-PRIORITY-UNPARSED'
          ? `- ${gap.detail} (no REQ priority classifiable)`
          : `- ${gap.detail}`
      );
    }
  }

  lines.push('', '## Test Suite Result', '');
  if (suite.passed === null) {
    lines.push('NOT RUN \u2014 `package-runner.run-script script=test` \u2014 the task inventory could not be trusted');
  } else {
    const summary = String(suite.output || '').trim().split('\n').slice(-1)[0] || '(no output)';
    lines.push(
      `${suite.passed ? 'PASS' : 'FAIL'} \u2014 \`package-runner.run-script script=test\` \u2014 ${summary}`
    );
  }

  lines.push('', '---', '');
  lines.push(gaps.length === 0 ? MESSAGES.VERDICT_COMPLETE : MESSAGES.verdictIncomplete(gaps.length));
  return `${lines.join('\n')}\n`;
}

/**
 * Write the report where the skill writes it, replacing today's report rather than adding a
 * second one. The rename is what makes a reader of the path see either the old report or the new
 * one, never half of either.
 *
 * @param {{projectRoot: string, reportPath: string, text: string}} input
 * @returns {void}
 */
function writeReport({ projectRoot, reportPath, text }) {
  const resolved = resolveCallerPath(projectRoot, reportPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temp = `${resolved}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, resolved);
}

/**
 * The whole recipe, steps 1 to 6.
 *
 * @param {object} call the dispatcher's call object
 * @param {{beads: object[], parsed: object|null, slug: string, text: string, trdPath: string}} input
 * @returns {object} the verification report, or a tagged engine result
 */
function runVerification(call, { beads, parsed, slug, text, trdPath }) {
  const gaps = parseGaps({ parsed: parsed, text });
  const trusted = gaps.length === 0;
  const trd = parsed || {};
  const tasksById = trusted && trd.tasksById ? trd.tasksById : {};

  const beadByTask = new Map();
  for (const bead of beads) {
    if (isTaskLevel(bead.kind) && bead.taskId && !beadByTask.has(bead.taskId)) {
      beadByTask.set(bead.taskId, bead);
    }
  }

  let checked = 0;
  let inventory = [];
  let requirements = null;
  const suite = { output: null, passed: null };
  if (trusted) {
    const step2 = inventoryGaps({ beadByTask, tasksById });
    checked = step2.checked;
    inventory = step2.rows;
    gaps.push(...step2.gaps);

    const step3 = requirementGaps({
      beadByTask,
      projectRoot: call.projectRoot,
      slug,
      tasksById,
      trd,
      trdPath,
    });
    requirements = step3.rows;
    gaps.push(...step3.gaps);

    const step4 = suiteGap(call);
    if (step4.result) return step4.result;
    suite.output = step4.output;
    suite.passed = step4.gap === null;
    if (step4.gap) gaps.push(step4.gap);
  }

  gaps.sort((a, b) => GAP_CLASSES.indexOf(a.class) - GAP_CLASSES.indexOf(b.class));

  const date = new Date(call.now * 1000).toISOString().slice(0, 10);
  const reportPath = path.posix.join('docs', 'reports', `${slug}-completion-${date}.md`);
  writeReport({
    projectRoot: call.projectRoot,
    reportPath,
    text: redact(
      renderReport({ date, gaps, inventory, requirements, slug, suite, trdPath })
    ),
  });

  const verdict = gaps.length === 0 ? 'COMPLETE' : 'INCOMPLETE';
  return {
    MESSAGE:
      verdict === 'COMPLETE'
        ? MESSAGES.completionPassed(reportPath)
        : MESSAGES.completionFailed(gaps.length, reportPath),
    SUITE_OUTPUT: suite.output,
    TASKS_CHECKED: checked,
    TRACKING_MODE: 'beads',
    gapCount: gaps.length,
    gaps,
    reportPath,
    verdict,
  };
}

module.exports = {
  inventoryGaps,
  parseGaps,
  renderReport,
  requirementGaps,
  runVerification,
  suiteGap,
};
