'use strict';

/**
 * pr-review-run-support.js -- the pure helpers of the light-mode review runner (kata znd1).
 *
 * NO shell, NO network, NO file reads: plain data in, plain data out. `pr-review-run.js` owns the stages and the
 * injected deps; this module owns the arithmetic and the text that does not need any of them:
 *
 *   - `deriveKinds`        the change kinds the runner may cite from the changed PATHS alone (never lowers a tier);
 *   - `planDepth`          resolveDepth + checkBounds, re-planned until no bound is violated or refused;
 *   - `completeFinding`    a reviewer's finding -> a ledger entry, completing (never dropping) what is missing;
 *   - `planVerifierPool`   planVerification with a pool sized so no verifier holds more than 3 candidates;
 *   - `chunk`              agents -> waves of at most `maxConcurrentAgents`;
 *   - `reviewerContract`, `verifierContract`, `agentPrompt`  the text an agent is given;
 *   - `adjudicateList`     the findings a person must decide;
 *   - `computeMetrics`     the AC5 timing record, from the run's own call log and agent times.
 */

const { resolveDepth, checkBounds } = require('./pr-review-depth');
const { planVerification } = require('./pr-review-verify-assign');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

/** Files that are prose, not behaviour. Everything else the runner cites as `product`, which is Medium. */
const DOC_FILE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;

/** One verifier is never handed more than this many candidates (plan 3A: "one or a few"). */
const MAX_CANDIDATES_PER_VERIFIER = 3;

/** The names of the reviewer lenses of one slice. */
const LENSES = Object.freeze(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);

/**
 * The change kinds the runner can cite without a classifier agent. A pure-prose path is `docs`, every other path is
 * `product`: a kind that is never Low, so a path-only reading can raise a tier's floor but never lower it. Every changed
 * path is cited exactly once, so the tier module sees no uncited path and no missing kinds.
 */
function deriveKinds(changedPaths) {
  if (!Array.isArray(changedPaths)) return [];
  const docs = changedPaths.filter((p) => typeof p === 'string' && DOC_FILE.test(p));
  const product = changedPaths.filter((p) => typeof p === 'string' && !DOC_FILE.test(p));
  const kinds = [];
  if (docs.length > 0) kinds.push({ kind: 'docs', paths: docs });
  if (product.length > 0) kinds.push({ kind: 'product', paths: product });
  return kinds;
}

/**
 * The depth of a light review: the mode its tier resolves to, the reviewers per slice and the verifiers per candidate,
 * graded against the bounds and re-planned from the violations until none is left. A plan that cannot be made to
 * satisfy its bounds is refused, never run short.
 *
 * @param {Object} record  a `tierRecord`
 * @returns {{ok:true, depth:Object}|{ok:false, reason:string}}
 */
function planDepth(record) {
  const waiver = record.effectiveTier === 'low' && isObject(record.waiver) && record.waiver.applies === true;
  const resolved = resolveDepth({ tier: record.tier, effectiveTier: record.effectiveTier, lowWaiverEnabled: waiver });
  if (resolved.ok !== true) return { ok: false, reason: `depth not resolved: ${resolved.reasons.join(', ') || 'unknown'}` };
  const { bounds } = resolved;
  // Never fewer than two reviewers on a slice, unless the mode's own ceiling is one (Quick).
  let reviewers = bounds.reviewers.max !== null && bounds.reviewers.max < 2 ? bounds.reviewers.max : Math.max(2, bounds.reviewers.min);
  let verifiers = bounds.verifiers.min;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const graded = checkBounds({ mode: resolved.mode, planned: { reviewers, verifiers } });
    if (graded.violations.length === 0) {
      if (graded.ok !== true) return { ok: false, reason: `depth bounds refused: ${graded.reason || graded.warnings.join(', ')}` };
      return {
        ok: true,
        depth: {
          mode: resolved.mode,
          tier: resolved.tier,
          source: resolved.source,
          reasons: resolved.reasons,
          bounds,
          reviewersPerSlice: reviewers,
          verifiersPerCandidate: verifiers,
          replanned: attempt,
        },
      };
    }
    for (const violation of graded.violations) {
      if (!Number.isInteger(violation.bound)) return { ok: false, reason: 'a depth bound violation names no bound' };
      if (violation.role === 'reviewers') reviewers = violation.bound;
      else verifiers = violation.bound;
    }
  }
  return { ok: false, reason: 'the depth plan still violates its bounds after re-planning' };
}

