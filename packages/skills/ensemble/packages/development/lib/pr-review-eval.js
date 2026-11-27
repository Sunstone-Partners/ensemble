'use strict';

/**
 * Reviewer eval set: case validation, run scoring, run comparison and
 * staleness (TRD-031, REQ-020).
 *
 * An eval case is an escaped bug -- a change that caused an incident or a
 * revert -- recorded as data a code owner confirmed:
 *   { id, change, bug, location: { path, startLine, endLine },
 *     confirmedBy, rulesFile, rulesHash }
 * stored as `<evalCasesDir>/<id>.json` (default `docs/review-eval/cases`).
 *
 * NO side effects, NO shell, NO network, NO file reads. The skill reads the
 * files and the hashes; this module only grades them.
 *
 * FAIL CLOSED everywhere, and always in the direction that costs the reviewer
 * the benefit of the doubt:
 *   - a case this module cannot read, or that no CODEOWNERS owner of the
 *     affected path confirmed, is NOT a valid case;
 *   - a case counts as found only when an IMPORTANT finding is anchored
 *     inside the recorded bug location -- a Nit, a Pre-existing finding, an
 *     unreadable severity or an unanchored finding never counts;
 *   - a comparison that cannot be read is reported as a REGRESSION, never as
 *     "nothing got worse";
 *   - a rules file whose hash is unknown makes its cases stale, never current.
 */

const { ownersFor } = require('./pr-review-paths');
const { normalizeSeverity, anchorOf } = require('./pr-review-ledger');
const { DEFAULT_EVAL_CASES_DIR } = require('./pr-review-policy');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isLine = (value) => Number.isInteger(value) && value >= 1;

/** A case id must be usable as a file name: no separators, no traversal, no surprises. */
const CASE_ID = /^[A-Za-z\d][A-Za-z\d._-]*$/;

/** Required case fields that are plain text. `location` is graded on its own. */
const TEXT_FIELDS = Object.freeze(['id', 'change', 'bug', 'confirmedBy', 'rulesFile', 'rulesHash']);

/** A login, compared the way GitHub does: without the `@`, case-insensitively. */
function loginKey(value) {
  return String(value).trim().replace(/^@/, '').toLowerCase();
}

