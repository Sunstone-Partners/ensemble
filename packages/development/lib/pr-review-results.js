'use strict';

/**
 * Review results by file, agent deadlines and agent-failure classification
 * (kata et2k, epic ptqb, plan docs/plans/pr-review-speedup-plan.md section 3C).
 *
 * What this module does, and what it deliberately does not
 * --------------------------------------------------------
 *
 * HONEST LIMIT. This is repository code that COMPUTES things: the deadline an
 * agent is given, the state each expected result file is in, and what to do
 * about an API failure. It does NOT kill, stop or time out any agent, and it
 * cannot. Whatever dispatches the agents (the `runner` child owns dispatch)
 * must stop an agent at the `deadlineAt` computed here. Until it does, a
 * deadline is a number in a report, not enforcement; nothing here, and
 * nothing in a document that cites this module, may claim otherwise. What this
 * module DOES guarantee is the other half: once a deadline has passed, a
 * result that did not arrive in time is never read as a review.
 *
 * Three pure-ish building blocks (fs is allowed in this module, and only
 * `collectResults` touches it, through injectable `deps` as in
 * local-ci-runner.js; `pr-review-cli.js` itself stays free of file reads):
 *
 *   reviewDeadlines({tier, depth, role, now, policy?}) -> {deadlineAt, ...}
 *     reviewer 15 min, verifier 5 min, security lane 15 min, overridable per
 *     role by the `deadlineMinutes` policy key (1..60 minutes, validated by
 *     pr-review-policy.js). `tier` and `depth` are validated and echoed; they
 *     do not change the budget (the plan sets none).
 *
 *   collectResults({expected, dir, now, scratchDir?}, deps?)
 *     Each expected agent writes `out-<name>.json` into `dir`. Every agent is
 *     classified, from the files alone:
 *       arrived  a valid result that was written no later than its deadline;
 *       missing  nothing written yet and the deadline has not passed
 *                (`pending: true`: collect again);
 *       expired  nothing valid in time -- the deadline passed with no file, or
 *                the file was written after it. Final, never read as reviewed;
 *       invalid  a file exists but cannot be used: empty, truncated, not JSON,
 *                not a regular file, too large or the wrong schema. The file is
 *                quarantined under `<scratchDir>/quarantine/` with its reason
 *                and the agent counts as not reviewed. (`pending` stays true
 *                until the deadline, because an agent that is still writing
 *                non-atomically can leave a half file that a later pass finds
 *                complete. Dispatch should have agents write a temp file and
 *                rename it.)
 *     A yield that is a JSON STRING holding the object (the string-versus-object
 *     retry the plan measured) is parsed once more and accepted; anything
 *     deeper is invalid.
 *     The moment a valid result is seen it is copied to `scratchDir` (default
 *     `<dir>/.collected`) with its modification time preserved. A scratch copy
 *     is authoritative from then on: classification is a function of (expected,
 *     dir contents, scratch contents, now), so an orchestrator that crashed and
 *     is restarted re-collects over the same directory and reaches the same
 *     answer, and an agent that later rewrites or deletes its file changes
 *     nothing.
 *     An expired, missing or invalid agent never silently becomes "reviewed":
 *       - a verifier that did not arrive is named in `incompleteVerifiers`
 *         (with the candidate ids it was assigned, or null for every
 *         candidate when the assignment is unknown), which `tallyVotes` turns
 *         into `unverified` / `verifier-incomplete`, presented and never
 *         counted as agreement;
 *       - a reviewer that did not arrive, or arrived without having covered
 *         every path of its slice, leaves that slice in `unreviewedSlices`.
 *         A slice counts as reviewed only when EVERY reviewer assigned to it
 *         arrived and covered it, so one expired lens leaves the slice not
 *         reviewed (plan 3A crosses each slice with more than one lens).
 *     `ok` is true only when the request was readable and every agent
 *     arrived; the lists are filled either way so a partial result is usable.
 *
 *   classifyAgentFailure({status, retryAfterSec, message, attempt?}) ->
 *       {retry, delayMs, fallbackRoute, failFast, state, kind, reason}
 *     Rate limits and overloads are retried after a backoff, on the alternate
 *     model route; a retry-after beyond `failFastAfterSec` (default 300, the
 *     length of a verifier's whole budget), unreadable failures, client errors
 *     and exhausted retries fail fast to `state: 'partial'`, which the caller
 *     records, instead of stalling for hours.
 *
 * Wiring: `collectResults` -> `toVotesInput` produces the exact payload of the
 * `votes` subcommand / `tallyVotes`; `reviewedSlices` is the `reviewed` array
 * of the `slices` subcommand / `verifyCoverage`.
 *
 * FAIL CLOSED: an unreadable request returns `ok:false` with a reason and
 * empty results ("no agents" is never "all reviewed"); a failure this module
 * cannot classify is a fail-fast, never a retry loop.
 */

