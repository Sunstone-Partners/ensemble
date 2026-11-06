'use strict';

/**
 * Verification assignment: which verifiers settle which candidate finding
 * (docs/plans/pr-review-speedup-plan.md, section 3A, "Verify per candidate").
 *
 * Verification used to be one agent per verifier slot, each judging EVERY
 * candidate, so a round took as long as its slowest verifier on the whole
 * list. Here every candidate gets K DISTINCT verifiers (K = 3 Standard, 5 Deep,
 * the count `votes` expects) but each agent is handed only one or a few
 * candidates, so the round takes the time of the slowest small agent.
 *
 * `planVerification` is the planning half; `votes` (with its `assignment`
 * input) is the validating half. The plan it returns is what `votes` checks
 * the tally against, so a candidate that lost a verifier shows up as missing
 * a vote instead of as a smaller electorate.
 *
 * Pure: NO side effects, NO shell, NO network, NO file reads. FAIL CLOSED:
 *
 *  - a pool that cannot give some candidate K verifiers is an explicit error
 *    naming those candidates, never a candidate quietly given fewer;
 *  - a finding's own reviewer is never one of its verifiers (the same
 *    case-insensitive name comparison `votes` applies);
 *  - anything it cannot read is a refusal with a reason and an EMPTY plan.
 *
 * Independence ("no verifier sees another's vote") is a property of the
 * dispatch, not of this plan: each agent is briefed on its own candidates
 * only, and nothing here carries a vote.
 */

const { resolveExpected } = require('./pr-review-votes');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

/** Text identity for ids that may be written as a string or a finite number (the same rule `votes` uses). */
const identity = (value) => (isText(value) ? value.trim() : Number.isFinite(value) ? String(value) : null);

function refuse(reason, extra = {}) {
  return { ok: false, reason, k: null, verifiersPerCandidate: null, assignments: [], agents: [], ...extra };
}

/**
 * The reviewer names a candidate must never be verified by: `reviewerOf(candidate)` when given, else the
 * candidate's own `reviewer` -- the field `votes` excludes. A name or a list of names; absent is no exclusion.
 *
 * @returns {string[]|null}  lower-cased names, or null when the value cannot be read.
 */
function reviewersOf(candidate, reviewerOf) {
  const raw = reviewerOf === undefined ? candidate.reviewer : reviewerOf(candidate);
  if (raw === undefined || raw === null) return [];
  const names = Array.isArray(raw) ? raw : [raw];
  if (!names.every(isText)) return null;
  return names.map((name) => name.trim().toLowerCase());
}

/** The pool as trimmed names: `verifierPool` as given, or `verifierCount` generated ones. */
function readPool(input, k) {
  const hasPool = input.verifierPool !== undefined;
  const hasCount = input.verifierCount !== undefined;
  if (hasPool && hasCount) return { ok: false, reason: 'give verifierPool or verifierCount, not both' };

  if (hasPool) {
    if (!Array.isArray(input.verifierPool) || !input.verifierPool.every(isText)) {
      return { ok: false, reason: 'verifierPool must be an array of non-empty names' };
    }
    const names = input.verifierPool.map((name) => name.trim());
    if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
      return { ok: false, reason: 'verifierPool must not name the same verifier twice' };
    }
    return { ok: true, names };
  }

  if (hasCount) {
    if (!Number.isInteger(input.verifierCount) || input.verifierCount < 0) {
      return { ok: false, reason: 'verifierCount must be an integer >= 0' };
    }
    return { ok: true, names: Array.from({ length: input.verifierCount }, (_, index) => `verifier-${index + 1}`) };
  }

  // Quick expects no verifier, so it needs no pool; any other count with nobody to draw on cannot be met.
  if (k === 0) return { ok: true, names: [] };
  return { ok: false, reason: 'a verifierPool or verifierCount is required' };
}