/** Dispositions an agent may name for itself. `resolved` is not one: an agent never resolves a finding. */
const AGENT_DISPOSITIONS = new Set(['fix', 'duplicate', 'not-applicable', 'deferred', 'adjudicate']);

/** Fields an agent may never set: they close a finding, and only a fix or an operator's recorded decision may. */
const NEVER_FROM_AGENT = Object.freeze(['resolution', 'cleared', 'blocking']);

/** Optional ledger fields passed through from an agent's finding. */
const PASS_THROUGH = Object.freeze(['reason', 'kind', 'class', 'unresolvedThread', 'uncertain', 'preExisting', 'security', 'lane', 'critical']);

/** The boolean flags the ledger refuses when they are anything else. */
const BOOLEAN_FLAGS = Object.freeze(['unresolvedThread', 'uncertain', 'preExisting']);

/**
 * One agent finding -> one ledger entry. Nothing is dropped: a missing field is filled with the honest default (open,
 * Important, "not stated") and named in `completedFields`; a field the agent has no right to set is removed and named in
 * `strippedFields`. The id is the harness's own and opaque (`f1`, `f2`, ... across all agents; the lane's are `s1`...),
 * so it is unique across agents and never names who raised the finding -- a verifier is briefed with it. The agent's own
 * is kept as `reportedId`. `source` is the agent that WROTE the file, which the harness knows and the agent cannot claim.
 */
function completeFinding(raw, agentName, id) {
  const finding = isObject(raw) ? raw : {};
  const completed = [];
  const stripped = [];
  const entry = { id, source: agentName };

  if (finding.id !== undefined && String(finding.id) !== entry.id) entry.reportedId = finding.id;
  if (finding.source !== undefined && finding.source !== agentName) entry.reportedSource = finding.source;

  const text = (field, fallback, completeAs) => {
    if (isText(finding[field])) {
      entry[field] = finding[field];
    } else {
      entry[field] = fallback;
      completed.push(completeAs || field);
    }
  };
  text('locationOrLink', 'unspecified');
  // A severity the ledger does not know is KEPT (the gate reads it as unrecognised and blocks); only an absent one is filled.
  if (isText(finding.severity)) entry.severity = finding.severity;
  else {
    entry.severity = 'important';
    completed.push('severity');
  }
  text('failureMode', 'not stated by the reviewer');
  if (isText(finding.disposition) && AGENT_DISPOSITIONS.has(finding.disposition.trim().toLowerCase())) {
    entry.disposition = finding.disposition.trim().toLowerCase();
  } else {
    entry.disposition = 'fix';
    completed.push('disposition');
    if (isText(finding.disposition)) stripped.push('disposition');
  }
  text('evidence', 'none given');
  if (isText(finding.originalTextOrLink)) entry.originalTextOrLink = finding.originalTextOrLink;
  else {
    entry.originalTextOrLink = entry.locationOrLink;
    completed.push('originalTextOrLink');
  }

  for (const key of PASS_THROUGH) {
    if (finding[key] === undefined) continue;
    if (BOOLEAN_FLAGS.includes(key) && typeof finding[key] !== 'boolean') {
      stripped.push(key);
      continue;
    }
    entry[key] = finding[key];
  }
  for (const key of NEVER_FROM_AGENT) if (finding[key] !== undefined) stripped.push(key);

  if (completed.length > 0) entry.completedFields = completed;
  if (stripped.length > 0) entry.strippedFields = stripped;
  return entry;
}

