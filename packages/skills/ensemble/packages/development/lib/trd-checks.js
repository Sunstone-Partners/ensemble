'use strict';

/**
 * trd-checks.js — deterministic TRD/PRD structural, traceability, and status
 * checks. Pure functions over `parseTRD()` output (and optionally the
 * `extractPrdContext()` map). No I/O, no shell. Consumed by the `validate`,
 * `analyze`, and `req-status` subcommands of trd-cli.js.
 *
 * Task grammar (the ONLY thing the parser recognizes): a checkbox line
 *   `- [ ] **TRD-NNN**: Title (Nh) [satisfies REQ-NNN]`
 * under `## Master Task List`, grouped by `### PR N` / `### Phase N` /
 * `### Sprint N` headings. Heading-style task ids (`### TRD-001`) are NOT tasks.
 */

const INFRA_TOKENS = new Set(['INFRA', 'ARCH']);

/** Real (checkbox) tasks only: excludes parser-synthesized AC/XC tasks. */
function realTasks(parsed) {
  return Object.values(parsed.tasksById || {}).filter((t) => !t.syntheticKind);
}

/** Title text of a task line with checkbox, id, annotations and estimate removed. */
function taskTitle(task) {
  const firstLine = String(task.rawMarkdown || '').split('\n')[0];
  return firstLine
    .replace(/^\s*- \[[ xX]\]\s+\*\*TRD-[A-Za-z0-9-]+\*\*\s*[-—–:]?\s*/, '')
    .replace(/\[(?:satisfies|verifies|depends:?)[^\]]*\]/gi, '')
    .replace(/\(\d+(?:\.\d+)?h\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Checkbox state from the task line: true when `- [x]`. */
function isChecked(task) {
  const firstLine = String(task.rawMarkdown || '').split('\n')[0];
  return /^\s*- \[[xX]\]/.test(firstLine);
}

/** Cross-TRD dependency refs look like `slug#TRD-001`; they cannot be resolved locally. */
function isExternalRef(id) {
  return String(id).includes('#');
}

/**
 * Find dependency cycles among local tasks. Returns an array of cycles, each
 * an array of task ids with the first id repeated at the end.
 */
function findCycles(tasksById) {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = {};
  const cycles = [];
  const stack = [];
  const seenKeys = new Set();

  function visit(id) {
    color[id] = GREY;
    stack.push(id);
    for (const dep of (tasksById[id].dependsOn || [])) {
      if (!Object.prototype.hasOwnProperty.call(tasksById, dep)) continue;
      if (color[dep] === GREY) {
        const cycle = stack.slice(stack.indexOf(dep)).concat(dep);
        const key = [...cycle.slice(0, -1)].sort().join('|');
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          cycles.push(cycle);
        }
      } else if (!color[dep]) {
        visit(dep);
      }
    }
    stack.pop();
    color[id] = BLACK;
  }

  for (const id of Object.keys(tasksById)) {
    if (!color[id]) visit(id);
  }
  return cycles;
}

/**
 * Longest dependency chain per task (1 = no dependencies). Tasks that sit on
 * or behind a cycle get depth null.
 */
function dependencyDepths(tasksById, cycles) {
  const cyclic = new Set();
  for (const c of cycles) c.forEach((id) => cyclic.add(id));
  const memo = {};
  function depth(id, trail) {
    if (cyclic.has(id) || trail.has(id)) return null;
    if (id in memo) return memo[id];
    trail.add(id);
    let best = 1;
    for (const dep of (tasksById[id].dependsOn || [])) {
      if (!Object.prototype.hasOwnProperty.call(tasksById, dep)) continue;
      const d = depth(dep, trail);
      if (d === null) { best = null; break; }
      best = Math.max(best, d + 1);
    }
    trail.delete(id);
    memo[id] = best;
    return best;
  }
  const out = {};
  for (const id of Object.keys(tasksById)) out[id] = depth(id, new Set());
  return out;
}

/**
 * PRD<->TRD traceability findings. When `prdContext` has no requirements the
 * PRD-dependent checks are reported as skipped; the test-pair check only needs
 * TRD data and always runs.
 */
function traceabilityFindings(parsed, prdContext) {
  const tasks = realTasks(parsed);
  const reqs = (prdContext && prdContext.requirements) || {};
  const acs = (prdContext && prdContext.acs) || {};
  const reqIds = Object.keys(reqs);
  const hasPrd = reqIds.length > 0;

  const orphanAnnotations = [];
  const uncoveredRequirements = [];
  const invalidAcRefs = [];
  const missingTestPairs = [];

  if (hasPrd) {
    const covered = new Set();
    for (const t of tasks) {
      for (const r of t.satisfies) {
        if (INFRA_TOKENS.has(r)) continue;
        if (reqs[r]) covered.add(r);
        else orphanAnnotations.push({ task: t.id, req: r });
      }
    }
    for (const id of reqIds) if (!covered.has(id)) uncoveredRequirements.push(id);

    for (const t of tasks) {
      for (const ac of t.validatesAcs) {
        if (!acs[ac]) invalidAcRefs.push({ task: t.id, ac });
      }
    }
  }

  for (const t of tasks) {
    if (t.isTest) continue;
    const userFacing = t.satisfies.some((r) => !INFRA_TOKENS.has(r));
    if (userFacing && !parsed.tasksById[`${t.id}-TEST`]) missingTestPairs.push(t.id);
  }

  return {
    prdAvailable: hasPrd,
    orphanAnnotations,
    uncoveredRequirements,
    invalidAcRefs,
    missingTestPairs,
  };
}

/**
 * Structural + traceability validation.
 *
 * @param {object} parsed     parseTRD() output
 * @param {object} [prdContext] extractPrdContext() output (optional)
 * @returns {{ok:boolean, errors:Array, warnings:Array, passed:string[], skipped:string[], stats:object}}
 */
function validateTrd(parsed, prdContext) {
  const errors = [];
  const warnings = [];
  const passed = [];
  const skipped = [];
  const err = (code, message, extra) => errors.push({ code, message, ...extra });
  const warn = (code, message, extra) => warnings.push({ code, message, ...extra });
  const tally = (code, before) => {
    if (errors.length + warnings.length === before) passed.push(code);
  };
  const count = () => errors.length + warnings.length;

  const tasks = realTasks(parsed);
  const tasksById = parsed.tasksById || {};

  // Required sections / document shape.
  let before = count();
  if ((parsed.warnings || []).some((w) => /No "## Master Task List" heading/.test(w))) {
    err('MISSING_MASTER_TASK_LIST', 'Required section "## Master Task List" is missing');
  }
  if (!parsed.title) warn('MISSING_TITLE', 'Document has no H1 title');
  tally('required_sections', before);

  // Task presence and ids.
  before = count();
  if (tasks.length === 0) {
    err('NO_TASKS', 'No tasks parsed. Tasks must be checkbox lines: "- [ ] **TRD-001**: Title"');
  }
  for (const w of parsed.warnings || []) {
    const m = w.match(/^Duplicate task id: (.+)$/);
    if (m) err('DUPLICATE_TASK_ID', w, { task: m[1] });
  }
  for (const t of tasks) {
    if (!taskTitle(t)) err('MISSING_TASK_TITLE', `Task ${t.id} has no title text`, { task: t.id });
  }
  tally('tasks_parsed', before);

  // Dependencies resolve.
  before = count();
  const external = [];
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (isExternalRef(dep)) { external.push({ task: t.id, dep }); continue; }
      if (!Object.prototype.hasOwnProperty.call(tasksById, dep)) {
        err('UNRESOLVED_DEPENDENCY', `Task ${t.id} depends on ${dep}, which is not defined`, { task: t.id, dep });
      }
    }
  }
  tally('dependencies_resolve', before);

  // Cycles.
  before = count();
  const cycles = findCycles(tasksById);
  for (const c of cycles) err('DEPENDENCY_CYCLE', `Dependency cycle: ${c.join(' -> ')}`, { cycle: c });
  tally('no_dependency_cycles', before);

  // Acceptance criteria present.
  before = count();
  for (const t of tasks) {
    if (t.implementationAc.length === 0 && t.testAc.length === 0) {
      warn('MISSING_ACCEPTANCE_CRITERIA', `Task ${t.id} has no Implementation AC or Test AC checklist`, { task: t.id });
    }
  }
  tally('acceptance_criteria_present', before);

  // PR-format warnings from the parser (e.g. missing Shippable State).
  before = count();
  for (const w of parsed.warnings || []) {
    if (/missing a Shippable State/.test(w)) warn('MISSING_SHIPPABLE_STATE', w);
  }
  tally('shippable_state', before);

  // Traceability.
  const trace = traceabilityFindings(parsed, prdContext);
  before = count();
  for (const o of trace.orphanAnnotations) {
    err('ORPHANED_SATISFIES', `Task ${o.task} satisfies ${o.req}, which is not in the PRD`, o);
  }
  if (trace.prdAvailable) tally('orphaned_satisfies', before); else skipped.push('orphaned_satisfies');

  before = count();
  for (const id of trace.uncoveredRequirements) {
    warn('UNCOVERED_REQUIREMENT', `No TRD task satisfies ${id}`, { req: id });
  }
  if (trace.prdAvailable) tally('requirement_coverage', before); else skipped.push('requirement_coverage');

  before = count();
  for (const a of trace.invalidAcRefs) {
    warn('INVALID_AC_REFERENCE', `Task ${a.task} validates ${a.ac}, which is not in the PRD`, a);
  }
  if (trace.prdAvailable) tally('ac_references', before); else skipped.push('ac_references');

  before = count();
  for (const id of trace.missingTestPairs) {
    warn('MISSING_TEST_PAIR', `Task ${id} satisfies a requirement but ${id}-TEST is not defined`, { task: id });
  }
  tally('test_pairs', before);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    passed,
    skipped,
    stats: {
      tasks: tasks.length,
      implTasks: tasks.filter((t) => !t.isTest).length,
      testTasks: tasks.filter((t) => t.isTest).length,
      phases: (parsed.phases || []).length,
      externalDependencies: external.length,
      prdRequirements: trace.prdAvailable ? Object.keys(prdContext.requirements).length : null,
    },
  };
}

