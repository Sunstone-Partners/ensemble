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
 * last round, and says so only when two things hold: a MATCH BY LOCATION (the same file, cited lines that overlap the finding's
 * lines in this head's numbering) and a CHEAP CONFIRMATION (below). A restatement is merged into the existing entry BEFORE it becomes
 * a candidate: it is not verified, the entry is (`restatedBy` names it). Whether the entry keeps its verdict is `planCarry`'s call
 * alone, by its own rules, none of them loosened here: a settled, complete verdict whose cited hunk, dependencies and dependents the
 * push left alone is carried; every other entry is verified again, as itself. What is not confirmed stays a separate candidate: this
 * module can only ever give a round FEWER candidates through a merge it can state a reason for, never drop a finding on a doubt.
 *
 * THE CONFIRMATION. The measured restatements are the same defect in other words, so no check of the text can be exact, and a
 * distinct defect on the same lines must never be merged (that hides a finding). The confirmation is `resemblanceOver` of
 * pr-review-ledger.js, the measure `dedupeFindings` already joins two reviewers' write-ups of one defect by (the weight of the words
 * two descriptions share, over the smaller description's weight, words weighed by how few findings use them, over the findings in
 * play: the prior ledger and this round's candidates), with a STRICTER bar, RESTATED_MIN_SIMILARITY, than the in-round 0.26.
 * THE BAR IS FITTED, NOT VALIDATED. It was chosen from 45 pairs of findings that cite overlapping lines in 7 ledgers of this repository's
 * own review runs (21 state files were scanned). The pairs are committed in tests/fixtures/pr-review-restated-fit-pairs.json with every
 * entry of each ledger, so the fit can be re-derived, and tests/pr-review-restated-fit.test.js re-scores them; each pair is scored over its
 * OWN ledger. By the reading of whoever fitted the bar, 8 of the 45 are one defect written up twice, 35 are distinct defects and 2 are
 * unclear. Over their own ledgers the pairs of one defect score 0.51, 0.47, 0.46, 0.45 and 0.42 (the two measured restatements of run
 * m2-pr293-re are 0.51 and 0.42), which the bar merges, and 0.34 and 0.32, which it does NOT (one more the measure refuses to compare, for
 * its size ratio): the bar costs recall. The highest of the 35 distinct pairs scores 0.29 (RT-4 and RT-7 of PR 229: a missing test and an
 * off-by-one test title, both on toolchain-adapters.test.js:500). THE MARGIN DEPENDS ON THE CORPUS: the runner weighs the words over the
 * prior ledger and the round's candidates, not over a pair's own ledger, and the same pair scores differently there (PR 291 f3 and f5, a
 * distinct pair, scores 0.22 over its own ledger and about 0.33 over a union of 98 entries, two hundredths under the bar). No held-out
 * set of restatements exists; the first live delta round is the validation. The in-round bar (0.26) is below the highest distinct pair:
 * in a round it is the same-source rule that keeps such a pair apart, and across rounds source names repeat (a fresh `reviewer-s1-a` is
 * another agent), so the rule cannot protect here.
 * The confirmation also keeps every in-round condition (at least SAME_DEFECT_MIN_WORDS words each, the shorter description at least a
 * third of the longer one's weight, the same class, security relevance and Pre-existing status, nothing that needs a person) and adds:
 *   - the lines must OVERLAP (the in-round rule also takes lines two apart);
 *   - the candidate must match ONE open finding: a candidate that confirms against two is ambiguous and stays separate;
 *   - an entry takes ONE restatement a round: a second candidate that confirms against it stays separate;
 *   - the entry must be one whose claim this round can settle or has settled: a finding the last round settled `present`, or left
 *     for want of a verifier (which this round verifies again). Never a finding the verifiers refuted (`filtered`), that needed a
 *     person (`disputed`), nobody could be asked about (`unbriefable`), the push cleared, or an operator resolved.
 * Alternatives rejected: (1) one extra verifier asked "is this the same defect" (unanimous): it needs a dispatch round BEFORE the
 * verify round (wall time, the figure this work exists to cut) and K agents for unanimity, and cannot make the verify round smaller
 * unless it runs first; (2) a normalized hash of the cited code: two findings on overlapping lines cite the same code by
 * construction, so it confirms nothing that the location did not, which is the failure to guard against; (3) location alone: the PR 229
 * ledger holds nine distinct defects on one line of one file.
 * HONEST LIMITS. The measure is lexical and corpus-relative (more findings in play weigh a shared word more; with fewer than three findings
 * in play every word weighs the same, the more permissive reading), the bar rests on the fit pairs above, and a false merge keeps the
 * merged defect from its own verification this round. What bounds the harm: the restating claim
 * and its evidence stay in the entry (`restatedBy`, shown in the answer, the state report, the bead and the gate); the entry takes
 * the more severe of the two severities, so a restatement can never lower what blocks; the entry stays an open finding with its own
 * verdict (carried or fresh); and a fix that touches the cited lines ends the merge's reach, since an entry whose lines a push
 * touched is never matched and the defect, raised again, is a candidate of its own.
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
function restatementRecord(candidate, similarity, headSha) {
  return {
    id: candidate.id,
    source: isText(candidate.source) ? candidate.source : isText(candidate.reviewer) ? candidate.reviewer : undefined,
    locationOrLink: candidate.locationOrLink,
    severity: candidate.severity,
    failureMode: candidate.failureMode,
    ...(isText(candidate.evidence) ? { evidence: candidate.evidence.length > EVIDENCE_KEPT ? `${candidate.evidence.slice(0, EVIDENCE_KEPT)}...` : candidate.evidence } : {}),
    similarity: round2(similarity),
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
 * @returns {{merged:Array<{candidate:Object, entry:Object, similarity:number, sizeRatio:number}>, kept:Array<{candidate:Object, reason:string, against:Array, similarity:number}>}}
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
      const entry = { at: p, similarity: look.similarity, sizeRatio: look.sizeRatio };
      if (look.comparable && look.similarity >= RESTATED_MIN_SIMILARITY) {
        if (!confirmed.has(c)) confirmed.set(c, []);
        confirmed.get(c).push(entry);
        return;
      }
      const why = look.comparable ? KEPT_REASONS.DIFFERENT_DESCRIPTION : look.why === 'kind' ? KEPT_REASONS.DIFFERENT_KIND : look.why === 'unsettled' ? KEPT_REASONS.UNSETTLED : look.why === 'corpus-too-small' ? KEPT_REASONS.CORPUS_TOO_SMALL : KEPT_REASONS.DIFFERENT_DESCRIPTION;
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
      merged.push({ candidate, entry: priors[verdict.merge.at].entry, similarity: verdict.merge.similarity, sizeRatio: verdict.merge.sizeRatio });
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

module.exports = { matchRestatements, absorbRestatements, restatementRecord, restatementsOf, restatedIds, RESTATED_MIN_SIMILARITY, KEPT_REASONS, EVIDENCE_KEPT };