/**
 * Plans which verifiers settle which candidate. The pool is sized so that, spread evenly, no verifier holds more than
 * `MAX_CANDIDATES_PER_VERIFIER` candidates, and grown while the planner says it is too small or overloaded.
 */
function planVerifierPool({ candidates, mode, k }) {
  if (k === 0 || candidates.length === 0) return planVerification({ candidates, depth: mode });
  let size = Math.max(k, Math.ceil((candidates.length * k) / MAX_CANDIDATES_PER_VERIFIER));
  let plan = null;
  for (let attempt = 0; attempt < 8; attempt += 1, size += 1) {
    plan = planVerification({ candidates, depth: mode, verifierCount: size, maxCandidatesPerVerifier: MAX_CANDIDATES_PER_VERIFIER });
    if (plan.ok === true) return plan;
    if (plan.reason !== 'verifier-overloaded' && plan.reason !== 'verifier-pool-too-small') return plan;
  }
  return plan;
}

/** `items` in groups of at most `size` (at least one per group). */
function chunk(items, size) {
  const width = Math.max(1, size);
  const groups = [];
  for (let i = 0; i < items.length; i += width) groups.push(items.slice(i, i + width));
  return groups;
}

/** The part of a `file:line` / `file:start-end` location that names the file, or null. */
function locationFile(location) {
  const match = isText(location) ? /^(.+):(\d+)(?:-(\d+))?$/.exec(location) : null;
  return match === null ? null : match[1];
}

/** The text a reviewer or the lane writes its result as. */
function reviewerContract(agent) {
  return [
    '## Output contract (generated by the runner; it is not part of the policy text above)',
    '',
    `Write ONE JSON object to \`${agent.outPath}\` of exactly this shape:`,
    '',
    '```json',
    '{',
    '  "findings": [',
    '    { "id": "f1", "locationOrLink": "path/to/file.js:12", "severity": "important|nit|pre-existing",',
    '      "failureMode": "what goes wrong, in one sentence", "disposition": "fix|adjudicate",',
    '      "evidence": "what you read or ran, and what it showed", "originalTextOrLink": "path/to/file.js:12" }',
    '  ],',
    '  "pathsReviewed": ["repo-relative/path", "..."]',
    '}',
    '```',
    '',
    '- `pathsReviewed` lists every repository-relative path of your slice that you actually read. A path you did not read must not be listed: it is then reported as NOT reviewed, which is the honest answer.',
    '- No findings is `"findings": []`. Never invent a finding to fill the list.',
    '- Set `"uncertain": true` on a finding you cannot settle yourself; a person then decides it.',
    '- Do not write `resolution`, `cleared` or `blocking`: they are ignored.',
    `- Write the file atomically: a temp file in the same directory, then rename it to \`${agent.outPath}\`. Finish before ${agent.deadlineAtIso || 'your deadline'}; a result that arrives later is not read.`,
    '',
  ].join('\n');
}

/** The text a verifier writes its verdicts as. */
function verifierContract(agent) {
  return [
    '## Output contract (generated by the runner; it is not part of the policy text above)',
    '',
    `Write ONE JSON object to \`${agent.outPath}\` of exactly this shape, one entry per candidate you were given (${agent.candidateIds.join(', ')}):`,
    '',
    '```json',
    '{ "votes": [ { "candidateId": "<id as given>", "verdict": "real|not-real|abstain", "evidence": "what you checked and what it showed" } ] }',
    '```',
    '',
    '- A candidate you reached no conclusion on gets NO entry: you are then recorded as incomplete for it, which is the honest answer.',
    `- Write the file atomically: a temp file in the same directory, then rename it to \`${agent.outPath}\`. Finish before ${agent.deadlineAtIso || 'your deadline'}; a result that arrives later is not read.`,
    '',
  ].join('\n');
}