/** PRD structure facts used by `analyze` (needs raw PRD markdown). */
function prdStructure(prdMarkdown, prdContext) {
  const md = String(prdMarkdown || '');
  const acs = Object.values((prdContext && prdContext.acs) || {});
  return {
    requirements: Object.keys((prdContext && prdContext.requirements) || {}).length,
    acceptanceCriteria: acs.length,
    acsWithoutGivenWhenThen: acs.filter((a) => !(a.given && a.when && a.then)).map((a) => a.id),
    hasNonGoals: /^#{2,3}\s+(Non-Goals|Out of Scope|Exclusions)\b/im.test(md),
    hasConstraints: /^#{2,3}\s+(Constraints|Assumptions|Dependencies)\b/im.test(md),
  };
}

/**
 * Consistency / coverage statistics. Contradiction detection (semantic) is NOT
 * computed here; callers must review PRD vs TRD prose for that.
 */
function analyzeTrd(parsed, prdContext, prdMarkdown) {
  const validation = validateTrd(parsed, prdContext);
  const tasks = realTasks(parsed);
  const tasksById = parsed.tasksById || {};
  const cycles = findCycles(tasksById);
  const depths = dependencyDepths(tasksById, cycles);

  const phases = (parsed.phases || []).map((p) => {
    const inPhase = p.taskIds.map((id) => tasksById[id]).filter((t) => t && !t.syntheticKind);
    return {
      n: p.n,
      title: p.title,
      tasks: inPhase.length,
      implTasks: inPhase.filter((t) => !t.isTest).length,
      testTasks: inPhase.filter((t) => t.isTest).length,
      hours: inPhase.reduce((s, t) => s + (t.hourEstimate || 0), 0),
      missingEstimates: inPhase.filter((t) => t.hourEstimate == null).length,
    };
  });

  const depthValues = tasks.map((t) => depths[t.id]).filter((d) => d !== null);
  const maxDepth = depthValues.length ? Math.max(...depthValues) : 0;
  const criticalPathEnd = tasks.find((t) => depths[t.id] === maxDepth && maxDepth > 0);

  const trace = traceabilityFindings(parsed, prdContext);
  const untraced = tasks.filter((t) => !t.isTest && t.satisfies.length === 0).map((t) => t.id);
  const prd = prdContext && Object.keys(prdContext.requirements || {}).length > 0
    ? prdStructure(prdMarkdown, prdContext)
    : null;

  const prdWarnings = [];
  if (prd) {
    if (prd.acceptanceCriteria === 0) prdWarnings.push('PRD has no AC-NNN-M acceptance criteria');
    if (prd.acsWithoutGivenWhenThen.length) prdWarnings.push('Some PRD acceptance criteria do not follow Given/When/Then');
    if (!prd.hasNonGoals) prdWarnings.push('PRD has no Non-Goals / Out of Scope section');
    if (!prd.hasConstraints) prdWarnings.push('PRD has no Constraints / Assumptions / Dependencies section');
  }

  const errorCount = validation.errors.length;
  const warningCount = validation.warnings.length + prdWarnings.length;
  let verdict;
  if (errorCount > 0) verdict = 'NOT READY';
  else if (warningCount > 5) verdict = 'CAUTION';
  else if (warningCount > 0) verdict = 'MOSTLY READY';
  else verdict = 'READY';

  return {
    verdict,
    errorCount,
    warningCount,
    validation,
    prdWarnings,
    prd,
    phases,
    dependencies: {
      maxDepth,
      criticalPathEnd: criticalPathEnd ? criticalPathEnd.id : null,
      cycles,
    },
    estimates: {
      totalHours: tasks.reduce((s, t) => s + (t.hourEstimate || 0), 0),
      missing: tasks.filter((t) => t.hourEstimate == null).map((t) => t.id),
    },
    traceability: {
      prdAvailable: trace.prdAvailable,
      uncoveredRequirements: trace.uncoveredRequirements,
      orphanAnnotations: trace.orphanAnnotations,
      invalidAcRefs: trace.invalidAcRefs,
      missingTestPairs: trace.missingTestPairs,
      implTasksWithoutSatisfies: untraced,
    },
  };
}

