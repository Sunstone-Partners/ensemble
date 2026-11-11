'use strict';

/**
 * pr-review-restated.js -- a restatement of an open finding is that finding, not a new one (kata tmf5; follow-up of kata p5dt and qw98).
 *
 * THE MEASURED GAP. A delta round carries a prior verdict only for a candidate whose file and claim are the prior finding's, and the
 * delta reviewers never see the prior wording. So a defect a reviewer states again in its own words is a NEW candidate: the ledger
 * holds it twice, the gate lists two blockers for one defect, the verify round pays for it, and `carried` stays 0. In the final live
 * re-measurement (run m2-pr293-re, a real delta after a real fix push) two of the three new candidates were restatements of findings
 * the ledger already held open, verified 5/0/0 (f20 of f7, same line 284; f21 of f10, same line 274), and `carried >= 1` never
 * happened in either live delta.
 *
 * WHAT THIS MODULE DOES. It decides, for each candidate a delta round's reviewers raised, whether it restates an OPEN finding of the
 * last round, and says so only when two things hold: a MATCH BY LOCATION (the same file, cited lines that OVERLAP the finding's lines in
 * this head's numbering: a shared boundary line counts as overlap, an adjacent line does not) and a CHEAP CONFIRMATION (below). A
 * restatement is merged into the existing entry BEFORE it becomes a candidate: it is not verified, the entry is (`restatedBy` names it).
 * Whether the entry keeps its verdict is `planCarry`'s call alone, by its own rules, none of them loosened here: a settled, complete
 * verdict whose cited hunk, dependencies and dependents the push left alone is carried; every other entry is verified again, as itself.
 * What is not confirmed stays a separate candidate: this module can only ever give a round FEWER candidates through a merge it can state
 * a reason for, never drop a finding on a doubt.
 *
 * THE CONFIRMATION: TWO SIGNALS, BOTH REQUIRED. The measured restatements are the same defect in other words, so no check of the text
 * can be exact, and a distinct defect on the same lines must never be merged (that hides a finding).
 *   (1) THE BAR. `resemblanceOver` of pr-review-ledger.js, the measure `dedupeFindings` already joins two reviewers' write-ups of one
 *       defect by (the weight of the words two descriptions share, over the smaller description's weight, words weighed by how few
 *       findings use them, over the findings in play: the prior ledger and this round's candidates), at RESTATED_MIN_SIMILARITY, a
 *       STRICTER bar than the in-round 0.26. With fewer than three findings in play it REFUSES (`corpus-too-small`): there is nothing
 *       to weigh the words by, and a uniform weight is another measure that the bar was not fitted for (through this matcher it merged
 *       RT-4 and RT-7 of PR 229, a missing test and an off-by-one title, at 0.465, and 4 of the 35 distinct fit pairs, where the corpus
 *       weights reach none). The cost: a restatement in a delta round of one or two findings stays a duplicate candidate.
 *   (2) A SHARED IDENTIFIER. The two claims (`failureMode`, not the evidence: what the claim says is wrong, not what the reviewer ran)
 *       name at least one code-like identifier in common, compared without case. A token (letters, digits, `_` and `$`, joined by `.` or
 *       `-`, a trailing `()` kept) is one when it is a call (`retry()`: three characters or more before the parentheses), snake_case,
 *       SCREAMING_SNAKE or a leading underscore (`LABEL_IDS`, `_fixture`: an underscore and two letters in a row), camelCase or
 *       PascalCase (`dirnamePaths`: a lowercase letter followed by an uppercase one), or a dotted name or file name (`items.length`,
 *       `adapters.js`: every part two characters or more with a letter in it; not `e.g`, `1.5`, `v1.2`). A plain word, a hyphenated
 *       compound (`end-to-end`) and an acronym (`JSON`, `E2E`) never count, nor does the cited file's own name (two findings that
 *       overlap cite one file, so naming it says nothing) nor the short GENERIC_TOKENS list (proper nouns that are camelCase by
 *       spelling, the literal NaN, and files every repository has). Why: the lexical bar admits two distinct defects that share
 *       vocabulary, and a claim that names no code in common with the finding has nothing but vocabulary to go on. A candidate that
 *       clears the bar without one is kept as `no-shared-identifier`, with its score; a merge records the identifiers that confirmed it.
 * The confirmation also keeps every in-round condition (at least SAME_DEFECT_MIN_WORDS words each, the shorter description at least a
 * third of the longer one's weight, the same class, security relevance and Pre-existing status, nothing that needs a person) and adds:
 *   - the candidate must match ONE open finding: a candidate that confirms against two is ambiguous and stays separate (a finding the
 *     candidate clears the bar against without sharing an identifier is not a match, so it makes no ambiguity);
 *   - an entry takes ONE restatement a round: a second candidate that confirms against it stays separate;
 *   - the entry must be one whose claim this round can settle or has settled: a finding the last round settled `present`, or left
 *     for want of a verifier (which this round verifies again). Never a finding the verifiers refuted (`filtered`), that needed a
 *     person (`disputed`), nobody could be asked about (`unbriefable`), the push cleared, or an operator resolved.
 *
 * THE BAR AND THE SIGNAL ARE FITTED, NOT VALIDATED, AND THEY COST RECALL. 0.35 was chosen from 45 pairs of findings that cite
 * overlapping lines in 7 ledgers of this repository's own review runs (21 state files and one committed ledger were scanned; 7 held
 * overlapping pairs), and the identifier rule was derived from the same pairs. The pairs are committed in
 * tests/fixtures/pr-review-restated-fit-pairs.json with every entry of each ledger, so the fit can be re-derived, and
 * tests/pr-review-restated-fit.test.js re-scores them; each pair is scored over its OWN ledger. By the reading of whoever fitted the
 * bar (every call is a reading of the two claims' text; the 14 distinct calls that had cited the in-round same-source rule were re-read
 * from the text, and pr-207 f4~f16, which may be one defect or two, is unclear), 7 of the 45 are one defect written up twice, 35 are
 * distinct defects and 3 are unclear. The pairs of one defect score 0.51, 0.47, 0.46, 0.45 and 0.42 (the two measured restatements of
 * run m2-pr293-re are 0.51 and 0.42), which the bar merges, and 0.32, which it does NOT (one more the measure refuses to compare, for
 * its size ratio): 5 of 7. The highest of the 35 distinct pairs scores 0.29 (RT-4 and RT-7 of PR 229, both on
 * toolchain-adapters.test.js:500). All 7 pairs of one defect and all 3 unclear pairs name an identifier in common, and 8 of the 35
 * distinct pairs do (none clears the bar over its own ledger): on this data the signal costs no recall and removes nothing the bar had
 * let through. THE MARGIN DEPENDS ON THE CORPUS: the runner weighs the words over the prior ledger and the round's candidates, not over
 * a pair's own ledger, and the same pair scores differently there (PR 291 f3 and f5, a distinct pair, scores 0.22 over its own ledger
 * and about 0.33 over a union of 98 entries, two hundredths under the bar). No held-out set of restatements exists; the first live
 * delta round is the validation. The in-round bar (0.26) is below the highest distinct pair: in a round it is the same-source rule that
 * keeps such a pair apart, and across rounds source names repeat (a fresh `reviewer-s1-a` is another agent), so the rule cannot
 * protect here.
 * RESIDUAL FALSE MERGES, measured on SYNTHETIC pairs (tests/fixtures/pr-review-restated-synthetic-pairs.json: 30 hand-written pairs of
 * distinct defects on the same lines, scored over the PR 229 ledger plus the pair; a rate estimate, not data from reviews, pinned by
 * tests/pr-review-restated-synthetic.test.js): the reviewer's 10 pairs written to share vocabulary and naming no code: 6 clear the bar
 * and 0 merge; 10 natural pairs of two defects in one named function: 1 merges (`cacheKey` leaving out the tenant id, and `cacheKey`
 * lowercasing the resource), and all 10 name the function, so the signal separates none of them; the worst case (the reviewer's 10
 * with a function name added to both claims): 7 of 10 merge. The signal is a heuristic, not a proof: it cannot tell two defects in
 * one named function apart.
 * Alternatives rejected: (1) one extra verifier asked "is this the same defect" (unanimous): it needs a dispatch round BEFORE the
 * verify round (wall time, the figure this work exists to cut) and K agents for unanimity, and cannot make the verify round smaller
 * unless it runs first; (2) a normalized hash of the cited code: two findings on overlapping lines cite the same code by
 * construction, so it confirms nothing that the location did not, which is the failure to guard against; (3) location alone: the PR 229
 * ledger holds nine distinct defects on one line of one file; (4) a uniform weight below three findings (above); (5) requiring two
 * shared identifiers: every pair of one defect that clears the bar here shares three or more, but a plain restatement that names only
 * the function it is about would then never merge, and the data cannot separate two from one.
 * HONEST LIMITS. The measure is lexical and corpus-relative (more findings in play weigh a shared word more), the bar and the signal
 * rest on the fit pairs above, a restatement written in plain words that names no code stays a separate candidate however alike the
 * two are, and a false merge keeps the merged defect from its own verification this round. What bounds the harm: the restating claim
 * and its evidence stay in the entry (`restatedBy`, with the identifiers and the score that confirmed it, shown in the answer, the
 * state report, the bead and the gate); the entry takes the more severe of the two severities, so a restatement can never lower what
 * blocks; the entry stays an open finding with its own verdict (carried or fresh); and a fix that touches the cited lines ends the
 * merge's reach, since an entry whose lines a push touched is never matched and the defect, raised again, is a candidate of its own.
 * An entry takes ONE restatement a round, so when two reviewers restate one entry in one round the better candidate merges and the other
 * stays a candidate of its own: the ledger then holds that defect twice (more findings, never fewer).
 *
 * Pure: no shell, no file read, no network. The caller hands in the findings, the corpus and a function that reads a citation.
 */