/** What the orchestrator hands a dispatched agent, unedited. */
function agentPrompt(agent) {
  return [
    `You are the ${agent.role} agent "${agent.name}" of an automated pull-request review. You start with a fresh context and have READ-ONLY access: change no file in the repository, the snapshot or anywhere else, except your one result file.`,
    `1. Read the brief at ${agent.briefPath} and follow it exactly.`,
    `2. Write your JSON result atomically (a temp file in the same directory, then rename) to ${agent.outPath}.`,
    `3. Finish before ${agent.deadlineAtIso}. A result that arrives after that is not read and you are recorded as not having reviewed.`,
    'Do not add, edit or interpret anything the brief does not ask for.',
  ].join('\n');
}

/**
 * The findings a person must decide: `uncertain`, disposition `adjudicate`, or a verifier-`disputed` outcome, and not
 * already adjudicated. The gate treats every one of them as open whatever happens here.
 */
function adjudicateList(ledger) {
  const list = [];
  for (const entry of ledger) {
    if (isObject(entry.adjudication)) continue;
    const outcome = isObject(entry.verification) ? entry.verification.outcome : undefined;
    if (entry.uncertain === true) list.push({ id: entry.id, why: 'uncertain: the reviewer could not settle it' });
    else if (entry.disposition === 'adjudicate') list.push({ id: entry.id, why: 'disposition adjudicate: the reviewer asked for a decision' });
    else if (outcome === 'disputed') list.push({ id: entry.id, why: 'disputed: the verifiers split or rejected a critical or security-relevant finding' });
  }
  return list;
}

/** Length of the union of `[start, end]` intervals. */
function unionMs(intervals) {
  const sorted = intervals.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted.length > 0 ? sorted[0] : [0, 0];
  for (const [s, e] of sorted.slice(1)) {
    if (s > curEnd) {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  return total + (curEnd - curStart);
}

/**
 * The AC5 timing record, from the run's own call log and agent times (nothing else is measured):
 *   wallMs              first runner call start -> `endAt`
 *   runnerCalls/runnerMs   the prepare/collect calls and the time spent inside them
 *   dispatchRounds / agentsDispatched
 *   agentWaitMs         union of [dispatchedAt, arrival or deadline-or-now] over every agent
 *   orchestratorOnlyMs  wall - runner - agent wait: the time nobody but the orchestrating model was running
 */
function computeMetrics(run, endAt) {
  const calls = Array.isArray(run.calls) ? run.calls : [];
  const start = calls.length > 0 ? Math.min(...calls.map((c) => c.startedAt)) : endAt;
  const wallMs = Math.max(0, endAt - start);
  const runnerMs = calls.reduce((sum, c) => sum + Math.max(0, c.endedAt - c.startedAt), 0);
  const waves = Array.isArray(run.waves) ? run.waves.filter((w) => w.status !== 'planned') : [];
  const agents = waves.flatMap((w) => w.agents);
  const intervals = agents.map((a) => [a.dispatchedAt, Number.isFinite(a.arrivedAt) ? a.arrivedAt : Math.min(a.deadlineAt, endAt)]);
  const agentWaitMs = unionMs(intervals);
  return {
    wallMs,
    runnerCalls: calls.length,
    dispatchRounds: waves.length,
    agentsDispatched: agents.length,
    runnerMs,
    agentWaitMs,
    orchestratorOnlyMs: Math.max(0, wallMs - runnerMs - agentWaitMs),
  };
}

module.exports = {
  deriveKinds,
  planDepth,
  completeFinding,
  planVerifierPool,
  chunk,
  locationFile,
  reviewerContract,
  verifierContract,
  agentPrompt,
  adjudicateList,
  computeMetrics,
  unionMs,
  LENSES,
  MAX_CANDIDATES_PER_VERIFIER,
  NEVER_FROM_AGENT,
};
