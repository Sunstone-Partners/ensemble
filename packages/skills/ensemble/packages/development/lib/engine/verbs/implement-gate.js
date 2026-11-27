'use strict';

/**
 * TRD-013 (TRD-2026-d571763f): `ensemble implement gate <trd>` -- the per-phase quality gate of
 * `skills/ensemble-implement-trd-tasks/references/phase-4-quality-gate.md`.
 *
 * A phase is ready for its gate when every task bead in it is closed. The gate then runs that
 * phase's tests, records the result on the phase's story BEFORE it changes anything, and -- in
 * single-PR mode -- closes the story with a reason and the sha the tests ran against, then makes
 * a checkpoint commit carrying only this TRD's beads. In stacked mode the story stays open,
 * because a PR and its review still stand between this phase and done.
 *
 * The verb owns no state of its own (Constitution Rule 4): the tracker says which beads are
 * closed, `trd-cli phase-status` says which phases that completes, `trd-cli pr-plan` says what a
 * passing phase means, and the policy says whether a failing gate blocks. Every gate --
 * preflight, confirmation, allowlist -- belongs to `toolchain-cli` and is returned unchanged
 * rather than degraded around (Rule 5).
 *
 * Whether a failing gate stops the run is policy, not code: `strategy_gate` maps each strategy
 * to `blocking` or `informational`, so a repository decides what a red suite means for a
 * characterization build without editing this file (Rule 8).
 */

const path = require('path');

const MESSAGES = require('../messages');
const { runTrd } = require('../cli-json');
const { STRATEGIES, loadPolicy } = require('../policy');
const { isResult, needsChoice, refused, unavailable } = require('../result');
const { currentBranch } = require('../git');
const { resolveInteractivity } = require('../interactivity');
const { callCapability, classify, isClosed, isTaskLevel, readComments, readIssues, scopeBeads } =
  require('../tracker');
const { readFrontmatter, readParsedTrd, requireTrd } = require('../trd-source');
const { gateAction, savedPlan } = require('../pr-plan');
const { strategyFor } = require('../strategy');
const {
  assertIndexClean,
  closeBead,
  composeReason,
  flushTracker,
  headSha,
  stageAndCommit,
} = require('../closure');

/**
 * The strategies whose failing gate pauses for the operator, verbatim from
 * `phase-4-quality-gate.md:9` ("Not passed under tdd/refactor/bug-fix: print the failures and
 * pause for the user (fix / skip / abort)").
 */
const CHOICE_STRATEGIES = ['tdd', 'refactor', 'bug-fix'];

/** What `--on-failure` may say. */
const ON_FAILURE = ['fix', 'skip', 'abort'];

/** How many failures a refusal names before it stops listing them. */
const MAX_NAMED_FAILURES = 20;

/**
 * A path a test-runner argument may carry: relative, no parent escape, no shell-significant
 * character. The runner is handed this verbatim, so a path it cannot represent stops here.
 */
const TEST_PATH_RE = /^(?!-)[A-Za-z0-9._@+/-]+$/;

/**
 * The test files of one phase: the Target Files its TEST tasks declare, sorted and joined.
 *
 * `.` when the phase declares none -- the runner's own default, which is the whole suite. That
 * is deliberately wider than the phase, never narrower: a gate that ran no tests because the TRD
 * named no file would pass without checking anything (Constitution Rule 7).
 *
 * @param {object} parsed the parsed TRD
 * @param {string[]} taskIds the phase's task ids
 * @returns {string|object} the `file` argument, or a tagged engine result
 */
function phaseTestFiles(parsed, taskIds) {
  const byId = parsed.tasksById || {};
  const files = new Set();
  for (const taskId of taskIds) {
    const task = byId[taskId];
    if (!task || task.isTest !== true) continue;
    for (const file of task.targetFiles || []) files.add(String(file).trim());
  }
  const sorted = [...files].filter(file => file.length > 0).sort();
  for (const file of sorted) {
    if (!TEST_PATH_RE.test(file) || file.split('/').includes('..')) {
      return refused('TEST_PATH_INVALID', `Target File '${file}' is not a usable relative path`);
    }
  }
  return sorted.length > 0 ? sorted.join(' ') : '.';
}

