'use strict';

/**
 * A delta reviewer's restatement of an open finding is that finding, not a new candidate (kata tmf5): the pure steps
 * (packages/development/lib/pr-review-restated.js and the delta steps that use it) and what the other modules do with `restatedBy`
 * (the verifier exclusion, the gate blocker, the bead). The whole path is proven through the real CLI in review-run-restated-cli.test.js.
 *
 * THE BAR IS FITTED, NOT VALIDATED. RESTATED_MIN_SIMILARITY (0.35) was chosen from 45 pairs of findings in 7 ledgers of this repository's own
 * review runs, among them the two measured restatements of run m2-pr293-re; no held-out set of restatements exists yet. Those pairs are
 * committed (tests/fixtures/pr-review-restated-fit-pairs.json) and re-scored by tests/pr-review-restated-fit.test.js, which is where
 * measured data is pinned. THIS file pins how the shipped measure scores HAND-WRITTEN fixture claims (tests/helpers/pr-review-restated-claims.js)
 * and what the matcher does with each, so any change to the bar or to the scoring breaks here, visibly, and has to be argued. The first live
 * use is the validation: read `carry.restatements.merged` against `.kept` in the next delta run, and any merged pair two people would call
 * distinct defects is a miss.
 */

const { matchRestatements, absorbRestatements, restatementRecord, restatementsOf, restatedIds, identifiersOf, sharedIdentifiers, isIdentifier, RESTATED_MIN_SIMILARITY, KEPT_REASONS, EVIDENCE_KEPT, IDENTIFIERS_KEPT } = require('../lib/pr-review-restated');
const { checkPrior, restatedPrior, restatable, idSeed, composeDeltaLedger } = require('../lib/pr-review-run-delta');
const { raisersOf } = require('../lib/pr-review-votes');
const { evaluateGate, BLOCKER_CODES } = require('../lib/pr-review-gate');
const { planBeads, beadKeys } = require('../lib/pr-review-beads');
const { resemblanceOver, RESEMBLANCE_MIN_CORPUS } = require('../lib/pr-review-ledger');
const { CLAIMS: C, raised, entryOf } = require('./helpers/pr-review-restated-claims');

const HEAD = 'a'.repeat(40);
const near = (value, expected) => Math.abs(value - expected) <= 0.02;
const locate = (location) => {
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(location);
  return m === null ? null : { file: m[1], start: Number(m[2]), end: Number(m[3] || m[2]) };
};
const prior = (key, id, over) => entryOf(C[key], id, over);
const cand = (key, id, over) => ({ id, source: 'reviewer-s1-b', ...raised(C[key]), ...over });
const asPriors = (entries) => entries.map((entry) => ({ entry, locationOrLink: entry.locationOrLink }));
const match = (priors, candidates) => matchRestatements({ candidates, priors: asPriors(priors), corpus: [...priors, ...candidates], locate });

