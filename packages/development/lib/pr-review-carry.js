'use strict';

/**
 * pr-review-carry.js -- carries settled verification verdicts across heads (kata qw98;
 * docs/plans/pr-review-speedup-plan.md section 3B, first bullet).
 *
 * After a fix push the next round re-verifies only what the push can have changed. This module decides, per candidate,
 * whether the verdict a PRIOR head settled still stands (`carried`, recorded with the head it was originally settled on)
 * or must be verified again (`reverify`, with every reason that applies). It is the riskiest piece of the speedup: a wrong
 * "carry" silently reuses a stale verdict, so every rule below fails toward re-verification.
 *
 * Pure: NO shell, NO file reads, NO network. The hashes are inputs: the caller hashed the cited hunk and each dependency
 * file at the head being reviewed (lib/pr-review-carry-hash.js does that over git), exactly as `paths` takes the CODEOWNERS
 * text the caller read. A hash this module is not given is a hash that does not match.
 *
 * Identity of a settled candidate: (file, normalized claim). Whether its verdict still holds is decided by:
 *   - `hunkHash`   the sha256 of the cited hunk at the head;
 *   - `depHashes`  `{ path: sha256 }` of every file the cited file depends on (imports) at the head.
 *
 * ANY of these forces re-verification (reasons are listed, none dropped):
 *   range-not-delta         the delta plan is not a readable `delta`: a full range carries nothing;
 *   head-unknown            the head, the last reviewed head or a verdict's own head is not a full object id;
 *   delta-paths-unreadable  the delta's changed paths are not a list of paths;
 *   high-paths-unreadable   the High/sensitive paths are not a list of paths;
 *   high-path-touched       the delta touched a High or sensitive path: NOTHING carries (every candidate);
 *   new-candidate           no prior verdict for it;
 *   candidate-unreadable    no file, or a claim with no words, or a duplicate of another candidate's key;
 *   ambiguous-prior-verdict two prior verdicts for one key;
 *   head-not-last-reviewed  the verdict was last confirmed on a head other than the delta's start, so the delta does not
 *                           cover everything that changed since (a carried verdict is re-stamped with each head it passes);
 *   verdict-not-settled     the prior outcome is not `present` or `filtered` (`disputed` and `unverified` are not settled), or
 *                           it has no votes, or an assigned verifier was incomplete: a verdict nobody recorded is not carried;
 *   hash-missing            the prior or the current hunk hash, or either dependency hash map, is missing or unreadable;
 *   cited-file-in-delta     the cited file is among the delta's changed paths (whatever the hashes say);
 *   hunk-changed            the cited hunk's hash differs;
 *   dependency-changed      a dependency file is among the changed paths, or the dependency set or a hash differs.
 *
 * A prior verdict nobody re-presents (no candidate at this head) is never carried: it is listed as `unmatched` and the
 * ledger reconciles it explicitly with `clearFixedFindings`.
 *
 * What `carried` means for the ledger: each carried record's `head` is the CURRENT head (the finding is settled on it, so
 * `mergeFindings` does not re-open it and `clearFixedFindings` does not clear it) and `carriedFrom` is the head the verdict
 * was originally settled on, kept through any number of carries.
 */

const { isObjectId } = require('./pr-review-scope');

const REASONS = Object.freeze({
  RANGE_NOT_DELTA: 'range-not-delta',
  HEAD_UNKNOWN: 'head-unknown',
  DELTA_PATHS_UNREADABLE: 'delta-paths-unreadable',
  HIGH_PATHS_UNREADABLE: 'high-paths-unreadable',
  HIGH_PATH_TOUCHED: 'high-path-touched',
  NEW_CANDIDATE: 'new-candidate',
  CANDIDATE_UNREADABLE: 'candidate-unreadable',
  AMBIGUOUS_PRIOR_VERDICT: 'ambiguous-prior-verdict',
  HEAD_NOT_LAST_REVIEWED: 'head-not-last-reviewed',
  VERDICT_NOT_SETTLED: 'verdict-not-settled',
  HASH_MISSING: 'hash-missing',
  CITED_FILE_IN_DELTA: 'cited-file-in-delta',
  HUNK_CHANGED: 'hunk-changed',
  DEPENDENCY_CHANGED: 'dependency-changed',
  NO_CURRENT_CANDIDATE: 'no-current-candidate',
});

/** The outcomes of `votes` that settle a candidate. `disputed` needs a person; `unverified` was never verified. */
const SETTLED_OUTCOMES = Object.freeze(['present', 'filtered']);

