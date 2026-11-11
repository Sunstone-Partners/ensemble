'use strict';

/**
 * What the restatement confirmation (the resemblance bar AND a shared identifier, lib/pr-review-restated.js) merges that it should not
 * (kata tmf5): hand-written pairs of DISTINCT defects on the same lines, in tests/fixtures/pr-review-restated-synthetic-pairs.json.
 *
 * Three sets, each measured against the corpus of the reviewer's measurement (the PR 229 ledger of the fit pairs plus the pair):
 *   A  written by the reviewer of PR 299 (second round): distinct defects written to share vocabulary, no code identifier in a claim;
 *   B  written for the fix round: distinct defects in one function, each claim naming it, in the plain way a reviewer writes it;
 *   C  the worst case: set A with one function name added to both claims of each pair (shared vocabulary AND a shared identifier).
 * They are SYNTHETIC: they estimate a rate and prove nothing about real reviews. What they show is the residual of a heuristic: the
 * identifier signal removes every pair that names no code (A: 6 clear the bar, 0 merge), and cannot separate two defects that name the
 * same function (B: 1 of 10 merges, the cacheKey pair; C: 7 of 10). The residual is stated in the guide, the module header and the CHANGELOG.
 */

const { resemblanceOver } = require('../lib/pr-review-ledger');
const { matchRestatements, sharedIdentifiers, RESTATED_MIN_SIMILARITY } = require('../lib/pr-review-restated');
const fit = require('./fixtures/pr-review-restated-fit-pairs.json');
const synthetic = require('./fixtures/pr-review-restated-synthetic-pairs.json');

const corpusBase = fit.ledgers[Object.keys(fit.ledgers).find((name) => /229/.test(name))];
const mk = (id, text, source) => ({ id, source, severity: 'important', locationOrLink: 'med/a02.js:40-44', failureMode: text, evidence: text });
const locate = (location) => {
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(location);
  return m === null ? null : { file: m[1], start: Number(m[2]), end: Number(m[3] || m[2]) };
};
/** The pair run as the runner would: the first claim is the open entry, the second the candidate. */
function measure(pair) {
  const a = mk('a', pair.a, 'reviewer-s1-a');
  const b = mk('b', pair.b, 'reviewer-s2-b');
  const corpus = [...corpusBase, a, b];
  const look = resemblanceOver(corpus)(b, a);
  const out = matchRestatements({ candidates: [b], priors: [{ entry: a, locationOrLink: a.locationOrLink }], corpus, locate });
  return { score: look.similarity, bar: look.comparable && look.similarity >= RESTATED_MIN_SIMILARITY, shared: sharedIdentifiers(b, a, 'med/a02.js'), merged: out.merged.length === 1 };
}
const setOf = (name) => synthetic.sets.find((set) => set.name === name);
const count = (set, key) => set.pairs.filter((pair) => pair[key] === true || (Array.isArray(pair[key]) && pair[key].length > 0)).length;

describe('synthetic pairs of distinct defects: the residual false merges of the bar and the identifier signal (kata tmf5)', () => {
  test('every pair is called distinct, and re-measures to the recorded score, bar result, identifiers and merge', () => {
    expect(synthetic.sets.map((set) => [set.name, set.pairs.length])).toEqual([['A', 10], ['B', 10], ['C', 10]]);
    for (const set of synthetic.sets) {
      for (const pair of set.pairs) {
        const now = measure(pair);
        expect([set.name, pair.label, pair.call]).toEqual([set.name, pair.label, 'distinct']);
        expect(Math.abs(now.score - pair.score)).toBeLessThanOrEqual(0.002);
        expect([set.name, pair.label, now.bar, now.merged, now.shared.length > 0]).toEqual([set.name, pair.label, pair.bar, pair.merged, pair.shared.length > 0]);
      }
    }
  });

  test('set A (vocabulary shared, no identifier): 6 of 10 clear the bar on words alone, none names an identifier, so none merges', () => {
    const set = setOf('A');
    expect([count(set, 'bar'), count(set, 'shared'), count(set, 'merged')]).toEqual([6, 0, 0]);
    // the six that the bar alone would merge are kept apart as no-shared-identifier
    for (const pair of set.pairs.filter((candidate) => candidate.bar)) expect(pair.keptReason).toBe('no-shared-identifier');
  });

  test('set B (distinct defects in one named function): 1 of 10 clears the bar and merges, the cacheKey pair; all ten name an identifier, so the signal separates none of them', () => {
    const set = setOf('B');
    expect([count(set, 'bar'), count(set, 'shared'), count(set, 'merged')]).toEqual([1, 10, 1]);
    expect(set.pairs.filter((pair) => pair.merged).map((pair) => pair.label)).toEqual(['cacheKey: tenant vs case']);
  });

  test('set C (the worst case: vocabulary AND a function name shared): 7 of 10 clear the bar, all name an identifier, and 7 merge: the residual a heuristic leaves', () => {
    const set = setOf('C');
    expect([count(set, 'bar'), count(set, 'shared'), count(set, 'merged')]).toEqual([7, 10, 7]);
  });
});