const AC_ID = /^AC-\d+-\d+$/;

function commentText(c) {
  return typeof c === 'string' ? c : c && typeof c.text === 'string' ? c.text : '';
}

/** `ac-proven:AC-001-1,AC-001-2` (also tolerates ", " separators) -> ['AC-001-1', ...]. */
function acTokens(text) {
  const m = text.match(/ac-proven:\s*([A-Za-z0-9,\s-]+)/i);
  if (!m) return [];
  return m[1].split(/[\s,]+/).filter((x) => AC_ID.test(x));
}

/**
 * Normalize br comment dumps into evidence. Accepted shapes: a map
 * `{beadId: [text|{text}]}`, an array of `{beadId|id|issue_id, comments:[...]}`,
 * or the flat `br comment list --json` array of `{issue_id, text}`.
 * Tokens (same as the pre-2.0 command): bead comments carry
 * `status:closed ... verdict:passed|failed req-satisfied:REQ-N ac-proven:AC-N-M,..`;
 * epic comments carry `req-verified:REQ-N by:TRD-N-TEST qa:<agent> ac-proven:..`.
 * Latest verdict comment per task wins.
 *
 * @param {object|Array} comments
 * @param {Object<string,string>} [taskIdByBead] bead id -> TRD task id
 * @returns {{verdictByTask:Object<string,string>, verifiedReqs:string[], acsProvenByReq:Object<string,string[]>}}
 */