/**
 * Run one phase's tests.
 *
 * A failing SUITE is a result, not an error: the shipped runners exit 1 for it and the adapter
 * declares that exit tolerated. A runner that is absent, crashes, or answers a shape the
 * category contract does not allow is a different thing entirely, and each stops the run with
 * its own code -- none of them may read as a pass.
 *
 * @param {object} call the dispatcher's call object
 * @param {{file: string, framework: string|undefined}} input
 * @returns {{failed: number, failures: object[], passed: number, skipped: number|null,
 *   success: boolean, total: number}|object}
 */
function runPhaseTests(call, { file, framework }) {
  const args = { file };
  // No detection: the runner's own adapter selects the framework. Guessing one here would make
  // the gate's command differ from the command the maintainer runs by hand.
  if (typeof framework === 'string' && framework.length > 0) args.framework = framework;

  const answer = classify(callCapability(call, 'test-runner.run', args), 'test-runner.run');
  if (answer.kind === 'gate') return answer.result;
  if (answer.kind === 'unavailable') {
    return unavailable('TEST_RUNNER_UNAVAILABLE', MESSAGES.testRunnerUnavailable(answer.message));
  }
  if (answer.kind !== 'ok') {
    return refused('TEST_RUN_FAILED', MESSAGES.testRunFailed(answer.message));
  }

  const data = answer.data && typeof answer.data === 'object' ? answer.data : {};
  const count = value => (Number.isInteger(value) && value >= 0 ? value : null);
  const passed = count(data.passed);
  const failed = count(data.failed);
  const total = count(data.total);
  if (typeof data.success !== 'boolean' || passed === null || failed === null || total === null) {
    return refused('TEST_RESULT_INVALID', MESSAGES.TEST_RESULT_INVALID);
  }

  return {
    failed,
    failures: (Array.isArray(data.failures) ? data.failures : []).map(entry => ({
      file: entry && entry.file != null ? String(entry.file) : '',
      line: entry && entry.line != null ? Number(entry.line) : null,
      test: entry ? String(entry.test || entry.nodeid || entry.name || entry.title || '') : '',
    })),
    passed,
    skipped: count(data.skipped),
    success: data.success,
    total,
  };
}

/**
 * Record the gate's result on the phase's story, once.
 *
 * The comment goes on BEFORE anything is closed or committed, so a run that stops later still
 * leaves the evidence of what the tests did. Re-running the same phase must not add a second
 * copy of the same sentence, so the existing comments are read first; a tracker that cannot
 * answer that read is warned about and the comment is recorded anyway -- losing the evidence
 * would be worse than a duplicate.
 *
 * @param {object} call the dispatcher's call object
 * @param {{story: string, text: string, warnings: string[]}} input
 * @returns {'recorded'|'duplicate'|object}
 */
function recordResult(call, { story, text, warnings }) {
  const existing = readComments(call, story);
  if (existing && existing.kind === 'gate') return existing.result;
  if (existing && (existing.kind || existing.status)) {
    warnings.push(
      MESSAGES.unavailableWarning(
        'tracker.comments',
        existing.message || 'the recorded comments could not be read',
        'the gate result was recorded without checking for an existing copy'
      )
    );
  } else if (existing.texts.includes(text)) {
    return 'duplicate';
  }

  const added = classify(
    callCapability(call, 'tracker.comment', { id: story, text }),
    'tracker.comment'
  );
  if (added.kind === 'gate') return added.result;
  if (added.kind === 'unavailable') {
    return unavailable('COMMENT_FAILED', MESSAGES.commentFailed(story, added.message));
  }
  if (added.kind !== 'ok') {
    return refused('COMMENT_FAILED', MESSAGES.commentFailed(story, added.message));
  }
  return 'recorded';
}

/**
 * The choice a failing gate offers an interactive operator (`phase-4-quality-gate.md:9`).
 * @returns {object} a tagged `NEEDS_CHOICE` result
 */
function gateFailureChoice() {
  return needsChoice({
    flag: '--on-failure',
    id: 'gate_failure',
    options: [
      { args: ['--on-failure', 'fix'], label: 'Fix the failing tests first', value: 'fix' },
      { args: ['--on-failure', 'skip'], label: 'Record the failure and continue', value: 'skip' },
      { args: ['--on-failure', 'abort'], label: 'Abort the gate', value: 'abort' },
    ],
    question: 'The quality gate failed. What should happen?',
  });
}