describe('the bar and what it separates (FITTED on one set of pairs, not validated on held-out data)', () => {
  const ledger = () => [prior('LOOP', 'f1'), prior('CACHE', 'f2'), prior('RETRY', 'f3'), prior('LOCK', 'f4')];

  test('the bar is pinned: 0.35, between the in-round 0.26 and the weakest measured restatement', () => {
    expect(RESTATED_MIN_SIMILARITY).toBe(0.35);
  });

  test('a restatement that names the same code is merged: LOOP 0.54, CACHE 0.46, RETRY 0.84, LOCK 0.44 (the weakest is 0.09 above the bar)', () => {
    const priors = ledger();
    const out = match(priors, [cand('LOOP_AGAIN', 'f5'), cand('CACHE_AGAIN', 'f6'), cand('RETRY_AGAIN', 'f7'), cand('LOCK_AGAIN', 'f8'), cand('PARSE', 'f9')]);
    expect(out.merged.map((m) => [m.candidate.id, m.entry.id])).toEqual([['f5', 'f1'], ['f6', 'f2'], ['f7', 'f3'], ['f8', 'f4']]);
    const scores = out.merged.map((m) => m.similarity);
    [0.54, 0.46, 0.84, 0.44].forEach((expected, index) => expect(near(scores[index], expected)).toBe(true));
    expect(Math.min(...scores)).toBeGreaterThan(RESTATED_MIN_SIMILARITY + 0.05);
    // the finding of another file never came near an open one, so it is not even listed
    expect(out.kept).toEqual([]);
  });

  test('an abstract paraphrase that shares no identifier scores 0.24 and stays a separate candidate: the limit of a lexical bar, said plainly', () => {
    const out = match(ledger(), [cand('CACHE_ABSTRACT', 'f5'), cand('PARSE', 'f6')]);
    expect(out.merged).toEqual([]);
    expect(out.kept).toEqual([expect.objectContaining({ reason: KEPT_REASONS.DIFFERENT_DESCRIPTION, against: ['f2'] })]);
    expect(out.kept[0].candidate.id).toBe('f5');
    expect(near(out.kept[0].similarity, 0.24)).toBe(true);
    expect(out.kept[0].similarity).toBeLessThan(RESTATED_MIN_SIMILARITY);
  });

  test('a distinct defect on the same line scores 0.10 and is kept apart', () => {
    const out = match(ledger(), [cand('LOCK_OTHER', 'f5'), cand('PARSE', 'f6')]);
    expect(out.merged).toEqual([]);
    expect(out.kept).toEqual([expect.objectContaining({ reason: KEPT_REASONS.DIFFERENT_DESCRIPTION, against: ['f4'] })]);
    expect(near(out.kept[0].similarity, 0.1)).toBe(true);
  });

  test('a restatement that confirms against two open findings (0.50 and 0.42) is ambiguous: merged into neither', () => {
    const priors = [prior('LOOP', 'f1'), prior('LOOP_TWIN', 'f2'), prior('CACHE', 'f3'), prior('RETRY', 'f4'), prior('LOCK', 'f5')];
    const out = match(priors, [cand('LOOP_AGAIN', 'f6'), cand('PARSE', 'f7')]);
    expect(out.merged).toEqual([]);
    expect(out.kept).toEqual([expect.objectContaining({ reason: KEPT_REASONS.AMBIGUOUS, against: ['f1', 'f2'] })]);
    expect(near(out.kept[0].similarity, 0.5)).toBe(true);
  });

  test('an entry takes ONE restatement a round: the better candidate merges and the other stays a candidate of its own', () => {
    const out = match([prior('LOOP', 'f1'), prior('CACHE', 'f2'), prior('RETRY', 'f3'), prior('LOCK', 'f4')], [cand('LOOP_TWIN', 'f5'), cand('LOOP_AGAIN', 'f6')]);
    expect(out.merged.map((m) => [m.candidate.id, m.entry.id])).toEqual([['f6', 'f1']]);
    expect(out.kept).toEqual([expect.objectContaining({ reason: KEPT_REASONS.ENTRY_TAKEN, against: ['f1'] })]);
    expect(out.kept[0].candidate.id).toBe('f5');
  });

  test('with fewer than three findings in play NOTHING is merged and the reason says why: a restatement in a round of one finding stays a candidate of its own', () => {
    // the four pairs that merge among five findings (0.54, 0.46, 0.84, 0.44) are refused here, not scored 0 and not scored by another measure
    for (const [was, again] of [['LOOP', 'LOOP_AGAIN'], ['CACHE', 'CACHE_AGAIN'], ['RETRY', 'RETRY_AGAIN'], ['LOCK', 'LOCK_AGAIN']]) {
      const out = match([prior(was, 'f1')], [cand(again, 'f2')]);
      expect(out.merged).toEqual([]);
      expect(out.kept).toEqual([expect.objectContaining({ reason: KEPT_REASONS.CORPUS_TOO_SMALL, against: ['f1'], similarity: 0 })]);
      expect(out.kept[0].candidate.id).toBe('f2');
    }
    // a distinct defect on the same line and an abstract paraphrase are kept apart for the same reason: no measure at all
    for (const [was, other] of [['LOCK', 'LOCK_OTHER'], ['CACHE', 'CACHE_ABSTRACT']]) {
      const out = match([prior(was, 'f1')], [cand(other, 'f2')]);
      expect(out.merged).toEqual([]);
      expect(out.kept).toEqual([expect.objectContaining({ reason: KEPT_REASONS.CORPUS_TOO_SMALL, against: ['f1'] })]);
    }
    // two prior findings and a candidate make three: weighed, so the same pair that merges among five is scored (0.37 here)
    const three = match([prior('LOOP', 'f1'), prior('CACHE', 'f2')], [cand('LOOP_AGAIN', 'f3')]);
    expect(three.kept).toEqual([]);
    expect(three.merged.map((m) => [m.candidate.id, m.entry.id])).toEqual([['f3', 'f1']]);
    expect(near(three.merged[0].similarity, 0.37)).toBe(true);
  });

  test('three findings are the least that weigh words: 0.37 for the pair that merges at 0.54 among five; two findings are refused, whatever the two say', () => {
    expect(RESEMBLANCE_MIN_CORPUS).toBe(3);
    const findings = [prior('LOOP', 'f1'), prior('CACHE', 'f2'), cand('LOOP_AGAIN', 'f3')];
    expect(near(resemblanceOver(findings)(findings[2], findings[0]).similarity, 0.37)).toBe(true);
    const two = [findings[0], findings[2]];
    expect(resemblanceOver(two)(two[1], two[0])).toMatchObject({ comparable: false, why: 'corpus-too-small', similarity: 0 });
    // exact duplicates are one finding: three entries of two distinct findings are a corpus of two
    expect(resemblanceOver([findings[0], findings[0], findings[2]])(findings[2], findings[0]).why).toBe('corpus-too-small');
  });

  test('a corpus of fewer than three distinct findings (one, none, or no list at all) measures nothing and says so: never a similarity of 0 under another reason', () => {
    const only = prior('LOOP', 'f1');
    expect(resemblanceOver([only])(cand('LOOP_AGAIN', 'f2'), only)).toMatchObject({ comparable: false, why: 'corpus-too-small', similarity: 0 });
    expect(resemblanceOver([])(only, only).why).toBe('corpus-too-small');
    expect(resemblanceOver(null)(only, only).why).toBe('corpus-too-small');
    const out = matchRestatements({ candidates: [cand('LOOP_AGAIN', 'f2')], priors: asPriors([only]), corpus: [only], locate });
    expect(out.merged).toEqual([]);
    expect(out.kept).toEqual([expect.objectContaining({ reason: KEPT_REASONS.CORPUS_TOO_SMALL, against: ['f1'] })]);
  });

  test('a distinct pair that clears the bar on shared vocabulary but names no identifier in common stays a separate candidate: kept as no-shared-identifier, with the score that cleared the bar', () => {
    // the stream handler that drops the final frame and the one that sends it twice: two defects on one line, 0.54 alike, no code named in either claim
    const priors = [prior('LOOP', 'f1'), prior('CACHE', 'f2'), prior('RETRY', 'f3'), prior('LOCK', 'f4'), prior('DROP', 'f5')];
    const out = match(priors, [cand('RETRIED', 'f6')]);
    expect(out.merged).toEqual([]);
    expect(out.kept).toEqual([expect.objectContaining({ reason: KEPT_REASONS.NO_SHARED_IDENTIFIER, against: ['f5'] })]);
    expect(out.kept[0].similarity).toBeGreaterThanOrEqual(RESTATED_MIN_SIMILARITY);
    expect(near(out.kept[0].similarity, 0.54)).toBe(true);
  });

  test('a pair that names an identifier in common and clears the bar merges, and says which: the merge carries the identifiers that confirmed it', () => {
    const out = match([prior('LOOP', 'f1'), prior('CACHE', 'f2'), prior('RETRY', 'f3'), prior('LOCK', 'f4')], [cand('LOOP_AGAIN', 'f5'), cand('CACHE_AGAIN', 'f6'), cand('RETRY_AGAIN', 'f7'), cand('LOCK_AGAIN', 'f8')]);
    expect(out.merged.map((m) => m.shared)).toEqual([['items.length'], ['cacheKey'], ['retry()'], ['write()', 'release()']]);
  });

  test('an entry the bar and the signal both confirm is the one a candidate merges into: a second entry that clears the bar without a shared identifier is no ambiguity', () => {
    // LOOP_AGAIN names items.length, like LOOP; the second prior entry is LOOP's wording with the identifier spelled as words (so it clears the bar too) and names none
    const wordsOnly = prior('LOOP', 'f2', { failureMode: C.LOOP.said.replace(/`/g, '').replace(/items\.length/g, 'items length'), locationOrLink: 'med/a02.js:4-6' });
    const out = match([prior('LOOP', 'f1'), wordsOnly, prior('CACHE', 'f3'), prior('RETRY', 'f4'), prior('LOCK', 'f5')], [cand('LOOP_AGAIN', 'f6')]);
    expect(identifiersOf(wordsOnly, 'med/a02.js').size).toBe(0);
    expect(out.merged.map((m) => [m.candidate.id, m.entry.id])).toEqual([['f6', 'f1']]);
  });
});

describe('the second signal: a restatement must also name a code-like identifier the finding names (a heuristic, not a proof)', () => {
  test('what is an identifier: a call, snake_case, camelCase, a dotted name or a file name; never a plain word, a hyphenated compound, an acronym, an abbreviation or a number', () => {
    for (const token of ['retry()', 'write()', 'items.length()', 'LABEL_IDS', '_fixture', 'not_installed', 'cacheKey', 'dirnamePaths', 'xUnit', 'PascalCase', 'items.length', 'adapters.js', 'validate-all.js', 'Microsoft.Playwright.Xunit']) {
      expect([token, isIdentifier(token)]).toEqual([token, true]);
    }
    for (const token of ['retry', 'cache', 'Important', 'comment-stripped', 'end-to-end', 'JSON', 'E2E', 'README', 'e.g', 'i.e', 'v1.2', '1.5', '0.35', 'a_b', 'go()', '()', '_', '__', 'x.y']) {
      expect([token, isIdentifier(token)]).toEqual([token, false]);
    }
  });

  test('identifiersOf reads the claim, not the evidence; leaves out the cited file, the generic list and repeats; keeps the claim\'s spelling', () => {
    const finding = {
      failureMode: 'dirnamePaths in scripts/validate-all.js counts the line of stripComments, and stripComments again; GitHub and package.json are named too, and so are comment-stripped text and end-to-end runs',
      evidence: 'secretHelper() was run against the file',
    };
    expect([...identifiersOf(finding, 'scripts/validate-all.js').values()]).toEqual(['dirnamePaths', 'stripComments']);
    // the cited file is another file here: its name is an identifier of the claim
    expect([...identifiersOf(finding, 'src/other.js').values()]).toEqual(['dirnamePaths', 'validate-all.js', 'stripComments']);
    for (const generic of ['JavaScript', 'TypeScript', 'GitHub', 'GitLab', 'macOS', 'iOS', 'PostgreSQL', 'MongoDB', 'GraphQL', 'OpenAI', 'NaN', 'README.md', 'CHANGELOG.md', 'package.json', 'package-lock.json']) {
      expect([generic, identifiersOf({ failureMode: `${generic} is named here` }, 'a.js').size]).toEqual([generic, 0]);
    }
    for (const bad of [null, undefined, 'x', {}, { failureMode: 3 }, { failureMode: '  ' }]) expect(identifiersOf(bad, 'a.js').size).toBe(0);
  });

  test('sharedIdentifiers: the names both claims use, compared without case, in the first claim\'s spelling and order; none when one claim names nothing', () => {
    const a = { failureMode: 'cacheKey and readManifest and the _fixture field' };
    const b = { failureMode: 'CacheKey is wrong, and so is _FIXTURE, but readManifest is fine' };
    expect(sharedIdentifiers(a, b, 'a.js')).toEqual(['cacheKey', 'readManifest', '_fixture']);
    expect(sharedIdentifiers(b, a, 'a.js')).toEqual(['CacheKey', '_FIXTURE', 'readManifest']);
    expect(sharedIdentifiers(a, { failureMode: 'nothing code-like here at all' }, 'a.js')).toEqual([]);
    expect(sharedIdentifiers(a, null, 'a.js')).toEqual([]);
  });

  test('the record names the identifiers that confirmed the restatement, at most IDENTIFIERS_KEPT of them, and none when there are none', () => {
    const many = Array.from({ length: IDENTIFIERS_KEPT + 3 }, (_, k) => `name${k}Part`);
    expect(restatementRecord({ id: 'f5', failureMode: 'x', locationOrLink: 'a:1' }, 0.4, HEAD, many).sharedIdentifiers).toEqual(many.slice(0, IDENTIFIERS_KEPT));
    expect(restatementRecord({ id: 'f5', failureMode: 'x', locationOrLink: 'a:1' }, 0.4, HEAD, ['cacheKey']).sharedIdentifiers).toEqual(['cacheKey']);
    for (const none of [undefined, [], null]) expect(restatementRecord({ id: 'f5', failureMode: 'x', locationOrLink: 'a:1' }, 0.4, HEAD, none)).not.toHaveProperty('sharedIdentifiers');
  });
});

describe('what is never compared or never merged (fail closed)', () => {
  const ledger = () => [prior('LOOP', 'f1'), prior('CACHE', 'f2'), prior('RETRY', 'f3'), prior('LOCK', 'f4')];

  test('the same words on another file, or on lines that do not overlap, are never a restatement', () => {
    const elsewhere = cand('LOOP_AGAIN', 'f5', { locationOrLink: 'med/a03.js:5' });
    const apart = cand('LOOP_AGAIN', 'f6', { locationOrLink: 'med/a02.js:9' });
    const adjacent = cand('LOOP_AGAIN', 'f7', { locationOrLink: 'med/a02.js:6' });
    expect(match(ledger(), [elsewhere, apart, adjacent])).toEqual({ merged: [], kept: [] });
  });

  test('lines that overlap in a range do merge; a citation that names no file and line cannot be placed and does not', () => {
    const inRange = match(ledger(), [cand('LOOP_AGAIN', 'f5', { locationOrLink: 'med/a02.js:3-9' })]);
    expect(inRange.merged.map((m) => m.entry.id)).toEqual(['f1']);
    expect(match(ledger(), [cand('LOOP_AGAIN', 'f5', { locationOrLink: 'https://example.invalid/1' })])).toEqual({ merged: [], kept: [] });
    expect(match(ledger(), [cand('LOOP_AGAIN', 'f5', { locationOrLink: 'med/a02.js' })])).toEqual({ merged: [], kept: [] });
  });

  test('a candidate of another kind (Pre-existing, security), one that needs a person, or one too short to judge stays apart, each with its reason', () => {
    const preExisting = cand('LOOP_AGAIN', 'f5', { severity: 'pre-existing' });
    const security = cand('LOOP_AGAIN', 'f6', { security: true });
    const unsettled = cand('LOOP_AGAIN', 'f7', { uncertain: true });
    const short = cand('LOOP_AGAIN', 'f8', { failureMode: 'the loop on line 5 is wrong', evidence: '' });
    const out = match(ledger(), [preExisting, security, unsettled, short]);
    expect(out.merged).toEqual([]);
    expect(out.kept.map((k) => [k.candidate.id, k.reason])).toEqual([
      ['f5', KEPT_REASONS.DIFFERENT_KIND],
      ['f6', KEPT_REASONS.DIFFERENT_KIND],
      ['f7', KEPT_REASONS.UNSETTLED],
      ['f8', KEPT_REASONS.DIFFERENT_DESCRIPTION],
    ]);
  });

  test('anything the matcher cannot read merges nothing', () => {
    const candidates = [cand('LOOP_AGAIN', 'f5')];
    const priors = asPriors(ledger());
    for (const input of [{ candidates: null, priors, corpus: [], locate }, { candidates, priors: null, corpus: [], locate }, { candidates, priors, corpus: null, locate }, { candidates, priors, corpus: [], locate: null }]) {
      expect(matchRestatements(input)).toEqual({ merged: [], kept: [] });
    }
    expect(matchRestatements({ candidates: [null, 3], priors: [{ entry: null, locationOrLink: 'med/a02.js:5' }, null], corpus: [], locate })).toEqual({ merged: [], kept: [] });
  });

  test('the lines must OVERLAP: a candidate wholly above or below the finding, or only adjacent to it, is never compared; one that shares a boundary line is', () => {
    const at = (priorAt, candidateAt) => match([prior('LOOP', 'f1', { locationOrLink: priorAt }), prior('CACHE', 'f2'), prior('RETRY', 'f3'), prior('LOCK', 'f4')], [cand('LOOP_AGAIN', 'f5', { locationOrLink: candidateAt })]);
    const none = { merged: [], kept: [] };
    // a finding at line 5: a candidate above it, right above it, right below it, below it, or a range that ends right above or starts right below it
    for (const candidateAt of ['med/a02.js:2', 'med/a02.js:4', 'med/a02.js:6', 'med/a02.js:9', 'med/a02.js:1-4', 'med/a02.js:6-9']) expect([candidateAt, at('med/a02.js:5', candidateAt)]).toEqual([candidateAt, none]);
    // a finding at 5-8: the candidate's last line is the finding's first line, the candidate's first line is the finding's last line, and a range around it: each shares a line
    for (const candidateAt of ['med/a02.js:3-5', 'med/a02.js:8-10', 'med/a02.js:5', 'med/a02.js:8', 'med/a02.js:1-20']) expect([candidateAt, at('med/a02.js:5-8', candidateAt).merged.map((m) => m.entry.id)]).toEqual([candidateAt, ['f1']]);
    // and not one that stops a line short of it or starts a line after it
    for (const candidateAt of ['med/a02.js:2-4', 'med/a02.js:9-12', 'med/a02.js:1', 'med/a02.js:9']) expect([candidateAt, at('med/a02.js:5-8', candidateAt)]).toEqual([candidateAt, none]);
  });
});

describe('restatedBy: reading it, recording it, raising a severity with it', () => {
  const record = (id, over = {}) => ({ id, source: 'reviewer-s1-b', locationOrLink: 'med/a02.js:5', severity: 'important', failureMode: 'again', similarity: 0.5, headSha: HEAD, ...over });

  test('restatementsOf and restatedIds read defensively and name the raisers merged inside a restatement', () => {
    const entry = { id: 'f1', restatedBy: [record('f5'), record('f6', { mergedFrom: [{ id: 'f7' }, 'x', { id: 'f8' }] }), 'not-a-record', null, { source: 'no id' }] };
    expect(restatementsOf(entry).map((r) => r.id)).toEqual(['f5', 'f6']);
    expect(restatedIds(entry)).toEqual(['f5', 'f6', 'f7', 'f8']);
    for (const bad of [null, undefined, 'x', {}, { restatedBy: 'x' }, { restatedBy: {} }]) {
      expect(restatementsOf(bad)).toEqual([]);
      expect(restatedIds(bad)).toEqual([]);
    }
  });

  test('a record names who said it, where, how it was worded and how close it was; the evidence is bounded and the similarity rounded', () => {
    const long = { id: 'f5', reviewer: 'security-lane', locationOrLink: 'med/a02.js:5', severity: 'nit', failureMode: 'x', evidence: 'e'.repeat(EVIDENCE_KEPT + 50), mergedFrom: [{ id: 'f9', source: 'a', locationOrLink: 'l', secret: 'dropped' }, 7] };
    const made = restatementRecord(long, 0.456789, HEAD);
    expect(made).toMatchObject({ id: 'f5', source: 'security-lane', similarity: 0.46, headSha: HEAD, mergedFrom: [{ id: 'f9', source: 'a', locationOrLink: 'l' }] });
    expect(made.evidence).toHaveLength(EVIDENCE_KEPT + 3);
    expect(made.mergedFrom[0]).not.toHaveProperty('secret');
    expect(restatementRecord({ id: 'f5', failureMode: 'x', locationOrLink: 'a:1' }, 0.4, HEAD)).not.toHaveProperty('evidence');
  });

  test('absorbing records adds them, never twice for one id and head, and never mutates the entry', () => {
    const entry = { id: 'f1', severity: 'important', disposition: 'fix' };
    const frozen = JSON.stringify(entry);
    const once = absorbRestatements(entry, [record('f5')]);
    expect(JSON.stringify(entry)).toBe(frozen);
    expect(once.restatedBy).toEqual([record('f5')]);
    expect(absorbRestatements(once, [record('f5')])).toBe(once);
    expect(absorbRestatements(once, [record('f5', { headSha: 'b'.repeat(40) }), record('f6')]).restatedBy.map((r) => r.id)).toEqual(['f5', 'f5', 'f6']);
    expect(absorbRestatements(entry, [])).toBe(entry);
  });

  test('a more severe restatement raises the entry and drops the decision made about the lesser finding; an equal or lesser one never lowers it', () => {
    const nit = { id: 'f1', severity: 'nit', disposition: 'deferred', adjudication: { disposition: 'deferred' }, adjudicatedBy: 'o', reason: 'later', blocking: false };
    const raisedEntry = absorbRestatements(nit, [record('f5', { severity: 'important' })]);
    expect(raisedEntry).toMatchObject({ severity: 'important', disposition: 'fix' });
    for (const gone of ['adjudication', 'adjudicatedBy', 'reason', 'blocking']) expect(raisedEntry).not.toHaveProperty(gone);
    const important = { id: 'f1', severity: 'important', disposition: 'fix', adjudication: { disposition: 'fix' } };
    for (const severity of ['nit', 'important']) {
      const kept = absorbRestatements(important, [record('f5', { severity })]);
      expect(kept).toMatchObject({ severity: 'important', disposition: 'fix', adjudication: { disposition: 'fix' } });
    }
  });
});

describe('the delta steps: which prior findings a candidate may restate', () => {
  const ledger = () => [prior('LOOP', 'f1'), prior('CACHE', 'f2'), prior('RETRY', 'f3'), prior('LOCK', 'f4')];
  /** The fixed-finding check as `deriveCleared` answers it: every entry moved to this head, `reasons[id]` saying why it was kept (default: its lines were left alone). */
  const derive = (reasons = {}) => ({ ledger: entries }) => ({
    ok: true,
    ledger: entries.map((entry) => ({ ...entry, locationAsOf: HEAD })),
    kept: entries.filter((entry) => reasons[entry.id] !== 'cleared').map((entry) => ({ id: entry.id, reason: reasons[entry.id] || 'location-unchanged' })),
    cleared: entries.filter((entry) => reasons[entry.id] === 'cleared').map((entry) => ({ id: entry.id })),
  });
  const runOf = (entries) => ({ repoRoot: '/r', baseSha: 'b'.repeat(40), headSha: HEAD, lastReviewedSha: 'c'.repeat(40), priorRound: { ledger: entries }, prepared: {} });
  const through = (entries, fresh, deriveFn) => {
    const run = runOf(entries);
    const checked = checkPrior(run, fresh, deriveFn);
    return { checked, out: restatedPrior(run, fresh, checked) };
  };

  test('restatable: an open finding a round settled or left for want of a verifier; never a refuted, disputed, unbriefable, cleared, resolved, dismissed or class one, nor one with no raiser', () => {
    const open = prior('LOOP', 'f1');
    const unverified = prior('LOOP', 'f1', { verification: { outcome: 'unverified', reason: 'verifier-incomplete' } });
    expect(restatable(open)).toBe(true);
    expect(restatable(unverified)).toBe(true);
    const no = [
      prior('LOOP', 'f1', { verification: { outcome: 'filtered', reason: 'verifier-majority' } }),
      prior('LOOP', 'f1', { verification: { outcome: 'disputed' } }),
      prior('LOOP', 'f1', { verification: { outcome: 'unverified', reason: 'unbriefable' } }),
      prior('LOOP', 'f1', { verification: undefined }),
      prior('LOOP', 'f1', { cleared: true }),
      prior('LOOP', 'f1', { resolution: { reason: 'accepted' } }),
      prior('LOOP', 'f1', { disposition: 'not-applicable' }),
      prior('LOOP', 'f1', { adjudication: { disposition: 'duplicate' } }),
      prior('LOOP', 'f1', { kind: 'class' }),
      prior('LOOP', 'f1', { source: undefined }),
      null,
      'x',
    ];
    no.forEach((entry, index) => expect([index, restatable(entry)]).toEqual([index, false]));
  });

  test('checkPrior: asked once, and only when something needs it; a check that cannot run or answers wrongly is no check', () => {
    const fresh = [cand('LOOP_AGAIN', 'f5')];
    expect(checkPrior({ priorRound: null }, fresh, derive())).toBeNull();
    expect(checkPrior(runOf(ledger()), [], derive())).toBeNull();
    const ok = checkPrior(runOf(ledger()), fresh, derive({ f2: 'location-moved', f3: 'cleared' }));
    expect(ok).toMatchObject({ ok: true });
    expect(ok.why.get('f1')).toBe('location-unchanged');
    expect(ok.why.get('f2')).toBe('location-moved');
    expect([...ok.cleared]).toEqual(['f3']);
    expect(checkPrior(runOf(ledger()), fresh, null)).toEqual({ ok: false, reason: 'fixed-finding-check-unavailable' });
    expect(checkPrior(runOf(ledger()), fresh, () => { throw new Error('git failed'); })).toEqual({ ok: false, reason: 'fixed-finding-check-unavailable: git failed' });
    expect(checkPrior(runOf(ledger()), fresh, () => ({ ok: true, ledger: [], kept: [], cleared: [] })).ok).toBe(false);
    expect(checkPrior(runOf(ledger()), fresh, () => ({ ok: false, reason: 'no git' }))).toEqual({ ok: false, reason: 'fixed-finding-check-unavailable: no git' });
  });

  test('a restatement leaves the candidates and its finding comes back as a candidate: the finding\'s own id, claim and line, no old verification, restatedBy naming the restater', () => {
    const fresh = [cand('LOOP_AGAIN', 'f5'), cand('PARSE', 'f6')];
    const entries = ledger();
    const before = JSON.stringify(entries);
    const { out } = through(entries, fresh, derive());
    expect(out.fresh.map((c) => c.id)).toEqual(['f6']);
    expect(out.merged).toEqual([{ id: 'f5', of: 'f1', source: 'reviewer-s1-b', locationOrLink: 'med/a02.js:5', severity: 'important', similarity: expect.any(Number), sharedIdentifiers: ['items.length'] }]);
    expect(out.kept).toEqual([]);
    expect(out.candidates).toHaveLength(1);
    const [back] = out.candidates;
    expect(back).toMatchObject({ id: 'f1', failureMode: C.LOOP.said, locationOrLink: 'med/a02.js:5', source: 'reviewer-s1-a' });
    for (const gone of ['verification', 'locationAsOf', 'cleared', 'headSha', 'carriedFrom']) expect(back).not.toHaveProperty(gone);
    expect(back.restatedBy).toEqual([expect.objectContaining({ id: 'f5', source: 'reviewer-s1-b', headSha: HEAD, failureMode: C.LOOP_AGAIN.said })]);
    // the prior ledger's entry is untouched: the step is pure
    expect(JSON.stringify(entries)).toBe(before);
    expect(out.candidates[0]).not.toBe(entries[0]);
  });

  test('only a finding the push left alone is matched: cleared, moved, re-reported or unplaceable ones are not, and the candidate stays a candidate', () => {
    for (const why of ['cleared', 'location-moved', 're-reported', 'not-placed', 'class']) {
      const fresh = [cand('LOOP_AGAIN', 'f5')];
      const { out } = through(ledger(), fresh, derive({ f1: why }));
      expect([why, out.merged, out.kept, out.candidates, out.fresh.map((c) => c.id)]).toEqual([why, [], [], [], ['f5']]);
    }
  });

  test('a refuted, unverified-for-another-reason or unattributed finding is never merged into, and no check means no merge', () => {
    const fresh = [cand('LOOP_AGAIN', 'f5')];
    for (const over of [{ verification: { outcome: 'filtered' } }, { verification: { outcome: 'unverified', reason: 'unbriefable' } }, { cleared: true }, { source: undefined }]) {
      const entries = [prior('LOOP', 'f1', over), prior('CACHE', 'f2'), prior('RETRY', 'f3'), prior('LOCK', 'f4')];
      const { out } = through(entries, fresh, derive());
      expect([over, out.merged, out.candidates]).toEqual([over, [], []]);
    }
    const run = runOf(ledger());
    for (const checked of [null, undefined, { ok: false, reason: 'x' }, {}]) expect(restatedPrior(run, fresh, checked)).toEqual({ fresh, candidates: [], merged: [], kept: [] });
    expect(restatedPrior({ priorRound: null }, fresh, { ok: true })).toEqual({ fresh, candidates: [], merged: [], kept: [] });
    expect(restatedPrior(run, [], checkPrior(run, [], derive()))).toEqual({ fresh: [], candidates: [], merged: [], kept: [] });
  });

  test('a candidate that is the finding\'s own claim again is a re-report, handled by the fixed-finding check, never a restatement', () => {
    const again = cand('LOOP', 'f5');
    const { out } = through(ledger(), [again], derive());
    expect(out.merged).toEqual([]);
    expect(out.kept).toEqual([]);
    expect(out.fresh).toEqual([again]);
  });

  test('a distinct defect on the same line stays a candidate and is named as kept; the restatement beside it merges', () => {
    const { out } = through(ledger(), [cand('LOCK_OTHER', 'f5'), cand('LOCK_AGAIN', 'f6')], derive());
    expect(out.merged.map((m) => [m.id, m.of])).toEqual([['f6', 'f4']]);
    expect(out.kept).toEqual([{ id: 'f5', reason: KEPT_REASONS.DIFFERENT_DESCRIPTION, against: ['f4'], similarity: expect.any(Number) }]);
    expect(out.fresh.map((c) => c.id)).toEqual(['f5']);
  });

  test('a new round\'s ids start after the ids restatements used too', () => {
    expect(idSeed([{ id: 'f1', restatedBy: [{ id: 'f11' }], mergedFrom: [{ id: 'f3' }] }, { id: 'f2' }])).toBe(11);
  });

  test('the ledger holds a restated finding once: the entry the round verified again replaces the prior one, with or without a fixed-finding check', () => {
    const entries = ledger();
    const reverified = prior('LOOP', 'f1', { verification: { outcome: 'present', reason: 'verifier-majority', tally: { real: 3, notReal: 0, expected: 3 } } });
    const run = { priorRound: { ledger: entries }, carry: { carried: [], carriedIds: [] }, restatements: { entries: ['f1'] }, candidates: [], headSha: HEAD };
    const unavailable = composeDeltaLedger(run, [reverified], null);
    expect(unavailable.ok).toBe(true);
    expect(unavailable.ledger.map((entry) => entry.id)).toEqual(['f2', 'f3', 'f4', 'f1']);
    // the same round with nothing restated would keep the prior entry and add the fresh one: a finding twice (the case the restated ids guard)
    const without = composeDeltaLedger({ ...run, restatements: { entries: [] } }, [reverified], null);
    expect(without.ledger.map((entry) => entry.id)).toEqual(['f1', 'f2', 'f3', 'f4', 'f1']);
    const answering = composeDeltaLedger(run, [reverified], ({ ledger: given }) => ({ ok: true, ledger: given, kept: given.map((entry) => ({ id: entry.id, reason: 'location-unchanged' })), cleared: [] }));
    expect(answering.ledger.map((entry) => entry.id)).toEqual(['f2', 'f3', 'f4', 'f1']);
  });
});

describe('what the other modules do with restatedBy', () => {
  const record = (id, source = 'reviewer-s1-b') => ({ id, source, locationOrLink: 'src/widget.js:12', severity: 'important', failureMode: 'said again', similarity: 0.5, headSha: HEAD });

  test('nobody verifies a defect they restated: the restating reviewer is a raiser of the finding, and a malformed record is a failed read', () => {
    expect(raisersOf({ source: 'Reviewer-S1-A', restatedBy: [record('f5', 'reviewer-s1-b'), { id: 'f6', reviewer: 'security-lane', mergedFrom: [{ id: 'f7', source: 'x' }] }] })).toEqual({ names: ['reviewer-s1-a', 'reviewer-s1-b', 'security-lane', 'x'], ok: true });
    expect(raisersOf({ source: 'a' })).toEqual({ names: ['a'], ok: true });
    for (const restatedBy of ['x', {}, [null], [1], [{ id: 'f5', mergedFrom: 'x' }], [{ id: 'f5', mergedFrom: [null] }]]) expect(raisersOf({ source: 'a', restatedBy }).ok).toBe(false);
  });

  const gateFinding = (over = {}) => ({ id: 'F-1', source: 'code-reviewer', locationOrLink: 'src/widget.js:12', severity: 'important', failureMode: 'unchecked input reaches the gate', disposition: 'fix', evidence: 'line 12 reads it', originalTextOrLink: 'https://example.invalid/pr/1#r1', ...over });
  const gateInput = (ledger) => ({
    headSha: HEAD,
    ledger,
    approvals: { ok: true, headSha: HEAD, satisfied: true, reason: 'required-approvals-present', tier: 'medium', humansRequired: 1, humansCounted: 1, approvedBy: ['h'], directedBy: null, ignored: [], refusals: [], reasons: [], warnings: [] },
    tier: { ok: true, tier: 'medium', effectiveTier: 'medium', humansRequired: 1, refusals: [], reasons: [], warnings: [] },
    description: { ok: true, missing: [], present: ['testing', 'risk', 'rollback'], empty: [], directedBy: null, agentAuthored: false, ready: true, warnings: [] },
    security: { status: 'clean', findings: [] },
    coverage: { status: 'complete', gaps: [] },
  });

  test('the gate names and counts what was merged into a finding it blocks on, and says nothing when nothing was', () => {
    const open = (result) => result.blockers.find((b) => b.code === BLOCKER_CODES.OPEN_IMPORTANT_FINDING);
    const plain = open(evaluateGate(gateInput([gateFinding()])));
    expect(plain.message).toBe('Important finding F-1 (src/widget.js:12) is still open');
    expect(plain).not.toHaveProperty('restatedBy');
    const one = open(evaluateGate(gateInput([gateFinding({ restatedBy: [record('F-9')] })])));
    expect(one.message).toBe('Important finding F-1 (src/widget.js:12) is still open (restated by 1 later candidate, merged into it: F-9)');
    expect(one.restatedBy).toEqual(['F-9']);
    const two = open(evaluateGate(gateInput([gateFinding({ restatedBy: [record('F-9'), record('F-10')] })])));
    expect(two.message).toContain('restated by 2 later candidates, merged into it: F-9, F-10');
    // a nit blocks nothing; a restatement that raised it to Important makes it an open Important finding the gate blocks on
    const nit = gateFinding({ severity: 'nit' });
    expect(open(evaluateGate(gateInput([nit])))).toBeUndefined();
    expect(open(evaluateGate(gateInput([absorbRestatements(nit, [record('F-9')])])))).toMatchObject({ findingId: 'F-1', restatedBy: ['F-9'] });
  });

  test('the bead names and counts the restatements in its description, and a finding with none reads as before', () => {
    const inputOf = (ledger) => ({ repo: 'Acme/Widgets', prNumber: 7, headSha: HEAD, ledger });
    const created = (ledger) => {
      const inp = inputOf(ledger);
      const held = Object.fromEntries(beadKeys(inp).keys.map((key) => [key, { ok: true, found: false }]));
      return planBeads(inp, held).actions.find((a) => a.action === 'create').create.description;
    };
    const plain = created([gateFinding()]);
    expect(plain).not.toMatch(/estated/);
    const text = created([gateFinding({ restatedBy: [record('F-9'), record('F-10', 'security-lane')] })]);
    expect(text).toContain('(restated by 2: F-9, F-10)');
    expect(text).toContain('Restated by 2 later candidates, merged into this finding');
    expect(text).toMatch(/- F-9 \(reviewer-s1-b, important at head a{40}\): said again/);
    expect(text).toMatch(/- F-10 \(security-lane, important at head a{40}\): said again/);
    expect(created([gateFinding({ restatedBy: [record('F-9')] })])).toContain('Restated by 1 later candidate, merged');
  });
});