/** Drops `./` and collapses `//`, without resolving `..` -- a traversal stays visible so it can be refused. */
function normalizeRepoPath(value) {
  return String(value).trim().replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

function failure(errors) {
  return { ok: false, caseId: null, errors, owners: [] };
}

/**
 * Grades one eval case (AC-020-1).
 *
 * @param {Object} input
 * @param {Object} input.case            The case record.
 * @param {string} [input.codeowners]    CODEOWNERS text of the repository.
 * @param {string} [input.path]          Where the case file lives, when it came from a file.
 * @param {string} [input.evalCasesDir]  Policy `evalCasesDir`; defaults to `docs/review-eval/cases`.
 * @returns {{ok:boolean, caseId:string|null, errors:Array<{field:string, reason:string}>, owners:string[]}}
 *   `ok` is true only when every required field is readable, the file (when
 *   given) is `<evalCasesDir>/<id>.json`, and `confirmedBy` is a CODEOWNERS
 *   owner of `location.path`.
 */
function validateCase(input) {
  if (!isObject(input)) return failure([{ field: 'input', reason: 'invalid-input' }]);

  const record = input.case;
  if (!isObject(record)) return failure([{ field: 'case', reason: 'invalid-case' }]);

  const errors = [];
  for (const field of TEXT_FIELDS) {
    if (!isText(record[field])) errors.push({ field, reason: field === 'confirmedBy' ? 'missing-confirmation' : 'missing-field' });
  }
  if (isText(record.id) && !CASE_ID.test(record.id.trim())) {
    errors.push({ field: 'id', reason: 'invalid-case-id' });
  }

  // --- The bug location ---------------------------------------------------
  const location = record.location;
  const locationOk =
    isObject(location) && isText(location.path) && isLine(location.startLine) && isLine(location.endLine)
    && location.endLine >= location.startLine;
  if (!locationOk) errors.push({ field: 'location', reason: 'invalid-location' });

  // --- The file it was loaded from (AC-020-1, evalCasesDir) ---------------
  const dirValue = input.evalCasesDir === undefined ? DEFAULT_EVAL_CASES_DIR : input.evalCasesDir;
  if (!isText(dirValue)) {
    errors.push({ field: 'evalCasesDir', reason: 'invalid-eval-cases-dir' });
  } else if (input.path !== undefined) {
    if (!isText(input.path)) {
      errors.push({ field: 'path', reason: 'invalid-case-path' });
    } else {
      const dir = normalizeRepoPath(dirValue).replace(/\/+$/, '');
      const filePath = normalizeRepoPath(input.path);
      const segments = filePath.split('/');
      const inDir = filePath.startsWith(`${dir}/`) && !segments.includes('..') && !filePath.startsWith('/');
      if (!inDir) {
        errors.push({ field: 'path', reason: 'case-outside-eval-dir' });
      } else if (isText(record.id) && segments[segments.length - 1] !== `${record.id.trim()}.json`) {
        errors.push({ field: 'path', reason: 'case-filename-mismatch' });
      }
    }
  }

  // --- Owner confirmation -------------------------------------------------
  let owners = [];
  if (locationOk) {
    const resolved = ownersFor(normalizeRepoPath(location.path), input.codeowners);
    owners = resolved.owners;
    if (owners.length === 0) {
      errors.push({ field: 'confirmedBy', reason: 'no-code-owner' });
    } else if (isText(record.confirmedBy)) {
      // A team entry (`@org/team`) names no login this module can check, so it
      // cannot confirm a case: membership is not knowable without the network.
      const ownerKeys = owners.filter((owner) => !owner.includes('/')).map(loginKey);
      if (!ownerKeys.includes(loginKey(record.confirmedBy))) {
        errors.push({ field: 'confirmedBy', reason: 'confirmed-by-not-owner' });
      }
    }
  }

  return { ok: errors.length === 0, caseId: isText(record.id) ? record.id.trim() : null, errors, owners };
}

const EMPTY_TOTAL = { cases: 0, found: 0, score: 0 };

function scoreFailure(reason) {
  return { ok: false, reason, cases: [], total: { ...EMPTY_TOTAL } };
}

/** A score with a stable number of decimals, and no division by zero on an empty set. */
function ratio(found, total) {
  if (total === 0) return 0;
  return Math.round((found / total) * 10000) / 10000;
}

/** Whether one finding is an Important finding anchored inside `location`. */
function coversLocation(finding, location) {
  if (!isObject(finding)) return false;
  if (normalizeSeverity(finding.severity) !== 'important') return false;
  const anchor = anchorOf(finding);
  if (anchor === null) return false;
  if (normalizeRepoPath(anchor.file) !== normalizeRepoPath(location.path)) return false;
  return anchor.line >= location.startLine && anchor.line <= location.endLine;
}

/**
 * Scores one eval run (AC-020-2): per-case results and a total.
 *
 * A case counts as found ONLY when an Important finding (Critical and Major
 * read as Important) is anchored to the recorded file and a line inside the
 * recorded range. Anything else -- a Nit, a Pre-existing finding, a severity
 * this library does not know, a finding with no `file:line` anchor, no
 * findings at all -- is not found, and the reason is named.
 *
 * @param {{cases:Object[], findingsByCase:Object<string, Object[]>}} input
 * @returns {{ok:boolean, cases:Array<{id:string, found:boolean, matchedFindingId:*, reason:string}>,
 *   total:{cases:number, found:number, score:number}, reason?:string}}
 */
function scoreEval(input) {
  if (!isObject(input)) return scoreFailure('invalid-input');
  const { cases, findingsByCase } = input;
  if (!Array.isArray(cases)) return scoreFailure('cases must be an array');
  if (!Array.from(cases).every(isObject)) return scoreFailure('cases must contain only objects');
  if (!isObject(findingsByCase)) return scoreFailure('findingsByCase must be an object keyed by case id');

  const confirmationRequired = input.codeowners !== undefined;
  const results = Array.from(cases).map((record) => {
    const id = isText(record.id) ? record.id.trim() : null;
    const location = record.location;
    const locationOk =
      isObject(location) && isText(location.path) && isLine(location.startLine) && isLine(location.endLine)
      && location.endLine >= location.startLine;
    if (id === null || !locationOk) {
      return { id, found: false, matchedFindingId: null, reason: 'invalid-case' };
    }
    // A case no CODEOWNERS owner confirmed is not evidence (AC-020-1). The
    // check runs whenever the caller supplies CODEOWNERS text.
    if (confirmationRequired) {
      const verdict = validateCase({ case: record, codeowners: input.codeowners, evalCasesDir: input.evalCasesDir });
      if (!verdict.ok) return { id, found: false, matchedFindingId: null, reason: 'case-unconfirmed' };
    }
    const recorded = Object.prototype.hasOwnProperty.call(findingsByCase, id) ? findingsByCase[id] : undefined;
    if (!Array.isArray(recorded)) {
      return { id, found: false, matchedFindingId: null, reason: 'no-findings-recorded' };
    }

    const match = Array.from(recorded).find((finding) => coversLocation(finding, location));
    return match === undefined
      ? { id, found: false, matchedFindingId: null, reason: 'no-important-finding-at-location' }
      : { id, found: true, matchedFindingId: match.id === undefined ? null : match.id, reason: 'important-finding-at-location' };
  });

  const found = results.filter((result) => result.found).length;
  return { ok: true, cases: results, total: { cases: results.length, found, score: ratio(found, results.length) } };
}

function compareFailure(reason) {
  return {
    ok: false,
    reason,
    regression: true,
    flipped: [],
    gained: [],
    missing: [],
    added: [],
    previousFound: 0,
    currentFound: 0,
    delta: 0,
  };
}

/** A run's per-case outcomes as a Map of id -> found, or null when the run cannot be read. */
function runOutcomes(run) {
  if (!isObject(run) || !Array.isArray(run.cases)) return null;
  const outcomes = new Map();
  for (const entry of Array.from(run.cases)) {
    if (!isObject(entry) || !isText(entry.id)) return null;
    const id = entry.id.trim();
    if (outcomes.has(id)) return { duplicate: id };
    outcomes.set(id, entry.found === true);
  }
  return outcomes;
}

/**
 * Compares two runs (AC-020-3).
 *
 * A regression is any loss of ground: a lower total, a case that went from
 * found to not-found, or a case the current run dropped. Each is named, so a
 * flagged regression always says which cases flipped.
 *
 * Fail closed: a comparison this module cannot read is reported as a
 * regression with `ok:false` -- "we could not tell" is never "all clear".
 * A run that reports its OWN failure (`ok:false`, as every `scoreEval`
 * failure does) is unreadable evidence too, not a score of zero: comparing
 * two failed runs must never read as "nothing was lost".
 *
 * @param {{previous:Object, current:Object}} input  Each run is a `scoreEval`
 *   result, or any `{ cases: [{ id, found }] }`.
 * @returns {{ok:boolean, regression:boolean, flipped:Array, gained:Array, missing:string[],
 *   added:string[], previousFound:number, currentFound:number, delta:number, reason?:string}}
 */
function compareEval(input) {
  if (!isObject(input)) return compareFailure('invalid-input');
  if (isObject(input.previous) && input.previous.ok === false) return compareFailure('previous run reported a failure');
  if (isObject(input.current) && input.current.ok === false) return compareFailure('current run reported a failure');
  const previous = runOutcomes(input.previous);
  const current = runOutcomes(input.current);
  if (previous === null) return compareFailure('previous run is unreadable');
  if (current === null) return compareFailure('current run is unreadable');
  if (previous instanceof Map === false) return compareFailure(`previous run has duplicate case id ${previous.duplicate}`);
  if (current instanceof Map === false) return compareFailure(`current run has duplicate case id ${current.duplicate}`);
  if (previous.size === 0 && current.size === 0) return compareFailure('no-cases');

  const flipped = [];
  const gained = [];
  const missing = [];
  for (const [id, wasFound] of previous) {
    if (!current.has(id)) {
      missing.push(id);
      continue;
    }
    const isFound = current.get(id);
    if (wasFound && !isFound) flipped.push({ id, from: true, to: false });
    if (!wasFound && isFound) gained.push({ id, from: false, to: true });
  }
  const added = [...current.keys()].filter((id) => !previous.has(id));

  const previousFound = [...previous.values()].filter(Boolean).length;
  const currentFound = [...current.values()].filter(Boolean).length;

  return {
    ok: true,
    regression: currentFound < previousFound || flipped.length > 0 || missing.length > 0,
    flipped,
    gained,
    missing,
    added,
    previousFound,
    currentFound,
    delta: currentFound - previousFound,
  };
}

function staleFailure(reason) {
  return { ok: false, reason, stale: [], reasons: {}, current: [] };
}

/**
 * The cases whose area rules changed, for owner re-review (AC-020-1).
 *
 * A case is stale when the current hash of its rules file differs from the
 * hash recorded on the case. A rules file that is absent from `rulesHashes`,
 * or a case that names no rules file, is stale too: an unknown rules state is
 * never read as "unchanged".
 *
 * @param {{cases:Object[], rulesHashes:Object<string, string>}} input
 * @returns {{ok:boolean, stale:string[], reasons:Object<string,string>, current:string[], reason?:string}}
 */
function staleCases(input) {
  if (!isObject(input)) return staleFailure('invalid-input');
  const { cases, rulesHashes } = input;
  if (!Array.isArray(cases)) return staleFailure('cases must be an array');
  if (!Array.from(cases).every(isObject)) return staleFailure('cases must contain only objects');
  if (!isObject(rulesHashes)) return staleFailure('rulesHashes must be an object keyed by rules file');

  const stale = [];
  const current = [];
  const reasons = {};

  for (const record of Array.from(cases)) {
    const id = isText(record.id) ? record.id.trim() : null;
    if (id === null) return staleFailure('every case needs a text id');

    if (!isText(record.rulesFile) || !isText(record.rulesHash)) {
      stale.push(id);
      reasons[id] = 'case-missing-rules-file';
      continue;
    }

    const file = normalizeRepoPath(record.rulesFile);
    const known = Object.prototype.hasOwnProperty.call(rulesHashes, file) ? rulesHashes[file] : undefined;
    if (!isText(known)) {
      stale.push(id);
      reasons[id] = 'rules-file-unknown';
    } else if (known.trim() !== record.rulesHash.trim()) {
      stale.push(id);
      reasons[id] = 'rules-hash-changed';
    } else {
      current.push(id);
    }
  }

  return { ok: true, stale, reasons, current };
}

module.exports = {
  validateCase,
  scoreEval,
  compareEval,
  staleCases,
  DEFAULT_EVAL_CASES_DIR,
};