/**
 * How the run answers a failing gate.
 *
 * `--on-failure` is honoured only in an interactive run, because it is the answer to a question
 * only an interactive run asks. A non-interactive run that could pass `--on-failure skip` would
 * let an unattended build close a phase over a red suite, which is the one thing the pause
 * exists to prevent.
 *
 * @param {{interactive: boolean, onFailure: string|undefined, strategy: string}} input
 * @returns {'refuse'|'abort'|'skip'|'choice'}
 */
function failureDecision({ interactive, onFailure, strategy }) {
  if (!interactive) return 'refuse';
  if (!CHOICE_STRATEGIES.includes(strategy)) return 'refuse';
  if (onFailure === 'abort') return 'abort';
  if (onFailure === 'skip') return 'skip';
  if (onFailure === 'fix') return 'refuse';
  return 'choice';
}

/**
 * The failures a refusal names, as `file:line test`.
 * @param {object[]} failures
 * @returns {string[]}
 */
function namedFailures(failures) {
  return failures.slice(0, MAX_NAMED_FAILURES).map(entry => {
    const where = entry.line === null ? entry.file : `${entry.file}:${entry.line}`;
    return entry.test ? `${where} ${entry.test}` : where;
  });
}

/**
 * Close the phase's story and make its checkpoint commit.
 *
 * The order is the reference's (`phase-4-quality-gate.md:10`): refuse on a dirty index first,
 * resolve HEAD, compose and check the reason, close, flush, stage, commit. The index check comes
 * before the close on purpose -- a refusal that arrives after the story is already closed cannot
 * be re-run cleanly.
 *
 * @param {object} call the dispatcher's call object
 * @param {{commitMessage: string, policy: object, reasonText: string, slug: string,
 *   story: string, warnings: string[]}} input
 * @returns {{closed: boolean, commit: object, fallback: boolean}|object}
 */
function closePhase(call, { commitMessage, policy, reasonText, slug, story, warnings }) {
  const clean = assertIndexClean(call);
  if (clean !== null) return clean;

  const sha = headSha(call);
  if (isResult(sha)) return sha;
  if (sha && sha.kind === 'gate') return sha.result;
  if (sha && sha.kind) return unavailable('HEAD_UNRESOLVED', MESSAGES.HEAD_UNRESOLVED);

  const reason = composeReason(story, reasonText, policy.closure_reason_min_length);
  if (isResult(reason)) return reason;

  const closed = closeBead(call, { commit: sha, id: story, reason });
  if (isResult(closed)) return closed;
  if (closed.kind === 'gate') return closed.result;
  if (closed.fallback) warnings.push(MESSAGES.closeWithReasonFallback(story));

  const flushed = flushTracker(call);
  if (flushed !== null) warnings.push(flushed);

  const commit = stageAndCommit(call, { message: commitMessage, slug });
  if (isResult(commit)) return commit;
  if (commit.kind === 'gate') return commit.result;
  if (commit.committed === false) {
    warnings.push(`no checkpoint commit was made: ${commit.reason}`);
  }

  return { closed: true, commit, fallback: closed.fallback };
}

/**
 * Which phases are waiting for a gate, and which are not.
 *
 * @param {{beads: object[], parsed: object, phases: object[], prFormat: boolean, slug: string}} input
 * @returns {{candidates: object[], skipped: object[]}|object}
 */
function selectPhases({ beads, parsed, phases, prFormat, slug }) {
  const storyByPhase = new Map();
  for (const bead of beads) {
    if (bead.kind !== 'story') continue;
    const match = /:(?:phase|pr):(\d+)\]/.exec(bead.prefix || '');
    if (match && !storyByPhase.has(Number(match[1]))) storyByPhase.set(Number(match[1]), bead);
  }

  const candidates = [];
  const skipped = [];
  for (const phase of phases) {
    if (phase.complete !== true) {
      skipped.push({ phase: phase.n, reason: 'incomplete' });
      continue;
    }
    const story = storyByPhase.get(phase.n);
    if (!story) {
      return refused(
        'STORY_NOT_FOUND',
        MESSAGES.storyNotFound(phase.n, slug, prFormat ? 'pr' : 'phase')
      );
    }
    if (isClosed(story)) {
      skipped.push({ phase: phase.n, reason: 'closed' });
      continue;
    }
    candidates.push({
      phase: phase.n,
      story,
      taskIds: (parsed.phases || []).find(p => Number(p.n) === phase.n)?.taskIds || [],
    });
  }
  return { candidates, skipped };
}