const { resemblanceOver, severityRank, isActionable } = require('./pr-review-ledger');

/** The bar a confirmed restatement must reach (see the module header for the measurement behind it). */
const RESTATED_MIN_SIMILARITY = 0.35;

/** How much of a restating candidate's evidence the entry keeps. */
const EVIDENCE_KEPT = 600;

/** Why a candidate that overlapped an open finding was kept as a candidate of its own. */
const KEPT_REASONS = Object.freeze({
  DIFFERENT_DESCRIPTION: 'different-description',
  NO_SHARED_IDENTIFIER: 'no-shared-identifier',
  DIFFERENT_KIND: 'different-kind',
  UNSETTLED: 'unsettled',
  CORPUS_TOO_SMALL: 'corpus-too-small',
  AMBIGUOUS: 'ambiguous',
  ENTRY_TAKEN: 'entry-already-restated',
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const identity = (value) => (isText(value) ? value.trim() : Number.isFinite(value) ? String(value) : null);
const round2 = (value) => Math.round(value * 100) / 100;

/** How many shared identifiers a restatement record and the answer name. */
const IDENTIFIERS_KEPT = 8;

/** A token of a claim: letters, digits, `_` and `$`, joined by `.` or `-`, a trailing `()` kept (`write()`, `items.length`, `validate-all.js`). */
const TOKEN = /[A-Za-z0-9_$]+(?:[.-][A-Za-z0-9_$]+)*(?:\(\))?/g;

/**
 * Tokens of the right shape that name no piece of the code under review: proper nouns that are camelCase by spelling (a language, a
 * host), the literal `NaN` and files every repository has. A short list, the rest is the shape's work (see `isIdentifier`).
 */
const GENERIC_TOKENS = new Set(['javascript', 'typescript', 'github', 'gitlab', 'macos', 'ios', 'postgresql', 'mongodb', 'graphql', 'openai', 'nan', 'readme.md', 'changelog.md', 'package.json', 'package-lock.json']);

/**
 * Whether a token is shaped like a name in code, which a plain word never is: a call (`retry()`, three characters or more before the
 * parentheses), snake_case or SCREAMING_SNAKE or a leading underscore (an underscore and two letters in a row), camelCase or PascalCase
 * (a lowercase letter followed by an uppercase one: `dirnamePaths`, `stripComments`), or a dotted name or a file name (every part two
 * characters or more with a letter in it: `items.length`, `adapters.js`, `Microsoft.Playwright.Xunit`; not `e.g`, `1.5` or `v1.2`).
 * A plain hyphenated compound (`comment-stripped`, `end-to-end`) and a plain word are not, nor is an acronym (`JSON`, `E2E`).
 */
function isIdentifier(token) {
  const call = token.endsWith('()');
  const name = call ? token.slice(0, -2) : token;
  if (call && name.length >= 3 && /[A-Za-z]/.test(name)) return true;
  if (name.includes('_') && /[A-Za-z]{2}/.test(name)) return true;
  if (/[a-z][A-Z]/.test(name)) return true;
  return name.includes('.') && name.split('.').every((part) => part.length >= 2 && /[A-Za-z]/.test(part));
}

/**
 * The identifiers a claim names (`failureMode`, not the evidence: what the claim says is wrong, not what the reviewer ran): tokens that
 * pass `isIdentifier`, are not on the short generic list and are not the cited file's own name (two findings that overlap cite one file,
 * so naming it says nothing about which code they are about). Keyed by the lower-cased token, valued by the spelling the claim uses.
 */
function identifiersOf(finding, file) {
  const found = new Map();
  if (!isObject(finding) || !isText(finding.failureMode)) return found;
  const base = isText(file) ? file.toLowerCase().split('/').pop() : null;
  for (const match of finding.failureMode.matchAll(TOKEN)) {
    const key = match[0].toLowerCase();
    if (!isIdentifier(match[0]) || GENERIC_TOKENS.has(key) || key === base || found.has(key)) continue;
    found.set(key, match[0]);
  }
  return found;
}

/** The identifiers both claims name (in `a`'s spelling, in the order `a` names them): the second signal a restatement must show beside the resemblance bar. */
function sharedIdentifiers(a, b, file) {
  const named = identifiersOf(b, file);
  return [...identifiersOf(a, file)].filter(([key]) => named.has(key)).map(([, spelling]) => spelling);
}

/** The restatements an entry records, read defensively: the objects of `restatedBy` that name an id; anything else is not one. */
function restatementsOf(entry) {
  if (!isObject(entry) || !Array.isArray(entry.restatedBy)) return [];
  return entry.restatedBy.filter((record) => isObject(record) && identity(record.id) !== null);
}

/** The ids and raisers a list of restatements names, for the places that must know who raised a defect (the verifier exclusion, the id seed). */
function restatedIds(entry) {
  return restatementsOf(entry).flatMap((record) => [identity(record.id), ...(Array.isArray(record.mergedFrom) ? record.mergedFrom.map((member) => (isObject(member) ? identity(member.id) : null)) : [])]).filter((id) => id !== null);
}

/** One restatement as the entry records it: who said it, where, how, when (the head of the round that saw it) and what made it a restatement. */
function restatementRecord(candidate, similarity, headSha, shared) {
  return {
    id: candidate.id,
    source: isText(candidate.source) ? candidate.source : isText(candidate.reviewer) ? candidate.reviewer : undefined,
    locationOrLink: candidate.locationOrLink,
    severity: candidate.severity,
    failureMode: candidate.failureMode,
    ...(isText(candidate.evidence) ? { evidence: candidate.evidence.length > EVIDENCE_KEPT ? `${candidate.evidence.slice(0, EVIDENCE_KEPT)}...` : candidate.evidence } : {}),
    similarity: round2(similarity),
    ...(Array.isArray(shared) && shared.length > 0 ? { sharedIdentifiers: shared.slice(0, IDENTIFIERS_KEPT) } : {}),
    headSha,
    ...(Array.isArray(candidate.mergedFrom) && candidate.mergedFrom.length > 0
      ? { mergedFrom: candidate.mergedFrom.filter(isObject).map(({ id, source, locationOrLink }) => ({ id, source, locationOrLink })) }
      : {}),
  };
}

/**
 * Which of `candidates` restate which of `priors`.
 *
 * @param {Object} input
 * @param {Object[]} input.candidates  The candidates the round's reviewers raised (ledger entries with `id`, `source`, `locationOrLink`, `failureMode`, ...).
 * @param {Array<{entry:Object, locationOrLink:string}>} input.priors  The open findings of the last round a candidate may restate: the ledger entry (its text, severity,
 *                                  kind) and its citation in THIS head's numbering (`locationOrLink`). The caller has already excluded every entry that cannot be one.
 * @param {Object[]} input.corpus   Every finding in play, the weights of the words are read over (the prior ledger and the candidates).
 * @param {function(string):?{file:string,start:number,end:number}} input.locate  Reads a citation; null for one that names no file and line.
 * @returns {{merged:Array<{candidate:Object, entry:Object, similarity:number, sizeRatio:number, shared:string[]}>, kept:Array<{candidate:Object, reason:string, against:Array, similarity:number}>}}
 *   `kept` lists only the candidates that overlapped an open finding and were NOT merged, each with why: the others never came near one.
 */
function matchRestatements({ candidates, priors, corpus, locate }) {
  const merged = [];
  const kept = [];
  if (!Array.isArray(candidates) || !Array.isArray(priors) || !Array.isArray(corpus) || typeof locate !== 'function') return { merged, kept };

  const resemble = resemblanceOver(corpus);
  const places = priors.map((prior) => (isObject(prior) && isObject(prior.entry) ? locate(prior.locationOrLink) : null));
  const confirmed = new Map(); // candidate index -> [{ at: prior index, similarity, sizeRatio }]
  const nearest = new Map(); // candidate index -> the best unconfirmed overlap, to say why it stayed apart
  candidates.forEach((candidate, c) => {
    const where = isObject(candidate) ? locate(candidate.locationOrLink) : null;
    if (where === null) return;
    priors.forEach((prior, p) => {
      const there = places[p];
      if (there === null || there.file !== where.file || where.start > there.end || there.start > where.end) return;
      const look = resemble(candidate, prior.entry);
      const shared = look.comparable && look.similarity >= RESTATED_MIN_SIMILARITY ? sharedIdentifiers(candidate, prior.entry, where.file) : [];
      const entry = { at: p, similarity: look.similarity, sizeRatio: look.sizeRatio, shared };
      // the two signals: the resemblance reaches the bar AND the claims name a code-like identifier in common
      if (shared.length > 0) {
        if (!confirmed.has(c)) confirmed.set(c, []);
        confirmed.get(c).push(entry);
        return;
      }
      const why = !look.comparable
        ? look.why === 'kind' ? KEPT_REASONS.DIFFERENT_KIND : look.why === 'unsettled' ? KEPT_REASONS.UNSETTLED : look.why === 'corpus-too-small' ? KEPT_REASONS.CORPUS_TOO_SMALL : KEPT_REASONS.DIFFERENT_DESCRIPTION
        : look.similarity >= RESTATED_MIN_SIMILARITY ? KEPT_REASONS.NO_SHARED_IDENTIFIER : KEPT_REASONS.DIFFERENT_DESCRIPTION;
      const best = nearest.get(c);
      if (best === undefined || entry.similarity > best.similarity) nearest.set(c, { ...entry, reason: why });
    });
  });

  // An entry takes the best candidate that confirmed against it, once; a candidate that confirmed against several entries is ambiguous.
  const taken = new Map(); // prior index -> candidate index
  const order = [...confirmed.keys()].sort((a, b) => Math.max(...confirmed.get(b).map((m) => m.similarity)) - Math.max(...confirmed.get(a).map((m) => m.similarity)) || a - b);
  const decided = new Map();
  for (const c of order) {
    const matches = confirmed.get(c);
    if (matches.length > 1) {
      decided.set(c, { reason: KEPT_REASONS.AMBIGUOUS, against: matches.map((m) => priors[m.at].entry.id), similarity: Math.max(...matches.map((m) => m.similarity)) });
      continue;
    }
    const [only] = matches;
    if (taken.has(only.at)) {
      decided.set(c, { reason: KEPT_REASONS.ENTRY_TAKEN, against: [priors[only.at].entry.id], similarity: only.similarity });
      continue;
    }
    taken.set(only.at, c);
    decided.set(c, { merge: only });
  }

  candidates.forEach((candidate, c) => {
    const verdict = decided.get(c);
    if (verdict !== undefined && verdict.merge !== undefined) {
      merged.push({ candidate, entry: priors[verdict.merge.at].entry, similarity: verdict.merge.similarity, sizeRatio: verdict.merge.sizeRatio, shared: verdict.merge.shared });
    } else if (verdict !== undefined) {
      kept.push({ candidate, reason: verdict.reason, against: verdict.against, similarity: verdict.similarity });
    } else if (nearest.has(c)) {
      const near = nearest.get(c);
      kept.push({ candidate, reason: near.reason, against: [priors[near.at].entry.id], similarity: near.similarity });
    }
  });
  return { merged, kept };
}

/**
 * The entry with the restatements `records` recorded in `restatedBy` (earlier ones kept, a record already there for the same id and head not added
 * twice) and, when a restatement is MORE severe than the entry, the entry raised to that severity: a restatement may raise what blocks and never
 * lower it. A raised entry's old decision (an adjudication, a deferral and its reason, a `blocking` flag) was a decision about the lesser finding
 * and is dropped, and an actionable entry never keeps `deferred` (the rule `dedupeFindings` applies). Pure; the entry is never mutated.
 */
function absorbRestatements(entry, records) {
  const known = restatementsOf(entry);
  const have = new Set(known.map((record) => `${record.headSha}\u0000${identity(record.id)}`));
  const added = records.filter((record) => !have.has(`${record.headSha}\u0000${identity(record.id)}`));
  if (added.length === 0) return entry;
  let out = { ...entry, restatedBy: [...known, ...added] };
  const top = added.reduce((best, record) => (severityRank(record) > severityRank(best) ? record : best), added[0]);
  if (severityRank(top) > severityRank(entry)) {
    const { adjudication: _adjudication, adjudicatedBy: _adjudicatedBy, reason: _reason, blocking: _blocking, ...rest } = out;
    out = { ...rest, severity: top.severity, disposition: isText(top.disposition) ? top.disposition : 'fix' };
    if (out.disposition === 'deferred' && isActionable(out)) out.disposition = out.uncertain === true ? 'adjudicate' : 'fix';
  }
  return out;
}

module.exports = { matchRestatements, absorbRestatements, restatementRecord, restatementsOf, restatedIds, identifiersOf, sharedIdentifiers, isIdentifier, RESTATED_MIN_SIMILARITY, KEPT_REASONS, EVIDENCE_KEPT, IDENTIFIERS_KEPT };