const fs = require('fs');
const path = require('path');

const { DEADLINE_ROLES, DEFAULT_DEADLINE_MINUTES, DEADLINE_MINUTES_MIN, DEADLINE_MINUTES_MAX } = require('./pr-review-policy');
const { VERDICTS } = require('./pr-review-votes');

const MINUTE_MS = 60 * 1000;

/** The tiers and depths this module recognises when asked to echo them. */
const TIERS = Object.freeze(['low', 'medium', 'high']);
const DEPTHS = Object.freeze(['quick', 'standard', 'deep']);

/** A result file larger than this is not a review result. */
const MAX_RESULT_BYTES = 8 * 1024 * 1024;

/** Safe to splice into a file name: no separators, no `..`, no leading dot. */
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_FAIL_FAST_AFTER_SEC = 300;
const RATE_LIMIT_BACKOFF_MS = 30 * 1000;
const TRANSIENT_BACKOFF_MS = 10 * 1000;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/** Text identity for ids that may be written as a string or a finite number. */
const identity = (value) => (isText(value) ? value.trim() : Number.isFinite(value) ? String(value) : null);

/** Epoch milliseconds from a finite number or an ISO string; `null` when neither. */
function toMillis(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (isText(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

function deadlineFailure(reason) {
  return { ok: false, reason, deadlineAt: null, budgetMs: 0, warnings: [] };
}

/**
 * The wall-clock deadline for one agent that starts at `now`.
 *
 * @param {Object} input
 * @param {string} input.role      `reviewer` | `verifier` | `security`.
 * @param {number|string} input.now  Epoch ms or ISO string: when the agent is dispatched.
 * @param {string} [input.tier]    `low` | `medium` | `high`; validated and echoed.
 * @param {string} [input.depth]   `quick` | `standard` | `deep`; validated and echoed.
 * @param {Object} [input.policy]  A loaded policy (`loadPolicy(...).policy`); its
 *   `deadlineMinutes[role]` overrides the default when it is a 1..60 integer.
 * @returns {{ok:boolean, role?:string, deadlineAt:number|null, deadlineAtIso?:string, budgetMs:number,
 *   minutes?:number, source?:'default'|'policy', tier?:string, depth?:string, warnings:string[], reason?:string}}
 */
function reviewDeadlines(input) {
  if (!isObject(input)) return deadlineFailure('invalid-input');
  const role = isText(input.role) ? input.role.trim().toLowerCase() : null;
  if (role === null || !DEADLINE_ROLES.includes(role)) {
    return deadlineFailure(`unknown role ${JSON.stringify(input.role)} (expected ${DEADLINE_ROLES.join(', ')})`);
  }
  const now = toMillis(input.now);
  if (now === null) return deadlineFailure('now must be epoch milliseconds or an ISO timestamp');

  const result = { role };
  for (const [key, allowed] of [['tier', TIERS], ['depth', DEPTHS]]) {
    if (input[key] === undefined) continue;
    const value = isText(input[key]) ? input[key].trim().toLowerCase() : null;
    if (value === null || !allowed.includes(value)) {
      return deadlineFailure(`unknown ${key} ${JSON.stringify(input[key])} (expected ${allowed.join(', ')})`);
    }
    result[key] = value;
  }

  const warnings = [];
  let minutes = DEFAULT_DEADLINE_MINUTES[role];
  let source = 'default';
  const configured = isObject(input.policy) && isObject(input.policy.deadlineMinutes) ? input.policy.deadlineMinutes[role] : undefined;
  if (configured !== undefined) {
    if (Number.isInteger(configured) && configured >= DEADLINE_MINUTES_MIN && configured <= DEADLINE_MINUTES_MAX) {
      minutes = configured;
      source = 'policy';
    } else {
      warnings.push(`policy deadlineMinutes.${role} is out of range; the default applies`);
    }
  }

  const budgetMs = minutes * MINUTE_MS;
  const deadlineAt = now + budgetMs;
  return {
    ok: true,
    ...result,
    deadlineAt,
    deadlineAtIso: new Date(deadlineAt).toISOString(),
    budgetMs,
    minutes,
    source,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Result files
// ---------------------------------------------------------------------------

/** Injectable file access, so every failure case can be driven without a real disk. */
function defaultDeps() {
  return {
    /** `{mtimeMs, size, isFile}` for the entry itself (a symlink is not followed), or `null` when absent. */
    lstat(file) {
      try {
        const stat = fs.lstatSync(file);
        return { mtimeMs: stat.mtimeMs, size: stat.size, isFile: stat.isFile() };
      } catch (error) {
        if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
        throw error;
      }
    },
    readFile: (file) => fs.readFileSync(file, 'utf8'),
    /** Atomic: write a temp file beside the target, then rename it into place. */
    writeFile(file, text, mtimeMs) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, text);
      if (Number.isFinite(mtimeMs)) {
        const seconds = mtimeMs / 1000;
        fs.utimesSync(temp, seconds, seconds);
      }
      fs.renameSync(temp, file);
    },
  };
}

/** A schema check never throws: it answers the first reason the yield is unusable. */
function checkReviewer(value) {
  if (!Array.isArray(value.findings) || !value.findings.every(isObject)) return { reason: 'invalid-findings' };
  if (!Array.isArray(value.pathsReviewed) || !value.pathsReviewed.every(isText)) return { reason: 'invalid-paths-reviewed' };
  return {
    findings: value.findings,
    pathsReviewed: value.pathsReviewed.map((entry) => entry.trim().replace(/^\.\//, '')),
  };
}

function checkVerifier(value) {
  if (!Array.isArray(value.votes) || !value.votes.every(isObject)) return { reason: 'invalid-votes' };
  const votes = [];
  for (const vote of value.votes) {
    const candidateId = identity(vote.candidateId);
    if (candidateId === null) return { reason: 'vote-needs-candidate-id' };
    const verdict = isText(vote.verdict) ? vote.verdict.trim().toLowerCase() : null;
    if (verdict === null || !VERDICTS.includes(verdict)) return { reason: 'unknown-verdict' };
    votes.push({ candidateId, verdict });
  }
  return { votes };
}

/**
 * JSON text -> the agent's object. A string whose content is the JSON object is
 * the "string instead of object" yield: parsed once more, and only once.
 */
function parseYield(text) {
  const body = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : '';
  if (body.trim() === '') return { reason: 'empty-file' };
  let value;
  try {
    value = JSON.parse(body);
    if (typeof value === 'string') value = JSON.parse(value);
  } catch (error) {
    return { reason: 'unparseable-json' };
  }
  if (!isObject(value)) return { reason: 'yield-not-an-object' };
  return { value };
}

/** Reads and validates one result file. Never throws; every failure is a named reason. */
function inspectFile(file, role, deps) {
  let stat;
  try {
    stat = deps.lstat(file);
  } catch (error) {
    return { status: 'invalid', reason: `unreadable-file:${(error && error.code) || 'error'}` };
  }
  if (stat === null) return { status: 'absent' };
  if (!stat.isFile) return { status: 'invalid', reason: 'not-a-regular-file', mtimeMs: stat.mtimeMs };
  if (stat.size > MAX_RESULT_BYTES) return { status: 'invalid', reason: 'result-too-large', mtimeMs: stat.mtimeMs };

  let text;
  try {
    text = deps.readFile(file);
  } catch (error) {
    return { status: 'invalid', reason: `unreadable-file:${(error && error.code) || 'error'}`, mtimeMs: stat.mtimeMs };
  }

  const parsed = parseYield(text);
  if (parsed.reason) return { status: 'invalid', reason: parsed.reason, mtimeMs: stat.mtimeMs, text };
  const checked = role === 'verifier' ? checkVerifier(parsed.value) : checkReviewer(parsed.value);
  if (checked.reason) return { status: 'invalid', reason: checked.reason, mtimeMs: stat.mtimeMs, text };
  return { status: 'valid', data: checked, mtimeMs: stat.mtimeMs, text };
}

function collectFailure(reason) {
  return {
    ok: false,
    reason,
    complete: false,
    agents: [],
    findings: [],
    votes: [],
    incompleteVerifiers: [],
    reviewedSlices: [],
    unreviewedSlices: [],
    unreviewedDetail: [],
    warnings: [],
  };
}

/** Request validation: every problem is a refusal, because a guess here is a false "reviewed". */
function readExpected(input) {
  if (!isObject(input)) return { reason: 'invalid-input' };
  if (!isText(input.dir)) return { reason: 'dir must be a non-empty string' };
  if (!Array.isArray(input.expected) || input.expected.length === 0) {
    return { reason: 'expected must be a non-empty array of agents' };
  }
  const now = toMillis(input.now);
  if (now === null) return { reason: 'now must be epoch milliseconds or an ISO timestamp' };
  if (input.scratchDir !== undefined && !isText(input.scratchDir)) return { reason: 'scratchDir must be a non-empty string' };

  const agents = [];
  const seen = new Set();
  for (const [index, entry] of input.expected.entries()) {
    const label = `expected[${index}]`;
    if (!isObject(entry)) return { reason: `${label} must be an object` };
    if (!isText(entry.name) || !AGENT_NAME.test(entry.name) || entry.name.includes('..')) {
      return { reason: `${label}.name ${JSON.stringify(entry.name)} is not a safe file-name part` };
    }
    const key = entry.name.toLowerCase();
    if (seen.has(key)) return { reason: `${label}.name ${JSON.stringify(entry.name)} is listed twice` };
    seen.add(key);
    const role = isText(entry.role) ? entry.role.trim().toLowerCase() : null;
    if (role === null || !DEADLINE_ROLES.includes(role)) {
      return { reason: `${label}.role must be one of ${DEADLINE_ROLES.join(', ')}` };
    }
    const deadlineAt = toMillis(entry.deadlineAt);
    if (deadlineAt === null) return { reason: `${label}.deadlineAt must be epoch milliseconds or an ISO timestamp` };

    const agent = { name: entry.name, role, deadlineAt };
    if (entry.sliceId !== undefined) {
      if (!isText(entry.sliceId)) return { reason: `${label}.sliceId must be a non-empty string` };
      agent.sliceId = entry.sliceId.trim();
    }
    if (entry.paths !== undefined) {
      if (!Array.isArray(entry.paths) || !entry.paths.every(isText)) return { reason: `${label}.paths must be an array of paths` };
      agent.paths = entry.paths.map((p) => p.trim().replace(/^\.\//, ''));
    }
    if (entry.candidateIds !== undefined) {
      const ids = Array.isArray(entry.candidateIds) ? entry.candidateIds.map(identity) : [null];
      if (ids.includes(null)) return { reason: `${label}.candidateIds must be an array of ids` };
      agent.candidateIds = ids;
    }
    agents.push(agent);
  }
  return { agents, now, dir: input.dir, scratchDir: input.scratchDir === undefined ? path.join(input.dir, '.collected') : input.scratchDir };
}

/**
 * Classifies every expected agent from its result file and builds the inputs
 * `tallyVotes` and `verifyCoverage` consume. See the module header.
 *
 * @param {Object} input
 * @param {Object[]} input.expected  `{name, role, deadlineAt, sliceId?, paths?, candidateIds?}` per agent.
 *   `role` is reviewer|verifier|security; `deadlineAt` comes from `reviewDeadlines`;
 *   a reviewer's `sliceId`/`paths` say which slice it owns; a verifier's `candidateIds`
 *   say which candidates it was assigned.
 * @param {string} input.dir         Where the agents write `out-<name>.json`.
 * @param {number|string} input.now  The moment of observation.
 * @param {string} [input.scratchDir]  Defaults to `<dir>/.collected`.
 * @param {Object} [deps]            `{lstat, readFile, writeFile}`; real fs by default.
 */
function collectResults(input, deps) {
  const io = deps === undefined ? defaultDeps() : deps;
  const request = readExpected(input);
  if (request.reason) return collectFailure(request.reason);
  const { agents, now, dir, scratchDir } = request;

  const warnings = [];
  const records = agents.map((agent) => {
    const file = `out-${agent.name}.json`;
    const primary = path.join(dir, file);
    const kept = path.join(scratchDir, file);
    const record = { name: agent.name, role: agent.role, deadlineAt: agent.deadlineAt };
    if (agent.sliceId !== undefined) record.sliceId = agent.sliceId;
    if (agent.candidateIds !== undefined) record.candidateIds = agent.candidateIds.slice();

    const safeWrite = (target, text, mtimeMs) => {
      try {
        io.writeFile(target, text, mtimeMs);
        return true;
      } catch (error) {
        warnings.push(`could not write ${target}: ${(error && error.code) || 'error'}`);
        record.scratchError = (error && error.code) || 'error';
        return false;
      }
    };

    // A scratch copy was validated when it was taken: the first valid arrival is the one that counts.
    const earlier = inspectFile(kept, agent.role, io);
    const seen = earlier.status === 'valid' ? earlier : inspectFile(primary, agent.role, io);
    const fromScratch = earlier.status === 'valid';

    if (seen.status === 'valid') {
      if (fromScratch || safeWrite(kept, seen.text, seen.mtimeMs)) record.scratchPath = kept;
      record.arrivedAt = seen.mtimeMs;
      if (seen.mtimeMs <= agent.deadlineAt) {
        record.state = 'arrived';
        record.pending = false;
        record.data = seen.data;
      } else {
        record.state = 'expired';
        record.reason = 'arrived-after-deadline';
        record.pending = false;
      }
    } else if (seen.status === 'invalid') {
      record.state = 'invalid';
      record.reason = seen.reason;
      record.pending = now < agent.deadlineAt;
      const quarantine = path.join(scratchDir, 'quarantine');
      if (typeof seen.text === 'string') safeWrite(path.join(quarantine, file), seen.text, seen.mtimeMs);
      safeWrite(path.join(quarantine, `out-${agent.name}.reason.json`), JSON.stringify({ name: agent.name, reason: seen.reason }) + '\n');
      record.quarantinePath = path.join(quarantine, file);
    } else if (now >= agent.deadlineAt) {
      record.state = 'expired';
      record.reason = 'deadline-passed';
      record.pending = false;
    } else {
      record.state = 'missing';
      record.reason = 'not-yet-written';
      record.pending = true;
    }
    return { agent, record };
  });

  // --- Aggregation ------------------------------------------------------
  const findings = [];
  const votes = [];
  const incompleteVerifiers = [];
  const slices = new Map(); // id -> {reasons: [], missingPaths: []}

  for (const { agent, record } of records) {
    const arrived = record.state === 'arrived';
    if (agent.role === 'verifier') {
      if (!arrived) {
        incompleteVerifiers.push({
          verifier: agent.name,
          reason: record.reason === undefined ? record.state : `${record.state}:${record.reason}`,
          candidateIds: agent.candidateIds === undefined ? null : agent.candidateIds.slice(),
        });
        continue;
      }
      for (const vote of record.data.votes) votes.push({ verifier: agent.name, candidateId: vote.candidateId, verdict: vote.verdict });
      continue;
    }

    // reviewer and security lane
    let missingPaths = [];
    if (arrived) {
      for (const finding of record.data.findings) findings.push({ ...finding, reviewer: agent.name });
      if (agent.paths !== undefined) {
        const reviewedPaths = new Set(record.data.pathsReviewed);
        missingPaths = agent.paths.filter((p) => !reviewedPaths.has(p));
      }
    }
    if (agent.sliceId !== undefined) {
      const slice = slices.get(agent.sliceId) || { reasons: [], missingPaths: [] };
      if (!arrived) slice.reasons.push({ agent: agent.name, reason: `${record.state}:${record.reason}` });
      else if (missingPaths.length > 0) {
        slice.reasons.push({ agent: agent.name, reason: 'paths-not-reviewed' });
        for (const p of missingPaths) if (!slice.missingPaths.includes(p)) slice.missingPaths.push(p);
      }
      slices.set(agent.sliceId, slice);
    }
  }

  const reviewedSlices = [];
  const unreviewedDetail = [];
  for (const [id, slice] of slices) {
    if (slice.reasons.length === 0) reviewedSlices.push(id);
    else unreviewedDetail.push({ sliceId: id, reasons: slice.reasons, missingPaths: slice.missingPaths });
  }

  const complete = records.every(({ record }) => record.state === 'arrived');
  const result = {
    ok: complete,
    complete,
    agents: records.map(({ record }) => {
      const { data, ...rest } = record;
      return rest;
    }),
    findings,
    votes,
    incompleteVerifiers,
    reviewedSlices,
    unreviewedSlices: unreviewedDetail.map((entry) => entry.sliceId),
    unreviewedDetail,
    warnings,
  };
  if (!complete) result.reason = 'incomplete';
  return result;
}

/**
 * The `votes` payload for a collection: every candidate carries the votes cast
 * on it and the verifiers that were assigned to it but returned nothing usable.
 *
 * @param {Object} collected  A `collectResults` answer.
 * @param {Object} options
 * @param {string} options.depth                `quick` | `standard` | `deep`.
 * @param {number} [options.expectedVerifiers]
 * @param {Object[]} [options.candidates]       The deduplicated candidate findings; defaults to the reviewers' findings.
 * @returns {{findings:Object[], depth:string, expectedVerifiers?:number, ignoredVotes:Object[]}|{ok:false, reason:string}}
 *   `ignoredVotes` lists votes dropped for naming a candidate the verifier was not assigned.
 */
function toVotesInput(collected, options) {
  if (!isObject(collected) || !Array.isArray(collected.votes) || !Array.isArray(collected.incompleteVerifiers)) {
    return { ok: false, reason: 'collected must be a collectResults answer' };
  }
  const opts = isObject(options) ? options : {};
  const candidates = opts.candidates === undefined ? collected.findings : opts.candidates;
  if (!Array.isArray(candidates)) return { ok: false, reason: 'candidates must be an array' };

  const assigned = new Map(); // verifier -> Set(candidateId) | null (unknown = every candidate)
  for (const entry of collected.incompleteVerifiers) assigned.set(entry.verifier, entry.candidateIds === null ? null : new Set(entry.candidateIds));
  for (const agent of Array.isArray(collected.agents) ? collected.agents : []) {
    if (agent.role === 'verifier' && agent.state === 'arrived' && Array.isArray(agent.candidateIds)) {
      assigned.set(agent.name, new Set(agent.candidateIds));
    }
  }

  const ignoredVotes = [];
  const findings = candidates.map((candidate) => {
    const id = isObject(candidate) ? identity(candidate.id) : null;
    if (id === null) return candidate; // tallyVotes refuses a finding with no id, loudly
    const cast = [];
    for (const vote of collected.votes) {
      if (vote.candidateId !== id) continue;
      const scope = assigned.get(vote.verifier);
      if (scope instanceof Set && !scope.has(id)) {
        ignoredVotes.push({ verifier: vote.verifier, candidateId: id, reason: 'candidate-not-assigned' });
        continue;
      }
      cast.push({ verifier: vote.verifier, verdict: vote.verdict });
    }
    const incomplete = collected.incompleteVerifiers
      .filter((entry) => entry.candidateIds === null || entry.candidateIds.includes(id))
      .map((entry) => ({ verifier: entry.verifier, reason: entry.reason }));
    for (const [verifier, scope] of assigned) {
      if (!(scope instanceof Set) || !scope.has(id)) continue;
      if (incomplete.some((entry) => entry.verifier === verifier) || cast.some((vote) => vote.verifier === verifier)) continue;
      incomplete.push({ verifier, reason: 'no-vote-for-candidate' });
    }
    return { ...candidate, votes: cast, incompleteVerifiers: incomplete };
  });

  const payload = { findings, depth: opts.depth, ignoredVotes };
  if (opts.expectedVerifiers !== undefined) payload.expectedVerifiers = opts.expectedVerifiers;
  return payload;
}

// ---------------------------------------------------------------------------
// Agent failure classification
// ---------------------------------------------------------------------------

const UNIT_SECONDS = { h: 3600, m: 60, s: 1 };

/** "try again in 27 hours" -> seconds; `null` when the message names no duration. */
function retryAfterFromMessage(message) {
  const match = /(?:retry|try again)[^0-9]{0,24}(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?|h|m|s)\b/i.exec(message);
  if (match === null) return null;
  return Number(match[1]) * UNIT_SECONDS[match[2][0].toLowerCase()];
}

function failureAnswer(fields) {
  return { ok: true, retry: false, delayMs: 0, fallbackRoute: false, failFast: false, warnings: [], ...fields };
}

/**
 * What to do about one failed agent API call.
 *
 * @param {Object} input
 * @param {number|string} [input.status]       HTTP status of the failure.
 * @param {number|string} [input.retryAfterSec] The server's retry-after, in seconds.
 * @param {string} [input.message]             The error text; consulted for the kind and, when
 *   `retryAfterSec` is absent, for a duration ("try again in 27 hours").
 * @param {number} [input.attempt]             Retries already made (default 0); `3` is exhausted.
 * @param {number} [input.failFastAfterSec]    A wait longer than this fails fast (default 300).
 * @returns {{ok:boolean, kind:string, retry:boolean, delayMs:number, fallbackRoute:boolean, failFast:boolean,
 *   state:'retry'|'partial', reason:string, warnings:string[]}}
 *   `state: 'partial'` is the state to RECORD: the agent's slice or candidates are not reviewed.
 */
function classifyAgentFailure(input) {
  if (!isObject(input)) {
    return failureAnswer({ ok: false, kind: 'unknown', failFast: true, state: 'partial', reason: 'invalid-input' });
  }
  const warnings = [];
  const message = typeof input.message === 'string' ? input.message : '';

  const statusNumber = typeof input.status === 'string' && /^\d{3}$/.test(input.status.trim()) ? Number(input.status) : input.status;
  const status = Number.isInteger(statusNumber) && statusNumber >= 100 && statusNumber <= 599 ? statusNumber : null;

  let kind;
  if (status === 429) kind = 'rate-limit';
  else if (status === 529 || status === 503) kind = 'overloaded';
  else if (status === 408) kind = 'timeout';
  else if (status !== null && status >= 500) kind = 'server-error';
  else if (status !== null && status >= 400) kind = 'client-error';
  else if (/\b429\b|rate[ -]?limit|too many requests|quota/i.test(message)) kind = 'rate-limit';
  else if (/overload|\b529\b|at capacity/i.test(message)) kind = 'overloaded';
  else if (/timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(message)) kind = 'timeout';
  else kind = 'unknown';

  const attempt = input.attempt === undefined ? 0 : input.attempt;
  if (!Number.isInteger(attempt) || attempt < 0) {
    return failureAnswer({ kind, failFast: true, state: 'partial', reason: 'invalid-attempt', warnings });
  }
  const failFastAfterSec = input.failFastAfterSec === undefined ? DEFAULT_FAIL_FAST_AFTER_SEC : input.failFastAfterSec;
  if (!Number.isFinite(failFastAfterSec) || failFastAfterSec < 0) {
    return failureAnswer({ kind, failFast: true, state: 'partial', reason: 'invalid-failFastAfterSec', warnings });
  }

  if (kind === 'client-error' || kind === 'unknown') {
    // Nothing a retry changes (a 401, a 400) or nothing this module can read: record it, do not loop.
    return failureAnswer({
      kind,
      failFast: true,
      state: 'partial',
      reason: kind === 'client-error' ? `client-error-${status}` : 'unclassified-failure',
      warnings,
    });
  }

  // Retry-after: the explicit field wins over a duration found in the text. A value that is not a
  // number of seconds is ignored with a warning; `Infinity` is a wait with no end and fails fast.
  let retryAfterSec = null;
  if (input.retryAfterSec !== undefined && input.retryAfterSec !== null) {
    const raw = typeof input.retryAfterSec === 'string' && input.retryAfterSec.trim() !== '' ? Number(input.retryAfterSec) : input.retryAfterSec;
    if (typeof raw === 'number' && !Number.isNaN(raw) && raw >= 0) retryAfterSec = raw;
    else warnings.push('unreadable-retry-after');
  }
  if (retryAfterSec === null) retryAfterSec = retryAfterFromMessage(message);

  if (attempt >= RETRY_MAX_ATTEMPTS) {
    return failureAnswer({ kind, failFast: true, state: 'partial', reason: 'retries-exhausted', warnings });
  }
  if (retryAfterSec !== null && retryAfterSec > failFastAfterSec) {
    return failureAnswer({ kind, failFast: true, state: 'partial', reason: 'retry-after-too-long', warnings });
  }

  const backoffMs = (kind === 'rate-limit' || kind === 'overloaded' ? RATE_LIMIT_BACKOFF_MS : TRANSIENT_BACKOFF_MS) * 2 ** attempt;
  return failureAnswer({
    kind,
    retry: true,
    delayMs: retryAfterSec !== null ? Math.round(retryAfterSec * 1000) : backoffMs,
    // A limit on one model route does not bind the alternate one; a plain timeout says nothing about the route.
    fallbackRoute: kind === 'rate-limit' || kind === 'overloaded',
    state: 'retry',
    reason: retryAfterSec !== null ? 'retry-after' : 'backoff',
    warnings,
  });
}

module.exports = {
  reviewDeadlines,
  collectResults,
  toVotesInput,
  classifyAgentFailure,
  DEADLINE_ROLES,
  MAX_RESULT_BYTES,
  RETRY_MAX_ATTEMPTS,
  DEFAULT_FAIL_FAST_AFTER_SEC,
};