/**
 * Which phases `trd-cli phase-status` reports complete, given the closed task ids.
 *
 * A failure to read it is not "every phase is complete": that would gate phases nobody finished.
 * It is "no phase is complete", with a warning, which is the same conservative reading the
 * reference takes ("On failure treat the phase as not complete").
 *
 * @param {object} call the dispatcher's call object
 * @param {{closedIds: string[], trdPath: string, warnings: string[]}} input
 * @returns {{phases: object[], prFormat: boolean}}
 */
function readPhaseStatus(call, { closedIds, trdPath, warnings }) {
  const argv = ['phase-status', trdPath];
  if (closedIds.length > 0) argv.push('--closed', closedIds.join(','));
  const result = runTrd(call, argv);
  if (!result.json || result.json.ok !== true) {
    const detail =
      (result.json && typeof result.json.error === 'string' && result.json.error) ||
      `exit ${result.exitCode}`;
    warnings.push(`trd-cli phase-status failed (${detail}); no phase is treated as complete`);
    return { phases: [], prFormat: false };
  }
  return {
    phases: Array.isArray(result.json.phases) ? result.json.phases : [],
    prFormat: result.json.prFormat === true,
  };
}

/**
 * Run one phase's gate.
 *
 * @param {object} call the dispatcher's call object
 * @param {object} context everything the phase needs, resolved once by the handler
 * @returns {{gate: object, next: string|null}|object}
 */
function gatePhase(call, context) {
  const { candidate, interactive, parsed, plan, policy, slug, strategy, warnings } = context;
  const { phase, story, taskIds } = candidate;

  const action = gateAction(plan, phase);
  if (!action || typeof action.createPr !== 'boolean') {
    return refused('GATE_ACTION_MISSING', MESSAGES.gateActionMissing(phase));
  }

  const file = phaseTestFiles(parsed, taskIds);
  if (isResult(file)) return file;

  const tests = runPhaseTests(call, { file, framework: call.input.framework });
  if (isResult(tests)) return tests;

  // `informational` is the policy's answer for this strategy, not a property of the run: the
  // tests still failed, and the comment below still says FAIL.
  const informational = policy.strategy_gate[strategy] === 'informational';
  const gatePassed = tests.success || informational;

  const comment = recordResult(call, {
    story: story.id,
    text: MESSAGES.qualityGateComment(tests.success, tests.passed, tests.total, strategy),
    warnings,
  });
  if (isResult(comment)) return comment;

  const base = {
    closed: false,
    comment,
    commit: null,
    failed: tests.failed,
    failures: tests.failures,
    gatePassed,
    passed: tests.passed,
    phase,
    skipped: false,
    story: story.id,
    strategy,
    success: tests.success,
    total: tests.total,
  };

  let skippedByOperator = false;
  if (!gatePassed) {
    const decision = failureDecision({
      interactive,
      onFailure: call.input['on-failure'],
      strategy,
    });
    if (decision === 'choice') return gateFailureChoice();
    if (decision === 'abort') return refused('GATE_ABORTED', MESSAGES.gateAborted(phase));
    if (decision === 'refuse') {
      const hint =
        !interactive && CHOICE_STRATEGIES.includes(strategy) ? MESSAGES.ON_FAILURE_HINT : '';
      return refused(
        'TESTS_FAILED',
        `${MESSAGES.testsFailed(phase, {
          failed: tests.failed,
          failures: namedFailures(tests.failures),
          strategy,
          total: tests.total,
        })}${hint}`,
        { failed: tests.failed, failures: tests.failures, passed: tests.passed, phase, total: tests.total }
      );
    }
    skippedByOperator = true;
  }

  if (action.createPr === true) {
    // Stacked: a PR and its review still stand between this phase and done, so the story stays
    // open and the next verb has something to close.
    return {
      gate: { ...base, skipped: skippedByOperator },
      next: MESSAGES.stackedNext(story.id, String(action.branch || '')),
    };
  }

  const beadPrefix = `${slug} phase`;
  const reasonText = skippedByOperator
    ? MESSAGES.closureReasonSkipped(phase, { failed: tests.failed, slug, total: tests.total })
    : tests.success
      ? MESSAGES.closureReasonPassed(phase, {
          passed: tests.passed,
          slug,
          strategy,
          total: tests.total,
        })
      : MESSAGES.closureReasonInformational(phase, {
          failed: tests.failed,
          slug,
          strategy,
          total: tests.total,
        });
  const commitMessage = skippedByOperator
    ? MESSAGES.checkpointCommitSkipped(beadPrefix, phase, tests.passed, tests.total)
    : tests.success
      ? MESSAGES.checkpointCommit(beadPrefix, phase, tests.passed, tests.total)
      : MESSAGES.checkpointCommitInformational(beadPrefix, phase, tests.passed, tests.total);

  const closed = closePhase(call, {
    commitMessage,
    policy,
    reasonText,
    slug,
    story: story.id,
    warnings,
  });
  if (isResult(closed)) return closed;

  return {
    gate: { ...base, closed: true, commit: closed.commit, skipped: skippedByOperator },
    next: null,
  };
}

