'use strict';

/**
 * The pairs the restatement bar was FITTED on (kata tmf5), committed so the fit can be re-derived and a change of the measure shows.
 *
 * tests/fixtures/pr-review-restated-fit-pairs.json holds every pair of findings that cite overlapping lines of one file (the
 * path:line and path:a-b grammar) in the review ledgers of this repository's own runs (the speedup measurement runs, the review of PR
 * 229, the runs of PR 207): 45 pairs of 7 ledgers, with every entry of each ledger (the corpus the measure weighs words over), each
 * pair's score, and a call: `same` (one defect in other words), `distinct` (another defect) or `unclear` (counted in neither). Every call
 * is a reading of the two claims' TEXT by whoever fitted the bar (the 14 distinct calls that had cited the in-round same-source rule were
 * re-read from the text in the second review round of PR 299; pr-207 f4~f16 is unclear). The bar was CHOSEN from these pairs, and so was
 * the second signal (a shared identifier, lib/pr-review-restated.js): this is fit data, not a held-out check, and the first live delta
 * round is the validation. The corpus is each pair's own ledger; the runner's corpus is the prior ledger plus the round's candidates,
 * so the same pair scores differently there (PR 291 f3/f5, a distinct pair, scores 0.22 over its own ledger and about 0.33 over a union
 * of 98 entries): the margin the bar has on this data is thinner on another corpus.
 */

const { resemblanceOver } = require('../lib/pr-review-ledger');
const { matchRestatements, sharedIdentifiers, RESTATED_MIN_SIMILARITY, KEPT_REASONS } = require('../lib/pr-review-restated');
const fit = require('./fixtures/pr-review-restated-fit-pairs.json');

const entryOf = (pair, which) => fit.ledgers[pair.ledger].find((entry) => String(entry.id) === String(pair.ids[which]));
const rescore = (pair) => resemblanceOver(fit.ledgers[pair.ledger])(entryOf(pair, 0), entryOf(pair, 1));
const fileOf = (pair) => /^([^:]+):/.exec(entryOf(pair, 0).locationOrLink)[1];
const called = (call) => fit.pairs.filter((pair) => pair.call === call);
const round2 = (value) => Math.round(value * 100) / 100;
const ledgerOf = (suffix) => Object.keys(fit.ledgers).find((name) => name.endsWith(suffix));
const locate = (location) => {
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(location);
  return m === null ? null : { file: m[1], start: Number(m[2]), end: Number(m[3] || m[2]) };
};
/** The restatement matcher on one pair: the first finding is the open entry, the second the candidate, the corpus the given findings. */
const matchPair = (pair, corpus) => matchRestatements({ candidates: [entryOf(pair, 1)], priors: [{ entry: entryOf(pair, 0), locationOrLink: entryOf(pair, 0).locationOrLink }], corpus, locate });