/**
 * Plans which K distinct verifiers settle each candidate.
 *
 * @param {Object} input
 * @param {Object[]} input.candidates  Candidate findings, each `{ id, reviewer? }`.
 * @param {string} input.depth         `quick` | `standard` | `deep`; sets K (0 | 3 | 5).
 * @param {number} [input.expectedVerifiers]  Overrides K, exactly as it does for `votes`.
 * @param {string[]} [input.verifierPool]     The verifier names available.
 * @param {number} [input.verifierCount]      Or just how many: they are named `verifier-1` ... `verifier-N`.
 * @param {number} [input.maxCandidatesPerVerifier]  A ceiling on any one agent's batch (keeps each agent to
 *   "one or a few" candidates); a plan over it is refused rather than overloaded.
 * @param {function(Object):(string|string[]|undefined)} [input.reviewerOf]  Who raised a candidate, when
 *   that is not its `reviewer` field.
 * @returns {{ok:boolean, reason?:string, k:number|null, verifiersPerCandidate:number|null,
 *   assignments:Array<{id:string, verifiers:string[]}>,
 *   agents:Array<{verifier:string, candidates:string[]}>,
 *   load?:{min:number, max:number}, shortfalls?:Array<{id:string, eligible:number, needed:number}>}}
 */
function planVerification(input) {
  if (!isObject(input)) return refuse('invalid-input');
  if (!Array.isArray(input.candidates) || !input.candidates.every(isObject)) {
    return refuse('candidates must be an array of objects');
  }

  const resolved = resolveExpected(input);
  if (!resolved.ok) return refuse(resolved.reason);
  const k = resolved.expected;

  if (input.reviewerOf !== undefined && typeof input.reviewerOf !== 'function') {
    return refuse('reviewerOf must be a function when given');
  }
  const limit = input.maxCandidatesPerVerifier;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return refuse('maxCandidatesPerVerifier must be an integer >= 1 when given');
  }

  const ids = input.candidates.map((candidate) => identity(candidate.id));
  if (ids.some((id) => id === null)) return refuse('every candidate needs an id');
  if (new Set(ids).size !== ids.length) return refuse('candidate ids must be unique');

  const pool = readPool(input, k);
  if (!pool.ok) return refuse(pool.reason);

  // The candidates' reviewers must all be readable before anyone is assigned: a reviewer nobody can name
  // would be a verifier nobody could exclude.
  const reviewers = input.candidates.map((candidate) => reviewersOf(candidate, input.reviewerOf));
  const unreadable = reviewers.findIndex((names) => names === null);
  if (unreadable !== -1) return refuse(`candidate ${JSON.stringify(ids[unreadable])} has an unreadable reviewer`);

  const eligible = input.candidates.map((_, index) =>
    pool.names.filter((name) => !reviewers[index].includes(name.toLowerCase()))
  );

  const shortfalls = [];
  ids.forEach((id, index) => {
    if (eligible[index].length < k) shortfalls.push({ id, eligible: eligible[index].length, needed: k });
  });
  if (shortfalls.length > 0) {
    return refuse('verifier-pool-too-small', { k, poolSize: pool.names.length, shortfalls });
  }

  // Spread evenly: each candidate takes its K least-loaded eligible verifiers (pool order breaks ties), so with
  // nobody excluded no verifier ever holds more than one candidate above another.
  const load = new Map(pool.names.map((name) => [name, []]));
  const assignments = input.candidates.map((candidate, index) => {
    const chosen = eligible[index]
      .map((name, order) => ({ name, order }))
      .sort((a, b) => load.get(a.name).length - load.get(b.name).length || a.order - b.order)
      .slice(0, k)
      .map((entry) => entry.name);
    for (const name of chosen) load.get(name).push(ids[index]);
    return { id: ids[index], verifiers: chosen };
  });

  const agents = pool.names
    .filter((name) => load.get(name).length > 0)
    .map((name) => ({ verifier: name, candidates: load.get(name) }));
  const sizes = agents.map((agent) => agent.candidates.length);
  const heaviest = sizes.length === 0 ? 0 : Math.max(...sizes);

  if (limit !== undefined && heaviest > limit) {
    return refuse('verifier-overloaded', { k, maxCandidatesPerVerifier: limit, heaviest });
  }

  const result = { ok: true, k, verifiersPerCandidate: k, assignments, agents };
  if (sizes.length > 0) result.load = { min: Math.min(...sizes), max: heaviest };
  return result;
}

module.exports = { planVerification };