function evidenceFromComments(comments, taskIdByBead) {
  const toTask = taskIdByBead || {};
  const entries = []; // { owner, text }
  const push = (owner, list) => {
    for (const c of list || []) entries.push({ owner, text: commentText(c) });
  };
  if (Array.isArray(comments)) {
    for (const e of comments) {
      if (e && Array.isArray(e.comments)) push(e.beadId || e.id || e.issue_id, e.comments);
      else if (e) push(e.issue_id || e.beadId, [e]);
    }
  } else if (comments && typeof comments === 'object') {
    for (const [owner, list] of Object.entries(comments)) push(owner, Array.isArray(list) ? list : [list]);
  }
  const verdictByTask = {};
  const verified = new Set();
  const acs = {};
  const addAcs = (req, ids) => {
    if (!acs[req]) acs[req] = [];
    for (const id of ids) if (!acs[req].includes(id)) acs[req].push(id);
  };
  for (const { owner, text } of entries) {
    const lines = text.split('\n');
    for (const line of lines) {
      const task = toTask[owner] || owner;
      const verdict = line.match(/verdict:\s*(passed|failed)/i);
      if (verdict && /status:\s*closed/i.test(line)) verdictByTask[task] = verdict[1].toLowerCase();
      const ids = acTokens(line);
      const sat = line.match(/req-(?:satisfied|verified):\s*(REQ-\d+)/i);
      if (sat) {
        if (/req-verified:/i.test(line)) verified.add(sat[1].toUpperCase());
        addAcs(sat[1].toUpperCase(), ids);
      }
      const by = line.match(/\bby:\s*(TRD-[A-Za-z0-9-]+)/i);
      if (by && verdictByTask[by[1]] === undefined && sat && /req-verified:/i.test(line)) verdictByTask[by[1]] = 'passed';
    }
  }
  return { verdictByTask, verifiedReqs: [...verified].sort(), acsProvenByReq: acs };
}