/**
 * @param {object} call the dispatcher's call object
 * @returns {object} the gate report, or a tagged engine result
 */
function handler(call) {
  const trd = requireTrd(call);
  if (isResult(trd)) return trd;
  const trdPath = trd.path;

  const { interactive } = resolveInteractivity({ env: call.env, globals: call.globals });
  const policy = loadPolicy({ projectRoot: call.projectRoot }).values;
  const warnings = [];

  const parsed = readParsedTrd(call, trdPath);
  if (isResult(parsed)) return parsed;
  const slug = String(parsed.slug || '');

  const listed = readIssues(call, { all: true });
  if (isResult(listed)) return listed;
  const beads = scopeBeads(listed.issues, slug);
  if (beads.length === 0) {
    return refused('NOT_SCAFFOLDED', MESSAGES.gateNotScaffolded(slug));
  }

  // The tracker says which work is done; the task id in each bead's title is how a bead maps
  // back to the TRD's own task list.
  const closedIds = beads
    .filter(bead => isTaskLevel(bead.kind) && isClosed(bead) && bead.taskId)
    .map(bead => bead.taskId);

  const status = readPhaseStatus(call, { closedIds, trdPath, warnings });
  const selected = selectPhases({
    beads,
    parsed,
    phases: status.phases,
    prFormat: status.prFormat,
    slug,
  });
  if (isResult(selected)) return selected;

  const plan = savedPlan(call, trdPath);
  if (isResult(plan)) return plan;

  const strategy = strategyFor(call, {
    frontmatter: readFrontmatter(path.resolve(call.projectRoot, trdPath)).frontmatter,
    parsed,
    policy,
    strategyArgument: call.input.strategy,
    warnings,
  });

  const branch = currentBranch(call);
  if (isResult(branch)) return branch;

  const GATES = [];
  let NEXT = null;
  for (const candidate of selected.candidates.sort((a, b) => a.phase - b.phase)) {
    const action = gateAction(plan, candidate.phase);
    if (action && typeof action.branch === 'string' && action.branch.length > 0) {
      if (action.branch !== branch) {
        // The gate reports the difference and runs where it is: switching branches under a
        // maintainer mid-run is a side effect nobody asked this verb for.
        warnings.push(
          `the PR plan puts phase ${candidate.phase} on branch '${action.branch}', but this run is on '${branch}'`
        );
      }
    }

    const result = gatePhase(call, {
      candidate,
      interactive,
      parsed,
      plan,
      policy,
      slug,
      strategy: strategy.strategy,
      warnings,
    });
    if (isResult(result)) return result;
    GATES.push(result.gate);
    if (result.next !== null) NEXT = result.next;
  }

  return {
    BRANCH: branch,
    GATES,
    MODE: plan.stacked ? 'stacked' : 'single-pr',
    NEXT: GATES.length === 0 ? MESSAGES.NO_GATE_CANDIDATE : NEXT,
    PHASES_SKIPPED: selected.skipped,
    STRATEGY: strategy.strategy,
    STRATEGY_SOURCE: strategy.source,
    TRD_FILE_PATH: trdPath,
    TRD_SLUG: slug,
    WARNINGS: warnings,
  };
}