describe('the pairs the bar was fitted on: fit data, not held-out data (kata tmf5)', () => {
  test('the file holds 45 pairs of 7 ledgers, each pair\'s entries are in its ledger, and the bar it names is the shipped one', () => {
    expect(fit.pairs).toHaveLength(45);
    expect(Object.keys(fit.ledgers)).toHaveLength(7);
    expect(fit.bar).toBe(RESTATED_MIN_SIMILARITY);
    for (const pair of fit.pairs) {
      const ids = new Set(fit.ledgers[pair.ledger].map((entry) => String(entry.id)));
      expect(pair.ids.every((id) => ids.has(String(id)))).toBe(true);
    }
    expect([called('same').length, called('distinct').length, called('unclear').length]).toEqual([7, 35, 3]);
  });

  test('the labels are readings of the text: no distinct call rests on the same-source rule, and the one pair that may be two defects is unclear', () => {
    for (const pair of called('distinct')) {
      expect(pair.basis).toMatch(/^read from the two claims' text: another defect/);
      expect(pair.basis).not.toMatch(/in-round rule keeps/);
      expect(typeof pair.sameSource).toBe('boolean');
    }
    expect(called('distinct').filter((pair) => pair.sameSource)).toHaveLength(14);
    const [uncertain] = called('unclear').filter((pair) => pair.ids.join('~') === 'f4~f16');
    expect(uncertain.basis).toMatch(/may be one defect or two/);
  });

  test('every pair re-scores to its recorded score over its own ledger: a change of the measure breaks here, and the bar has to be argued again', () => {
    for (const pair of fit.pairs) {
      const look = rescore(pair);
      expect([pair.ledger, pair.ids, look.comparable]).toEqual([pair.ledger, pair.ids, pair.comparable]);
      expect(Math.abs(look.similarity - pair.score)).toBeLessThanOrEqual(0.002);
    }
  });

  test('the bar on its own fit data: no pair of distinct defects reaches it (the highest scores 0.29); five of the seven pairs of one defect do (0.42 to 0.51); one stays under it (0.32) and one the measure will not compare', () => {
    const distinct = called('distinct').map((pair) => rescore(pair).similarity);
    expect(Math.max(...distinct)).toBeLessThan(RESTATED_MIN_SIMILARITY);
    expect(Math.max(...distinct)).toBeGreaterThan(0.28);
    expect(Math.max(...distinct)).toBeLessThan(0.3);
    const same = called('same').map((pair) => ({ pair, look: rescore(pair) }));
    const merged = same.filter(({ look }) => look.comparable && look.similarity >= RESTATED_MIN_SIMILARITY);
    const under = same.filter(({ look }) => look.comparable && look.similarity < RESTATED_MIN_SIMILARITY);
    const refused = same.filter(({ look }) => !look.comparable);
    expect(merged.map(({ look }) => round2(look.similarity)).sort()).toEqual([0.42, 0.45, 0.46, 0.47, 0.51]);
    expect(under.map(({ look }) => round2(look.similarity)).sort()).toEqual([0.32]);
    expect(refused.map(({ pair }) => pair.ids.join('~'))).toEqual(['RC-2~RI-9']);
    // the bar sits between the highest distinct pair and the weakest pair of one defect that clears it
    expect(RESTATED_MIN_SIMILARITY - Math.max(...distinct)).toBeGreaterThan(0.05);
    expect(Math.min(...merged.map(({ look }) => look.similarity)) - RESTATED_MIN_SIMILARITY).toBeGreaterThan(0.07);
    // the unclear pair (f4~f16) scores 0.34, under the bar: it would not merge either way
    expect(round2(Math.max(...called('unclear').map((pair) => rescore(pair).similarity))) <= 0.34).toBe(true);
  });

  test('the second signal on the fit pairs: all 7 pairs of one defect and all 3 unclear pairs name a shared identifier, 8 of the 35 distinct pairs do and none of those clears the bar, so bar and signal merge 5 of 7 and 0 of 35', () => {
    const shared = (pair) => sharedIdentifiers(entryOf(pair, 0), entryOf(pair, 1), fileOf(pair));
    expect(called('same').filter((pair) => shared(pair).length > 0)).toHaveLength(7);
    expect(called('unclear').filter((pair) => shared(pair).length > 0)).toHaveLength(3);
    const distinctWith = called('distinct').filter((pair) => shared(pair).length > 0);
    expect(distinctWith).toHaveLength(8);
    expect(distinctWith.some((pair) => rescore(pair).comparable && rescore(pair).similarity >= RESTATED_MIN_SIMILARITY)).toBe(false);
    // the identifiers that carry the two measured restatements
    const measured = fit.pairs.filter((pair) => /pr-293/.test(pair.ledger));
    expect(measured.map((pair) => shared(pair).slice(0, 2)).sort()).toEqual([['dirnamePaths', 'stripComments'], ['dirnamePaths', 'stripComments']]);
    const both = called('same').filter((pair) => rescore(pair).comparable && rescore(pair).similarity >= RESTATED_MIN_SIMILARITY && shared(pair).length > 0);
    expect(both).toHaveLength(5);
  });

  test('the two measured restatements of run m2-pr293-re still merge through the matcher (f20 into f7 at 0.51, f21 into f10 at 0.42), with the identifiers that confirmed them named', () => {
    const measured = fit.pairs.filter((pair) => /pr-293/.test(pair.ledger));
    expect(measured.map((pair) => [pair.ids.join('~'), round2(pair.score)]).sort()).toEqual([['f21~f10', 0.42], ['f7~f20', 0.51]].sort());
    for (const pair of measured) {
      const out = matchPair(pair, fit.ledgers[pair.ledger]);
      expect(out.kept).toEqual([]);
      expect(out.merged).toHaveLength(1);
      expect(out.merged[0].entry.id).toBe(pair.ids[0]);
      expect(out.merged[0].shared).toEqual(expect.arrayContaining(['dirnamePaths', 'stripComments']));
    }
  });

  test('the pair the removed uniform fallback merged (RT-4 and RT-7 of PR 229: a missing test and an off-by-one title) stays apart: refused in a corpus of two, scored 0.29 in its own ledger', () => {
    const pair = fit.pairs.find((candidate) => candidate.ledger === ledgerOf('229.json') && candidate.ids.join('~') === 'RT-4~RT-7');
    expect(pair.call).toBe('distinct');
    const alone = matchPair(pair, [entryOf(pair, 0), entryOf(pair, 1)]);
    expect(alone.merged).toEqual([]);
    expect(alone.kept).toEqual([expect.objectContaining({ reason: KEPT_REASONS.CORPUS_TOO_SMALL, similarity: 0 })]);
    const inLedger = matchPair(pair, fit.ledgers[pair.ledger]);
    expect(inLedger.merged).toEqual([]);
    expect(inLedger.kept).toEqual([expect.objectContaining({ reason: KEPT_REASONS.DIFFERENT_DESCRIPTION })]);
    expect(round2(inLedger.kept[0].similarity)).toBe(0.29);
  });
});
