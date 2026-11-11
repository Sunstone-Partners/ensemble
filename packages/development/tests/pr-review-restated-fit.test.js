'use strict';

/**
 * The pairs the restatement bar was FITTED on (kata tmf5), committed so the fit can be re-derived and a change of the measure shows.
 *
 * tests/fixtures/pr-review-restated-fit-pairs.json holds every pair of findings that cite overlapping lines of one file (the
 * path:line and path:a-b grammar) in the review ledgers of this repository's own runs (the speedup measurement runs, the review of PR
 * 229, the runs of PR 207): 45 pairs of 7 ledgers, with every entry of each ledger (the corpus the measure weighs words over), each
 * pair's score, and a call: `same` (one defect in other words), `distinct` (another defect) or `unclear` (counted in neither). The
 * calls are the reading of whoever fitted the bar; the reviewer of PR 299 re-derived two of them (PR 292 f5/f6 the same, PR 291 f3/f5
 * distinct). The bar was CHOSEN from these pairs: this is the fit data, not a held-out check, and the first live delta round is the
 * validation. The corpus is each pair's own ledger; the runner's corpus is the prior ledger plus the round's candidates, so the same
 * pair scores differently there (PR 291 f3/f5, a distinct pair, scores 0.22 over its own ledger and about 0.33 over a union of 98
 * entries): the margin the bar has on this data is thinner on another corpus.
 */

const { resemblanceOver } = require('../lib/pr-review-ledger');
const { RESTATED_MIN_SIMILARITY } = require('../lib/pr-review-restated');
const fit = require('./fixtures/pr-review-restated-fit-pairs.json');

const rescore = (pair) => {
  const ledger = fit.ledgers[pair.ledger];
  const byId = new Map(ledger.map((entry) => [entry.id, entry]));
  return resemblanceOver(ledger)(byId.get(pair.ids[0]), byId.get(pair.ids[1]));
};
const called = (call) => fit.pairs.filter((pair) => pair.call === call);

describe('the pairs the bar was fitted on: fit data, not held-out data (kata tmf5)', () => {
  test('the file holds 45 pairs of 7 ledgers, each pair\'s entries are in its ledger, and the bar it names is the shipped one', () => {
    expect(fit.pairs).toHaveLength(45);
    expect(Object.keys(fit.ledgers)).toHaveLength(7);
    expect(fit.bar).toBe(RESTATED_MIN_SIMILARITY);
    for (const pair of fit.pairs) {
      const ids = new Set(fit.ledgers[pair.ledger].map((entry) => String(entry.id)));
      expect(pair.ids.every((id) => ids.has(String(id)))).toBe(true);
    }
    expect([called('same').length, called('distinct').length, called('unclear').length]).toEqual([8, 35, 2]);
  });

  test('every pair re-scores to its recorded score over its own ledger: a change of the measure breaks here, and the bar has to be argued again', () => {
    for (const pair of fit.pairs) {
      const look = rescore(pair);
      expect([pair.ledger, pair.ids, look.comparable]).toEqual([pair.ledger, pair.ids, pair.comparable]);
      expect(Math.abs(look.similarity - pair.score)).toBeLessThanOrEqual(0.002);
    }
  });

  test('the bar on its own fit data: no pair of distinct defects reaches it (the highest scores 0.29); five of the eight pairs of one defect do (0.42 to 0.51); two stay under it (0.34 and 0.32) and one the measure will not compare', () => {
    const distinct = called('distinct').map((pair) => rescore(pair).similarity);
    expect(Math.max(...distinct)).toBeLessThan(RESTATED_MIN_SIMILARITY);
    expect(Math.max(...distinct)).toBeGreaterThan(0.28);
    expect(Math.max(...distinct)).toBeLessThan(0.3);
    const same = called('same').map((pair) => ({ pair, look: rescore(pair) }));
    const merged = same.filter(({ look }) => look.comparable && look.similarity >= RESTATED_MIN_SIMILARITY);
    const under = same.filter(({ look }) => look.comparable && look.similarity < RESTATED_MIN_SIMILARITY);
    const refused = same.filter(({ look }) => !look.comparable);
    expect(merged.map(({ look }) => Math.round(look.similarity * 100) / 100).sort()).toEqual([0.42, 0.45, 0.46, 0.47, 0.51]);
    expect(under.map(({ look }) => Math.round(look.similarity * 100) / 100).sort()).toEqual([0.32, 0.34]);
    expect(refused.map(({ pair }) => pair.ids.join('~'))).toEqual(['RC-2~RI-9']);
    // the bar sits between the highest distinct pair and the weakest pair of one defect that clears it, and it leaves two of the eight under it
    expect(RESTATED_MIN_SIMILARITY - Math.max(...distinct)).toBeGreaterThan(0.05);
    expect(Math.min(...merged.map(({ look }) => look.similarity)) - RESTATED_MIN_SIMILARITY).toBeGreaterThan(0.07);
  });

  test('the two measured restatements of run m2-pr293-re are in the data: f20 of f7 (0.51) and f21 of f10 (0.42)', () => {
    const measured = fit.pairs.filter((pair) => /pr-293/.test(pair.ledger));
    expect(measured.map((pair) => [pair.ids.join('~'), Math.round(pair.score * 100) / 100]).sort()).toEqual([['f21~f10', 0.42], ['f7~f20', 0.51]].sort());
  });
});