const spec = {
  exitCodes: [0, 1, 2, 4, 5],
  group: 'implement',
  handler,
  inputSchema: {
    additionalProperties: false,
    properties: {
      framework: { enum: ['jest', 'pytest', 'exunit', 'xunit', 'rspec'], type: 'string' },
      'on-failure': { enum: [...ON_FAILURE], type: 'string' },
      strategy: { enum: [...STRATEGIES], type: 'string' },
      trd: { type: 'string', 'x-operand': true },
    },
    type: 'object',
  },
  name: 'gate',
  outputSchema: {
    additionalProperties: false,
    properties: {
      BRANCH: { type: 'string' },
      CHOICE: {
        additionalProperties: false,
        properties: {
          flag: { type: ['string', 'null'] },
          id: { type: 'string' },
          options: {
            items: {
              additionalProperties: false,
              properties: {
                args: { items: { type: 'string' }, type: 'array' },
                label: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['args', 'label', 'value'],
              type: 'object',
            },
            type: 'array',
          },
          question: { type: 'string' },
        },
        required: ['flag', 'id', 'options', 'question'],
        type: 'object',
      },
      GATES: {
        items: {
          additionalProperties: false,
          properties: {
            closed: { type: 'boolean' },
            comment: { enum: ['recorded', 'duplicate'], type: 'string' },
            commit: {
              oneOf: [
                {
                  additionalProperties: false,
                  properties: {
                    committed: { type: 'boolean' },
                    reason: { type: ['string', 'null'] },
                    sha: { type: ['string', 'null'] },
                  },
                  required: ['committed', 'reason', 'sha'],
                  type: 'object',
                },
                { type: 'null' },
              ],
            },
            failed: { type: 'integer' },
            failures: { type: 'array' },
            gatePassed: { type: 'boolean' },
            passed: { type: 'integer' },
            phase: { type: 'integer' },
            skipped: { type: 'boolean' },
            story: { type: 'string' },
            strategy: { type: 'string' },
            success: { type: 'boolean' },
            total: { type: 'integer' },
          },
          required: [
            'closed',
            'comment',
            'commit',
            'failed',
            'failures',
            'gatePassed',
            'passed',
            'phase',
            'skipped',
            'story',
            'strategy',
            'success',
            'total',
          ],
          type: 'object',
        },
        type: 'array',
      },
      MODE: { enum: ['single-pr', 'stacked'], type: 'string' },
      NEXT: { type: ['string', 'null'] },
      PHASES_SKIPPED: {
        items: {
          additionalProperties: false,
          properties: {
            phase: { type: 'integer' },
            reason: { enum: ['closed', 'incomplete'], type: 'string' },
          },
          required: ['phase', 'reason'],
          type: 'object',
        },
        type: 'array',
      },
      STRATEGY: { enum: [...STRATEGIES], type: 'string' },
      STRATEGY_SOURCE: { type: 'string' },
      TRD_FILE_PATH: { type: 'string' },
      TRD_SLUG: { type: 'string' },
      WARNINGS: { items: { type: 'string' }, type: 'array' },
    },
    // A `NEEDS_CHOICE` answer carries only `CHOICE`, so the report's own keys cannot be
    // required for every status this verb can end in.
    required: [],
    type: 'object',
  },
  // The gate comments on a story, closes it and commits: every one of those is a write, and the
  // declaration must say so for the side-effect gates to apply (Constitution Rule 5).
  policyKeys: [
    'closure_reason_min_length',
    'constitution_methodology',
    'default_strategy',
    'strategy_detection',
    'strategy_gate',
  ],
  sideEffect: 'write',
  summary: "run the per-phase quality gate and record its result on the phase's story",
};

module.exports = { spec };