function pct(done, total) {
  return total === 0 ? null : Math.round((done / total) * 1000) / 10;
}

/**
 * Checkbox completion rollups by phase plus per-requirement satisfaction.
 *
 * @param {object} parsed
 * @param {object} [opts]
 * @param {object} [opts.prdContext]
 * @param {Object<string,string>} [opts.beadStatusByTask] task id -> open|in_progress|closed
 * @param {string[]} [opts.verifiedReqs] REQ ids carrying a req-verified token (null = unknown)
 * @param {object} [opts.evidence] evidenceFromComments() result; when present a closed test
 *   task counts only with a PASSED verdict (evidence 'verdict-verified'), else 'closed-only'
 */
function requirementStatus(parsed, opts) {
  const o = opts || {};
  const tasks = realTasks(parsed);
  const tasksById = parsed.tasksById || {};
  const beadStatus = o.beadStatusByTask || {};
  const verified = Array.isArray(o.verifiedReqs) ? new Set(o.verifiedReqs) : null;
  const ev = o.evidence || null;
  const evidence = ev ? 'verdict-verified' : 'closed-only';

  const stateOf = (id) => {
    if (beadStatus[id]) return beadStatus[id];
    return isChecked(tasksById[id]) ? 'closed' : 'open';
  };

  const phases = (parsed.phases || []).map((p) => {
    const inPhase = p.taskIds.map((id) => tasksById[id]).filter((t) => t && !t.syntheticKind);
    const done = inPhase.filter((t) => isChecked(t)).length;
    return { n: p.n, title: p.title, total: inPhase.length, done, pct: pct(done, inPhase.length) };
  });
  const doneAll = tasks.filter((t) => isChecked(t)).length;

  const prdReqs = (o.prdContext && o.prdContext.requirements) || {};
  const reqIds = new Set(Object.keys(prdReqs));
  for (const t of tasks) for (const r of t.satisfies) if (/^REQ-\d+$/.test(r)) reqIds.add(r);

  const requirements = [...reqIds].sort().map((req) => {
    const testIds = new Set();
    for (const t of tasks) {
      if (!t.satisfies.includes(req)) continue;
      if (t.isTest) testIds.add(t.id);
      else if (tasksById[`${t.id}-TEST`]) testIds.add(`${t.id}-TEST`);
    }
    const tests = [...testIds].sort().map((id) => {
      const t = { id, state: stateOf(id) };
      if (ev) t.verdict = ev.verdictByTask[id] || null;
      return t;
    });
    let status;
    let note = null;
    if (tests.length === 0) status = 'NOT_PLANNED';
    else if (tests.every((x) => x.state === 'closed')) {
      const unproven = ev ? tests.filter((x) => x.verdict !== 'passed') : [];
      if (unproven.length > 0) {
        status = 'IN_PROGRESS';
        note = `closed without PASSED verdict: ${unproven.map((x) => `${x.id}${x.verdict ? ` (${x.verdict})` : ''}`).join(', ')}`;
      } else if (verified && !verified.has(req)) {
        status = 'IN_PROGRESS';
        note = 'test tasks closed but no req-verified token found';
      } else status = 'SATISFIED';
    } else if (tests.every((x) => x.state === 'open')) status = 'PENDING';
    else status = 'IN_PROGRESS';
    return {
      req,
      title: prdReqs[req] ? prdReqs[req].title : null,
      status,
      note,
      tests,
      acs: prdReqs[req] ? prdReqs[req].acIds : [],
      acsProven: ev && ev.acsProvenByReq[req] ? ev.acsProvenByReq[req] : [],
      evidence,
    };
  });

  const summary = { SATISFIED: 0, IN_PROGRESS: 0, PENDING: 0, NOT_PLANNED: 0 };
  for (const r of requirements) summary[r.status] += 1;

  return {
    checklist: { total: tasks.length, done: doneAll, pct: pct(doneAll, tasks.length), phases },
    requirements,
    summary,
    evidence,
    totalRequirements: requirements.length,
  };
}

module.exports = {
  validateTrd,
  analyzeTrd,
  requirementStatus,
  evidenceFromComments,
  traceabilityFindings,
  findCycles,
  dependencyDepths,
  isChecked,
  taskTitle,
};