const SHA256_HEX = /^[0-9a-f]{64}$/i;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const sameId = (a, b) => isObjectId(a) && isObjectId(b) && a.toLowerCase() === b.toLowerCase();
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && SHA256_HEX.test(a) && SHA256_HEX.test(b) && a.toLowerCase() === b.toLowerCase();

/** A path as every comparison here spells it: forward slashes, no leading `./`. */
function normalizePath(value) {
  return value.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

/** A claim reduced to what it says: lower case, punctuation and runs of whitespace flattened (as `fingerprintFinding` does a failure mode). */
function normalizeClaim(value) {
  if (!isText(value)) return null;
  const flattened = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return flattened === '' ? null : flattened;
}

/** The identity of a settled candidate, or null when it has no file or no claim words. */
function keyOf(entry) {
  if (!isObject(entry) || !isText(entry.file)) return null;
  const claim = normalizeClaim(entry.claim);
  return claim === null ? null : `${normalizePath(entry.file)}\u0000${claim}`;
}

/** `{ path: sha256 }` with at least zero entries, every path text and every hash a sha256: else null. An empty map is "no dependencies". */
function readDepHashes(value) {
  if (!isObject(value)) return null;
  const map = new Map();
  for (const [file, hash] of Object.entries(value)) {
    if (!isText(file) || typeof hash !== 'string' || !SHA256_HEX.test(hash)) return null;
    const key = normalizePath(file);
    if (map.has(key) && map.get(key) !== hash.toLowerCase()) return null;
    map.set(key, hash.toLowerCase());
  }
  return map;
}

function readPathList(value) {
  if (!Array.isArray(value) || !value.every(isText)) return null;
  return new Set(value.map(normalizePath));
}

function settled(prior) {
  if (!SETTLED_OUTCOMES.includes(prior.outcome)) return false;
  if (!Array.isArray(prior.votes) || prior.votes.length === 0) return false;
  if (!prior.votes.every((vote) => isObject(vote) && isText(vote.verifier) && isText(vote.verdict))) return false;
  if (prior.incompleteVerifiers !== undefined && !(Array.isArray(prior.incompleteVerifiers) && prior.incompleteVerifiers.length === 0)) return false;
  return true;
}

function unreadable(reason) {
  return { ok: false, carried: [], reverify: [], unmatched: [], reasons: [reason] };
}

/**
 * @param {Object} input
 * @param {string} input.headSha          The head being reviewed now (full object id).
 * @param {string} input.lastReviewedSha  The head the previous round reviewed, the start of the delta (full object id).
 * @param {{mode:string}} input.deltaPlan The `deltaPlan` of `facts.json` (`planDeltaReview`); only `mode: 'delta'` carries.
 * @param {string[]} input.deltaPaths     The paths changed between `lastReviewedSha` and `headSha`.
 * @param {string[]} input.highPaths      The paths classified High or sensitive (the `paths` result), changed or not.
 * @param {Object[]} input.priorVerdicts  `{ id?, file, claim, hunkHash, depHashes, head, outcome, votes[{verifier, verdict}],
 *                                          carriedFrom? }` as the previous round recorded them (the report's `verdicts`).
 * @param {Object[]} input.candidates     `{ id?, file, claim, hunkHash, depHashes }` at `headSha`: every candidate this round
 *                                        has, hashed at the head. A prior verdict is only ever carried onto one of these.
 * @returns {{ok:boolean, carried:Object[], reverify:Object[], unmatched:Object[], reasons:string[]}}
 */
function planCarry(input) {
  if (!isObject(input)) return unreadable('invalid-input');
  const { headSha, lastReviewedSha, deltaPlan, deltaPaths, highPaths, priorVerdicts, candidates } = input;
  if (!Array.isArray(priorVerdicts) || !priorVerdicts.every(isObject)) return unreadable('priorVerdicts must be an array of objects');
  if (!Array.isArray(candidates) || !candidates.every(isObject)) return unreadable('candidates must be an array of objects');

  // ---- gates that apply to every candidate: when one holds, nothing carries ----
  const global = [];
  if (!isObject(deltaPlan) || deltaPlan.mode !== 'delta') global.push(REASONS.RANGE_NOT_DELTA);
  if (!isObjectId(headSha) || !isObjectId(lastReviewedSha)) global.push(REASONS.HEAD_UNKNOWN);
  const delta = readPathList(deltaPaths);
  if (delta === null) global.push(REASONS.DELTA_PATHS_UNREADABLE);
  const high = readPathList(highPaths);
  if (high === null) global.push(REASONS.HIGH_PATHS_UNREADABLE);
  if (delta !== null && high !== null && [...high].some((file) => delta.has(file))) global.push(REASONS.HIGH_PATH_TOUCHED);

  // ---- index the prior verdicts and the candidates by key ----
  const priorsByKey = new Map();
  for (const prior of priorVerdicts) {
    const key = keyOf(prior);
    if (key === null) continue;
    if (!priorsByKey.has(key)) priorsByKey.set(key, []);
    priorsByKey.get(key).push(prior);
  }
  const candidateCount = new Map();
  for (const candidate of candidates) {
    const key = keyOf(candidate);
    if (key !== null) candidateCount.set(key, (candidateCount.get(key) || 0) + 1);
  }

  const carried = [];
  const reverify = [];
  const matched = new Set();

  for (const candidate of candidates) {
    const key = keyOf(candidate);
    const base = { file: isText(candidate.file) ? candidate.file : null, claim: typeof candidate.claim === 'string' ? candidate.claim : null };
    if (candidate.id !== undefined) base.id = candidate.id;
    if (key === null) {
      reverify.push({ ...base, reasons: [...new Set([...global, REASONS.CANDIDATE_UNREADABLE])] });
      continue;
    }
    matched.add(key);
    const reasons = [...global];
    if (candidateCount.get(key) > 1) reasons.push(REASONS.CANDIDATE_UNREADABLE);

    const priors = priorsByKey.get(key) || [];
    if (priors.length === 0) reasons.push(REASONS.NEW_CANDIDATE);
    if (priors.length > 1) reasons.push(REASONS.AMBIGUOUS_PRIOR_VERDICT);

    if (priors.length === 1) {
      const prior = priors[0];
      // Which head this verdict was last confirmed on, and where it was first settled.
      if (!isObjectId(prior.head) || (prior.carriedFrom !== undefined && !isObjectId(prior.carriedFrom))) reasons.push(REASONS.HEAD_UNKNOWN);
      else if (!sameId(prior.head, lastReviewedSha)) reasons.push(REASONS.HEAD_NOT_LAST_REVIEWED);
      if (!settled(prior)) reasons.push(REASONS.VERDICT_NOT_SETTLED);

      const priorDeps = readDepHashes(prior.depHashes);
      const currentDeps = readDepHashes(candidate.depHashes);
      const hashesReadable = priorDeps !== null && currentDeps !== null && SHA256_HEX.test(String(prior.hunkHash)) && SHA256_HEX.test(String(candidate.hunkHash));
      if (!hashesReadable) {
        reasons.push(REASONS.HASH_MISSING);
      } else {
        if (!sameHash(prior.hunkHash, candidate.hunkHash)) reasons.push(REASONS.HUNK_CHANGED);
        const sameSet = priorDeps.size === currentDeps.size && [...priorDeps.keys()].every((file) => currentDeps.has(file) && currentDeps.get(file) === priorDeps.get(file));
        // The two maps are equal when `sameSet` holds, so the current keys are the dependencies to look for in the delta.
        const depTouched = delta !== null && [...currentDeps.keys()].some((file) => delta.has(file));
        if (!sameSet || depTouched) reasons.push(REASONS.DEPENDENCY_CHANGED);
      }
      if (delta !== null && delta.has(normalizePath(candidate.file))) reasons.push(REASONS.CITED_FILE_IN_DELTA);

      if (reasons.length === 0) {
        const record = {
          file: prior.file,
          claim: prior.claim,
          hunkHash: candidate.hunkHash.toLowerCase(),
          depHashes: Object.fromEntries(currentDeps),
          head: headSha,
          carriedFrom: prior.carriedFrom !== undefined ? prior.carriedFrom : prior.head,
          outcome: prior.outcome,
          votes: prior.votes,
        };
        if (candidate.id !== undefined) record.id = candidate.id;
        else if (prior.id !== undefined) record.id = prior.id;
        carried.push(record);
        continue;
      }
    }
    reverify.push({ ...base, reasons: [...new Set(reasons)] });
  }

  const unmatched = [];
  for (const prior of priorVerdicts) {
    const key = keyOf(prior);
    if (key !== null && matched.has(key)) continue;
    unmatched.push({
      file: isText(prior.file) ? prior.file : null,
      claim: typeof prior.claim === 'string' ? prior.claim : null,
      ...(prior.id !== undefined ? { id: prior.id } : {}),
      reasons: [REASONS.NO_CURRENT_CANDIDATE],
    });
  }

  return { ok: true, carried, reverify, unmatched, reasons: [...new Set(global)] };
}

module.exports = { planCarry, normalizeClaim, REASONS, SETTLED_OUTCOMES };
