const crypto = require('crypto');
const { planCarry, normalizeClaim, REASONS, SETTLED_OUTCOMES } = require('../lib/pr-review-carry');
const { mergeFindings, clearFixedFindings } = require('../lib/pr-review-ledger');
const { scoreEval } = require('../lib/pr-review-eval');
const { simulateCarryRound, loadBaseline, loadCases, fileOf } = require('./helpers/carry-eval-round');

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const H3 = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const HUNK = sha('hunk');
const DEP = sha('dep');

const VOTES = [
  { verifier: 'verifier-1', verdict: 'present' },
  { verifier: 'verifier-2', verdict: 'present' },
];

/** One prior verdict at H1 and the one candidate that re-presents it at H2; nothing relevant changed, so it carries. */
function baseline() {
  return {
    headSha: H2,
    lastReviewedSha: H1,
    deltaPlan: { mode: 'delta' },
    deltaPaths: ['src/other.js'],
    highPaths: ['src/auth.js'],
    priorVerdicts: [
      {
        id: 'p1',
        file: 'src/a.js',
        claim: 'Null deref on empty input',
        hunkHash: HUNK,
        depHashes: { 'src/dep.js': DEP },
        head: H1,
        outcome: 'present',
        votes: VOTES,
      },
    ],
    candidates: [{ id: 'c1', file: 'src/a.js', claim: 'Null deref on empty input', hunkHash: HUNK, depHashes: { 'src/dep.js': DEP } }],
  };
}

/** The baseline with ONE condition flipped by `mutate`. */
function flipped(mutate) {
  const input = baseline();
  mutate(input);
  return input;
}

function expectOnlyReverify(input, reasons) {
  const result = planCarry(input);
  expect(result.ok).toBe(true);
  expect(result.carried).toEqual([]);
  expect(result.reverify).toHaveLength(1);
  expect(result.reverify[0].reasons).toEqual(reasons);
  return result;
}

describe('planCarry: the baseline carries (every flipped condition below starts from this)', () => {
  test('a verdict whose hunk, dependencies and head are unchanged is carried with the current head and its original head', () => {
    const result = planCarry(baseline());
    expect(result.ok).toBe(true);
    expect(result.reverify).toEqual([]);
    expect(result.unmatched).toEqual([]);
    expect(result.reasons).toEqual([]);
    expect(result.carried).toEqual([
      {
        id: 'c1',
        file: 'src/a.js',
        claim: 'Null deref on empty input',
        hunkHash: HUNK,
        depHashes: { 'src/dep.js': DEP },
        head: H2,
        carriedFrom: H1,
        outcome: 'present',
        votes: VOTES,
      },
    ]);
  });

  test('a `filtered` verdict carries too, and a carried record keeps its ORIGINAL head through a second carry', () => {
    const first = planCarry(flipped((input) => { input.priorVerdicts[0].outcome = 'filtered'; }));
    expect(first.carried).toHaveLength(1);
    expect(first.carried[0].outcome).toBe('filtered');
    const second = planCarry({ ...baseline(), headSha: H3, lastReviewedSha: H2, priorVerdicts: first.carried });
    expect(second.carried).toHaveLength(1);
    expect(second.carried[0].head).toBe(H3);
    expect(second.carried[0].carriedFrom).toBe(H1);
  });

  test('the candidate id wins, else the prior id is kept', () => {
    expect(planCarry(baseline()).carried[0].id).toBe('c1');
    expect(planCarry(flipped((input) => { delete input.candidates[0].id; })).carried[0].id).toBe('p1');
  });

  test('keys ignore a leading ./ and backslashes on the path, and case, punctuation and whitespace in the claim', () => {
    const input = flipped((i) => {
      i.priorVerdicts[0].file = './src/a.js';
      i.priorVerdicts[0].claim = 'NULL  deref -- on empty input!';
      i.candidates[0].file = 'src\\a.js';
    });
    const result = planCarry(input);
    expect(result.carried).toHaveLength(1);
    expect(result.reverify).toEqual([]);
  });

  test('upper-case hashes equal their lower-case spelling and a carried record is lower-cased', () => {
    const result = planCarry(flipped((i) => { i.candidates[0].hunkHash = HUNK.toUpperCase(); i.candidates[0].depHashes['src/dep.js'] = DEP.toUpperCase(); }));
    expect(result.carried).toHaveLength(1);
    expect(result.carried[0].hunkHash).toBe(HUNK);
    expect(result.carried[0].depHashes).toEqual({ 'src/dep.js': DEP });
  });

  test('an empty dependency map is "no dependencies" and carries', () => {
    const result = planCarry(flipped((i) => { i.priorVerdicts[0].depHashes = {}; i.candidates[0].depHashes = {}; }));
    expect(result.carried).toHaveLength(1);
  });

  test('a High path that exists but was not touched does not stop a carry', () => {
    expect(planCarry(flipped((i) => { i.highPaths = ['src/auth.js', 'src/other2.js']; })).carried).toHaveLength(1);
  });

  test('empty `incompleteVerifiers` is settled; the planner does not mutate its input', () => {
    const input = flipped((i) => { i.priorVerdicts[0].incompleteVerifiers = []; });
    const before = JSON.stringify(input);
    expect(planCarry(input).carried).toHaveLength(1);
    expect(JSON.stringify(input)).toBe(before);
  });

  test('normalizeClaim flattens case, punctuation and whitespace and refuses a claim with no words', () => {
    expect(normalizeClaim('  The   Foo, BAR!! ')).toBe('the foo bar');
    expect(normalizeClaim('!!!')).toBeNull();
    expect(normalizeClaim(undefined)).toBeNull();
  });

  test('SETTLED_OUTCOMES is exactly present and filtered', () => {
    expect([...SETTLED_OUTCOMES].sort()).toEqual(['filtered', 'present']);
  });
});

describe('AC1 range-not-delta: only a delta carries', () => {
  test.each([[{ mode: 'full' }], [{}], [undefined], [null], ['delta'], [{ mode: 'DELTA' }]])('deltaPlan %j carries nothing', (deltaPlan) => {
    const result = planCarry(flipped((i) => { i.deltaPlan = deltaPlan; }));
    expect(result.carried).toEqual([]);
    expect(result.reasons).toEqual([REASONS.RANGE_NOT_DELTA]);
    expect(result.reverify[0].reasons).toEqual([REASONS.RANGE_NOT_DELTA]);
  });
});

describe('AC1 head-unknown', () => {
  test.each([[undefined], [null], [''], ['abc'], ['g'.repeat(40)], [123], [{}]])('a verdict head of %j is head-unknown', (head) => {
    expectOnlyReverify(flipped((i) => { i.priorVerdicts[0].head = head; }), [REASONS.HEAD_UNKNOWN]);
  });

  test.each([[null], ['abc'], [42]])('a carriedFrom of %j is head-unknown', (carriedFrom) => {
    expectOnlyReverify(flipped((i) => { i.priorVerdicts[0].carriedFrom = carriedFrom; }), [REASONS.HEAD_UNKNOWN]);
  });

  test.each([[undefined], [null], ['abc'], ['']])('a current head of %j carries nothing and says head-unknown', (headSha) => {
    const result = planCarry(flipped((i) => { i.headSha = headSha; }));
    expect(result.carried).toEqual([]);
    expect(result.reasons).toContain(REASONS.HEAD_UNKNOWN);
    expect(result.reverify[0].reasons).toContain(REASONS.HEAD_UNKNOWN);
  });

  test.each([[undefined], [null], ['abc'], ['']])('a last reviewed head of %j carries nothing and says head-unknown', (lastReviewedSha) => {
    const result = planCarry(flipped((i) => { i.lastReviewedSha = lastReviewedSha; }));
    expect(result.carried).toEqual([]);
    expect(result.reasons).toContain(REASONS.HEAD_UNKNOWN);
  });

  test('a 64-hex object id is a head', () => {
    const long = 'e'.repeat(64);
    const result = planCarry(flipped((i) => { i.priorVerdicts[0].head = long; i.lastReviewedSha = long; }));
    expect(result.carried).toHaveLength(1);
  });
});

describe('AC1 head-not-last-reviewed', () => {
  test('a verdict confirmed on a head other than the delta start is not carried', () => {
    expectOnlyReverify(flipped((i) => { i.priorVerdicts[0].head = OTHER; }), [REASONS.HEAD_NOT_LAST_REVIEWED]);
  });

  test('a verdict from two heads back is not carried even when its hashes still match', () => {
    const round1 = planCarry(baseline());
    // round 2 carried it to H2; round 3's delta starts at H3, which this verdict was never confirmed on
    const result = planCarry({ ...baseline(), headSha: OTHER, lastReviewedSha: H3, priorVerdicts: round1.carried });
    expect(result.carried).toEqual([]);
    expect(result.reverify[0].reasons).toEqual([REASONS.HEAD_NOT_LAST_REVIEWED]);
  });

  test('the comparison ignores the case of the object id', () => {
    expect(planCarry(flipped((i) => { i.priorVerdicts[0].head = H1.toUpperCase(); })).carried).toHaveLength(1);
  });
});

describe('AC1 delta-paths-unreadable and high-paths-unreadable', () => {
  test.each([[undefined], [null], ['src/a.js'], [[1]], [['']], [[null]], [{}]])('deltaPaths %j carries nothing', (deltaPaths) => {
    const result = planCarry(flipped((i) => { i.deltaPaths = deltaPaths; }));
    expect(result.carried).toEqual([]);
    expect(result.reasons).toEqual([REASONS.DELTA_PATHS_UNREADABLE]);
    expect(result.reverify[0].reasons).toEqual([REASONS.DELTA_PATHS_UNREADABLE]);
  });

  test.each([[undefined], [null], ['src/auth.js'], [[1]], [['']], [{}]])('highPaths %j carries nothing', (highPaths) => {
    const result = planCarry(flipped((i) => { i.highPaths = highPaths; }));
    expect(result.carried).toEqual([]);
    expect(result.reasons).toEqual([REASONS.HIGH_PATHS_UNREADABLE]);
    expect(result.reverify[0].reasons).toEqual([REASONS.HIGH_PATHS_UNREADABLE]);
  });

  test('an empty delta and an empty High list are readable and carry', () => {
    expect(planCarry(flipped((i) => { i.deltaPaths = []; i.highPaths = []; })).carried).toHaveLength(1);
  });
});

describe('AC1 high-path-touched: nothing carries', () => {
  test('a High path in the delta sends EVERY candidate to reverify, including ones in untouched files', () => {
    const input = flipped((i) => {
      i.deltaPaths = ['src/auth.js'];
      i.priorVerdicts.push({ ...i.priorVerdicts[0], id: 'p2', file: 'src/b.js', claim: 'Other defect', hunkHash: sha('b') });
      i.candidates.push({ id: 'c2', file: 'src/b.js', claim: 'Other defect', hunkHash: sha('b'), depHashes: { 'src/dep.js': DEP } });
    });
    const result = planCarry(input);
    expect(result.carried).toEqual([]);
    expect(result.reverify.map((entry) => entry.id)).toEqual(['c1', 'c2']);
    for (const entry of result.reverify) expect(entry.reasons).toEqual([REASONS.HIGH_PATH_TOUCHED]);
    expect(result.reasons).toEqual([REASONS.HIGH_PATH_TOUCHED]);
  });

  test('the match ignores a ./ prefix on either side', () => {
    const result = planCarry(flipped((i) => { i.deltaPaths = ['./src/auth.js']; i.highPaths = ['src/auth.js']; }));
    expect(result.carried).toEqual([]);
    expect(result.reasons).toEqual([REASONS.HIGH_PATH_TOUCHED]);
  });
});

describe('AC1 new-candidate and candidate-unreadable', () => {
  test('a candidate with no prior verdict is verified; the one with a verdict still carries', () => {
    const input = flipped((i) => { i.candidates.push({ id: 'c2', file: 'src/new.js', claim: 'Brand new', hunkHash: sha('n'), depHashes: {} }); });
    const result = planCarry(input);
    expect(result.carried.map((record) => record.id)).toEqual(['c1']);
    expect(result.reverify).toEqual([{ id: 'c2', file: 'src/new.js', claim: 'Brand new', reasons: [REASONS.NEW_CANDIDATE] }]);
  });

  test('the same file with a different claim is a new candidate, not a carry of the old verdict', () => {
    const result = planCarry(flipped((i) => { i.candidates[0].claim = 'A different defect in the same file'; }));
    expect(result.carried).toEqual([]);
    expect(result.reverify[0].reasons).toEqual([REASONS.NEW_CANDIDATE]);
    expect(result.unmatched.map((entry) => entry.id)).toEqual(['p1']);
  });

  test('the same claim in a different file is a new candidate', () => {
    const result = planCarry(flipped((i) => { i.candidates[0].file = 'src/elsewhere.js'; }));
    expect(result.carried).toEqual([]);
    expect(result.reverify[0].reasons).toEqual([REASONS.NEW_CANDIDATE]);
  });

  test.each([
    ['no file', { file: undefined }],
    ['a blank file', { file: '  ' }],
    ['no claim', { claim: undefined }],
    ['a claim with no words', { claim: '--- !!!' }],
  ])('a candidate with %s is unreadable and never carried', (_name, patch) => {
    const result = planCarry(flipped((i) => { Object.assign(i.candidates[0], patch); }));
    expect(result.carried).toEqual([]);
    expect(result.reverify).toHaveLength(1);
    expect(result.reverify[0].reasons).toEqual([REASONS.CANDIDATE_UNREADABLE]);
  });

  test('two candidates with one key are both verified, even though a prior verdict matches that key', () => {
    const input = flipped((i) => { i.candidates.push({ ...i.candidates[0], id: 'c1-again', claim: 'null DEREF on empty input.' }); });
    const result = planCarry(input);
    expect(result.carried).toEqual([]);
    expect(result.reverify.map((entry) => entry.id)).toEqual(['c1', 'c1-again']);
    for (const entry of result.reverify) expect(entry.reasons).toEqual([REASONS.CANDIDATE_UNREADABLE]);
  });
});

describe('AC1 ambiguous-prior-verdict', () => {
  test('two prior verdicts for one key: neither is trusted', () => {
    const input = flipped((i) => { i.priorVerdicts.push({ ...i.priorVerdicts[0], id: 'p1-dup', claim: 'null deref on empty input' }); });
    const result = planCarry(input);
    expect(result.carried).toEqual([]);
    expect(result.reverify[0].reasons).toEqual([REASONS.AMBIGUOUS_PRIOR_VERDICT]);
    expect(result.unmatched).toEqual([]);
  });
});

describe('AC1 verdict-not-settled', () => {
  test.each([['disputed'], ['unverified'], ['confirmed'], [undefined], [null], ['']])('an outcome of %j is not settled', (outcome) => {
    expectOnlyReverify(flipped((i) => { i.priorVerdicts[0].outcome = outcome; }), [REASONS.VERDICT_NOT_SETTLED]);
  });

  test.each([
    ['empty', []],
    ['absent', undefined],
    ['not a list', 'present'],
    ['a vote with no verifier', [{ verdict: 'present' }]],
    ['a vote with no verdict', [{ verifier: 'verifier-1' }]],
    ['a vote that is not an object', ['present']],
    ['a good vote beside a bad one', [{ verifier: 'v1', verdict: 'present' }, { verifier: '', verdict: 'present' }]],
  ])('votes that are %s are not settled', (_name, votes) => {
    expectOnlyReverify(flipped((i) => { i.priorVerdicts[0].votes = votes; }), [REASONS.VERDICT_NOT_SETTLED]);
  });

  test.each([[['verifier-3']], ['verifier-3'], [null], [{}]])('incompleteVerifiers %j is not settled', (incomplete) => {
    expectOnlyReverify(flipped((i) => { i.priorVerdicts[0].incompleteVerifiers = incomplete; }), [REASONS.VERDICT_NOT_SETTLED]);
  });
});

describe('AC1 hash-missing', () => {
  const BAD_HASHES = [[undefined], [null], [''], ['abc'], ['z'.repeat(64)], [HUNK.slice(1)], [HUNK + 'a'], [123], [{}]];

  test.each(BAD_HASHES)('a prior hunkHash of %j is hash-missing', (hash) => {
    expectOnlyReverify(flipped((i) => { i.priorVerdicts[0].hunkHash = hash; }), [REASONS.HASH_MISSING]);
  });

  test.each(BAD_HASHES)('a candidate hunkHash of %j is hash-missing', (hash) => {
    expectOnlyReverify(flipped((i) => { i.candidates[0].hunkHash = hash; }), [REASONS.HASH_MISSING]);
  });

  test('two missing hunk hashes are not "equal": missing never matches missing', () => {
    expectOnlyReverify(flipped((i) => { delete i.priorVerdicts[0].hunkHash; delete i.candidates[0].hunkHash; }), [REASONS.HASH_MISSING]);
  });

  const BAD_DEPS = [
    [undefined],
    [null],
    ['src/dep.js'],
    [['src/dep.js']],
    [{ 'src/dep.js': null }],
    [{ 'src/dep.js': 'not-a-hash' }],
    [{ 'src/dep.js': DEP, 'src/other-dep.js': undefined }],
    [{ 'src/dep.js': DEP, 'src/other-dep.js': '' }],
  ];

  test.each(BAD_DEPS)('prior depHashes %j is hash-missing', (deps) => {
    expectOnlyReverify(flipped((i) => { i.priorVerdicts[0].depHashes = deps; }), [REASONS.HASH_MISSING]);
  });

  test.each(BAD_DEPS)('candidate depHashes %j is hash-missing', (deps) => {
    expectOnlyReverify(flipped((i) => { i.candidates[0].depHashes = deps; }), [REASONS.HASH_MISSING]);
  });

  test('a dependency with an unreadable hash on BOTH sides still does not carry', () => {
    expectOnlyReverify(
      flipped((i) => { i.priorVerdicts[0].depHashes = { 'src/dep.js': 'x' }; i.candidates[0].depHashes = { 'src/dep.js': 'x' }; }),
      [REASONS.HASH_MISSING]
    );
  });
});

describe('AC1 hunk-changed', () => {
  test('a different hunk hash is hunk-changed and nothing else', () => {
    expectOnlyReverify(flipped((i) => { i.candidates[0].hunkHash = sha('edited hunk'); }), [REASONS.HUNK_CHANGED]);
  });

  test('a one-character difference in the hash counts', () => {
    const edited = (HUNK[0] === 'f' ? '0' : 'f') + HUNK.slice(1);
    expectOnlyReverify(flipped((i) => { i.candidates[0].hunkHash = edited; }), [REASONS.HUNK_CHANGED]);
  });
});

describe('AC1 dependency-changed', () => {
  test('a dependency whose hash changed is dependency-changed and nothing else', () => {
    expectOnlyReverify(flipped((i) => { i.candidates[0].depHashes = { 'src/dep.js': sha('dep v2') }; }), [REASONS.DEPENDENCY_CHANGED]);
  });

  test('a dependency file among the changed paths, hashes equal, is dependency-changed', () => {
    expectOnlyReverify(flipped((i) => { i.deltaPaths = ['src/dep.js']; }), [REASONS.DEPENDENCY_CHANGED]);
  });

  test('the dependency / delta comparison ignores a ./ prefix', () => {
    expectOnlyReverify(flipped((i) => { i.deltaPaths = ['./src/dep.js']; }), [REASONS.DEPENDENCY_CHANGED]);
  });

  test('a dependency added since the verdict is dependency-changed', () => {
    expectOnlyReverify(
      flipped((i) => { i.candidates[0].depHashes = { 'src/dep.js': DEP, 'src/new-dep.js': sha('new') }; }),
      [REASONS.DEPENDENCY_CHANGED]
    );
  });

  test('a dependency removed since the verdict is dependency-changed', () => {
    expectOnlyReverify(flipped((i) => { i.candidates[0].depHashes = {}; }), [REASONS.DEPENDENCY_CHANGED]);
  });

  test('a dependency swapped for another with the same hash is a different set', () => {
    expectOnlyReverify(flipped((i) => { i.candidates[0].depHashes = { 'src/renamed-dep.js': DEP }; }), [REASONS.DEPENDENCY_CHANGED]);
  });

  test('a dependency the PRIOR verdict had that the delta touched is dependency-changed even when the candidate dropped it', () => {
    expectOnlyReverify(
      flipped((i) => { i.deltaPaths = ['src/dep.js']; i.candidates[0].depHashes = {}; }),
      [REASONS.DEPENDENCY_CHANGED]
    );
  });
});

describe('AC1 cited-file-in-delta', () => {
  test('the cited file among the changed paths is reverified even when every hash is equal', () => {
    expectOnlyReverify(flipped((i) => { i.deltaPaths = ['src/a.js']; }), [REASONS.CITED_FILE_IN_DELTA]);
  });

  test('the comparison ignores a ./ prefix on the changed path and on the candidate', () => {
    expectOnlyReverify(flipped((i) => { i.deltaPaths = ['./src/a.js']; }), [REASONS.CITED_FILE_IN_DELTA]);
    expectOnlyReverify(flipped((i) => { i.deltaPaths = ['src/a.js']; i.candidates[0].file = './src/a.js'; i.priorVerdicts[0].file = './src/a.js'; }), [REASONS.CITED_FILE_IN_DELTA]);
  });

  test('only the candidate whose file changed is reverified; the other carries', () => {
    const input = flipped((i) => {
      i.deltaPaths = ['src/b.js'];
      i.priorVerdicts.push({ ...i.priorVerdicts[0], id: 'p2', file: 'src/b.js', claim: 'Other defect' });
      i.candidates.push({ ...i.candidates[0], id: 'c2', file: 'src/b.js', claim: 'Other defect' });
    });
    const result = planCarry(input);
    expect(result.carried.map((record) => record.id)).toEqual(['c1']);
    expect(result.reverify.map((entry) => [entry.id, entry.reasons])).toEqual([['c2', [REASONS.CITED_FILE_IN_DELTA]]]);
  });
});

describe('unmatched prior verdicts and an unreadable request', () => {
  test('a prior verdict nobody re-presents is unmatched, never carried', () => {
    const result = planCarry(flipped((i) => { i.candidates = []; }));
    expect(result.carried).toEqual([]);
    expect(result.reverify).toEqual([]);
    expect(result.unmatched).toEqual([{ id: 'p1', file: 'src/a.js', claim: 'Null deref on empty input', reasons: [REASONS.NO_CURRENT_CANDIDATE] }]);
  });

  test.each([
    ['priorVerdicts missing', (i) => { delete i.priorVerdicts; }],
    ['priorVerdicts not a list', (i) => { i.priorVerdicts = 'p1'; }],
    ['a prior verdict that is not an object', (i) => { i.priorVerdicts.push('p2'); }],
    ['candidates missing', (i) => { delete i.candidates; }],
    ['a candidate that is null', (i) => { i.candidates.push(null); }],
  ])('%s is an unreadable request: ok false, nothing carried', (_name, mutate) => {
    const result = planCarry(flipped(mutate));
    expect(result.ok).toBe(false);
    expect(result.carried).toEqual([]);
    expect(result.reverify).toEqual([]);
  });

  test.each([[null], [undefined], ['x'], [[]]])('an input of %j is unreadable', (input) => {
    expect(planCarry(input).ok).toBe(false);
  });
});

describe('AC2 invariant over a generated grid', () => {
  const FACTORS = {
    mode: ['delta', 'full'],
    priorHead: [H1, OTHER],
    outcome: ['present', 'filtered', 'disputed'],
    votes: ['two', 'none'],
    hunk: ['same', 'different', 'missing'],
    deps: ['same', 'changed', 'added', 'missing'],
    citedInDelta: [false, true],
    depInDelta: [false, true],
    highTouched: [false, true],
  };

  function* grid() {
    const names = Object.keys(FACTORS);
    const walk = function* (index, chosen) {
      if (index === names.length) { yield { ...chosen }; return; }
      for (const value of FACTORS[names[index]]) { chosen[names[index]] = value; yield* walk(index + 1, chosen); }
    };
    yield* walk(0, {});
  }

  function build(f) {
    const input = baseline();
    input.deltaPlan = { mode: f.mode };
    input.priorVerdicts[0].head = f.priorHead;
    input.priorVerdicts[0].outcome = f.outcome;
    input.priorVerdicts[0].votes = f.votes === 'two' ? VOTES : [];
    if (f.hunk === 'different') input.candidates[0].hunkHash = sha('different');
    if (f.hunk === 'missing') delete input.candidates[0].hunkHash;
    if (f.deps === 'changed') input.candidates[0].depHashes = { 'src/dep.js': sha('changed dep') };
    if (f.deps === 'added') input.candidates[0].depHashes = { 'src/dep.js': DEP, 'src/more.js': sha('more') };
    if (f.deps === 'missing') delete input.candidates[0].depHashes;
    input.deltaPaths = ['src/unrelated.js'];
    if (f.citedInDelta) input.deltaPaths.push('src/a.js');
    if (f.depInDelta) input.deltaPaths.push('src/dep.js');
    if (f.highTouched) input.deltaPaths.push('src/auth.js');
    // a second, never-verified candidate: it must be verified in every cell
    input.candidates.push({ id: 'new', file: 'src/new.js', claim: 'A new defect', hunkHash: sha('new'), depHashes: {} });
    return input;
  }

  /** The invariant, written from the input alone (not from the factors that generated it). */
  function everyConditionHolds(input, record) {
    const prior = input.priorVerdicts.find((entry) => entry.id === 'p1');
    const candidate = input.candidates.find((entry) => entry.id === record.id);
    const delta = new Set(input.deltaPaths);
    const sameDeps = JSON.stringify(Object.entries(prior.depHashes).sort()) === JSON.stringify(Object.entries(candidate.depHashes || {}).sort());
    return (
      input.deltaPlan.mode === 'delta' &&
      prior.head === input.lastReviewedSha &&
      SETTLED_OUTCOMES.includes(prior.outcome) &&
      Array.isArray(prior.votes) && prior.votes.length > 0 &&
      typeof candidate.hunkHash === 'string' && prior.hunkHash === candidate.hunkHash &&
      sameDeps &&
      !delta.has(candidate.file) &&
      Object.keys(candidate.depHashes).every((dep) => !delta.has(dep)) &&
      !input.highPaths.some((high) => delta.has(high))
    );
  }

  test('whenever a record is carried every condition holds; each candidate is in exactly one of carried / reverify', () => {
    let cells = 0;
    let carriedCells = 0;
    for (const factors of grid()) {
      cells += 1;
      const input = build(factors);
      const result = planCarry(input);
      expect(result.ok).toBe(true);

      for (const record of result.carried) {
        carriedCells += 1;
        if (!everyConditionHolds(input, record)) throw new Error(`carried although a condition fails: ${JSON.stringify(factors)}`);
        expect(record.head).toBe(input.headSha);
        expect(record.carriedFrom).toBe(H1);
      }
      const places = input.candidates.map((candidate) => [result.carried, result.reverify].filter((list) => list.some((entry) => entry.id === candidate.id)).length);
      expect(places).toEqual(input.candidates.map(() => 1));
      expect(result.carried.length + result.reverify.length).toBe(input.candidates.length);
      expect(result.carried.some((record) => record.id === 'new')).toBe(false);
    }
    expect(cells).toBeGreaterThan(1000);
    // the grid is not vacuous: exactly the all-good cells carry (the converse of the invariant, for this grid)
    expect(carriedCells).toBe(
      FACTORS.outcome.filter((o) => SETTLED_OUTCOMES.includes(o)).length
    );
  });

  test('every cell where at least one factor is bad is reverified, and says why', () => {
    for (const factors of grid()) {
      const result = planCarry(build(factors));
      const good = factors.mode === 'delta' && factors.priorHead === H1 && factors.outcome !== 'disputed' && factors.votes === 'two' &&
        factors.hunk === 'same' && factors.deps === 'same' && !factors.citedInDelta && !factors.depInDelta && !factors.highTouched;
      const entry = result.reverify.find((candidate) => candidate.id === 'c1');
      if (good) expect(entry).toBeUndefined();
      else expect(entry.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe('AC3 interaction with mergeFindings and clearFixedFindings', () => {
  const finding = (id, file, line, headSha, extra = {}) => ({
    id,
    source: 'verifier',
    locationOrLink: `${file}:${line}`,
    severity: 'Important',
    failureMode: `failure of ${id}`,
    disposition: 'fix',
    evidence: `evidence for ${id}`,
    originalTextOrLink: `https://example.test/${id}`,
    headSha,
    ...extra,
  });
  const verdictOf = (f) => ({ outcome: 'present', votes: VOTES, hunk: sha(f.id) });

  // Four Important findings recorded at H1, each with a settled verdict.
  const FILES = { A: ['src/a.js', 10], B: ['src/b.js', 20], C: ['src/c.js', 30], D: ['src/d.js', 40] };
  const ledgerAtH1 = () => Object.entries(FILES).map(([id, [file, line]]) => { const f = finding(id, file, line, H1); return { ...f, verdict: verdictOf(f) }; });

  const priorOf = (f) => ({
    id: f.id,
    file: f.locationOrLink.split(':')[0],
    claim: f.failureMode,
    hunkHash: sha(f.id),
    depHashes: {},
    head: H1,
    outcome: 'present',
    votes: VOTES,
  });
  const candidateOf = (f) => ({ id: f.id, file: f.locationOrLink.split(':')[0], claim: f.failureMode, hunkHash: sha(f.id), depHashes: {} });

  /**
   * The fix push H2 changes: src/b.js (line 99, not the cited line 20), src/c.js (line 30, the cited line: fixed, nobody
   * re-reports it) and src/d.js (line 40: edited, the defect is still reported). src/a.js is untouched.
   * Candidates this round: A, B and D (C is gone).
   */
  function round() {
    const ledger = ledgerAtH1();
    const byId = Object.fromEntries(ledger.map((f) => [f.id, f]));
    const plan = planCarry({
      headSha: H2,
      lastReviewedSha: H1,
      deltaPlan: { mode: 'delta' },
      deltaPaths: ['src/b.js', 'src/c.js', 'src/d.js'],
      highPaths: [],
      priorVerdicts: ledger.map(priorOf),
      candidates: [byId.A, byId.B, byId.D].map(candidateOf),
    });
    // How the integrator applies a carry: the finding is stamped with the current head and where it was first settled.
    const stamped = ledger.map((f) => {
      const record = plan.carried.find((entry) => entry.id === f.id);
      return record === undefined ? f : { ...f, headSha: record.head, carriedFrom: record.carriedFrom };
    });
    const changedLocations = [{ path: 'src/b.js', lines: [99] }, { path: 'src/c.js', lines: [30] }, { path: 'src/d.js', lines: [40] }];
    // The verifiers re-confirm D; B's re-verification is still pending, so nobody has re-reported it.
    const reReported = [finding('D', 'src/d.js', 40, H2)];
    const cleared = clearFixedFindings({ ledger: stamped, changedLocations, headSha: H2, reReported });
    return { ledger, plan, stamped, cleared, changedLocations, reReported };
  }

  test('the planner splits the round as intended', () => {
    const { plan } = round();
    expect(plan.carried.map((r) => r.id)).toEqual(['A']);
    expect(plan.reverify.map((r) => r.id)).toEqual(['B', 'D']);
    expect(plan.unmatched.map((r) => r.id)).toEqual(['C']);
  });

  test('a carried finding is not re-opened by mergeFindings when the same finding is re-observed at the new head', () => {
    const { stamped } = round();
    const reObservation = finding('A', 'src/a.js', 10, H2, { disposition: undefined, evidence: 'seen again' });
    const merged = mergeFindings(stamped, [reObservation], H2);
    const a = merged.find((f) => f.id === 'A');
    expect(a.disposition).toBe('fix');
    expect(a.verdict).toEqual(verdictOf(a));
    expect(a.evidence).toBe('evidence for A');
    expect(a.carriedFrom).toBe(H1);
    expect(merged).toHaveLength(stamped.length);
  });

  test('why `head` is restamped: the same carried finding left at its old head IS re-opened and loses its verdict', () => {
    const { ledger } = round();
    const reObservation = finding('A', 'src/a.js', 10, H2, { disposition: undefined, evidence: 'seen again' });
    const merged = mergeFindings(ledger, [reObservation], H2);
    const a = merged.find((f) => f.id === 'A');
    expect(a.verdict).toBeUndefined();
    expect(a.disposition).toBeUndefined();
  });

  test('clearFixedFindings never clears a carried finding, even when the push touched its file', () => {
    const { stamped, changedLocations } = round();
    // widen the touched set to the carried finding's own cited line, as a hostile worst case
    const result = clearFixedFindings({ ledger: stamped, changedLocations: [...changedLocations, 'src/a.js:10'], headSha: H2 });
    expect(result.cleared).not.toContain('A');
    expect(result.findings.find((f) => f.id === 'A').cleared).toBeUndefined();
  });

  test('an unmatched finding whose line the push touched and nobody re-reported is cleared (explicit reconcile)', () => {
    const { cleared, plan } = round();
    expect(plan.unmatched.map((r) => r.id)).toContain('C');
    expect(cleared.ok).toBe(true);
    expect(cleared.cleared).toContain('C');
    expect(cleared.findings.find((f) => f.id === 'C')).toMatchObject({ cleared: true, clearedBy: H2 });
  });

  test('a reverify finding whose cited line the delta did not touch stays open', () => {
    const { cleared, plan } = round();
    expect(plan.reverify.map((r) => r.id)).toContain('B');
    expect(cleared.cleared).not.toContain('B');
    expect(cleared.findings.find((f) => f.id === 'B').cleared).toBeUndefined();
  });

  test('a reverify finding the verifiers re-report is not cleared; with nobody re-reporting it, it is', () => {
    const { stamped, changedLocations, reReported } = round();
    expect(clearFixedFindings({ ledger: stamped, changedLocations, headSha: H2, reReported }).cleared).not.toContain('D');
    expect(clearFixedFindings({ ledger: stamped, changedLocations, headSha: H2 }).cleared).toContain('D');
  });

  test('no finding is both carried and cleared, and each ends the round carried-with-verdict, in reverify, or cleared', () => {
    const { ledger, plan, cleared } = round();
    const carried = new Set(plan.carried.map((r) => r.id));
    const reverify = new Set([...plan.reverify, ...plan.unmatched].map((r) => r.id));
    const clearedIds = new Set(cleared.cleared);
    for (const id of carried) expect(clearedIds.has(id)).toBe(false);
    const outcomes = ledger.map((f) => {
      if (clearedIds.has(f.id)) return [f.id, 'cleared'];
      if (carried.has(f.id)) {
        const after = cleared.findings.find((g) => g.id === f.id);
        return [f.id, after.verdict && after.carriedFrom === H1 && after.headSha === H2 ? 'carried' : 'carried-without-verdict'];
      }
      return [f.id, reverify.has(f.id) ? 'reverify' : 'LOST'];
    });
    expect(Object.fromEntries(outcomes)).toEqual({ A: 'carried', B: 'reverify', C: 'cleared', D: 'reverify' });
  });
});

describe('AC4 quality guard simulation over the committed eval cases', () => {
  const baseline = loadBaseline();
  const cases = loadCases();
  const importantIds = Object.values(baseline.findingsByCase).flat().filter((f) => f.severity === 'Important').map((f) => f.id);

  const scoreOf = (findingsByCase) => scoreEval({ cases, findingsByCase });

  test('the baseline itself finds every committed case (so the comparison below is meaningful)', () => {
    const score = scoreOf(baseline.findingsByCase);
    expect(score.total.found).toBe(cases.length);
    expect(importantIds.length).toBeGreaterThanOrEqual(cases.length);
  });

  test('a push touching only unrelated files carries everything, and drops nothing', () => {
    const round = simulateCarryRound({ findingsByCase: baseline.findingsByCase, deltaPaths: ['packages/unrelated/other.js'] });
    expect(round.dropped).toEqual([]);
    expect(round.plan.reverify).toEqual([]);
    expect(round.plan.carried).toHaveLength(round.flat.length);
    expect(scoreOf(round.findingsByCase).total.found).toBe(cases.length);
  });

  test('a push touching the file of one case sends that case to reverify (never carried) and every Important finding survives', () => {
    const target = cases.find((c) => c.id.startsWith('pr233-f02'));
    const round = simulateCarryRound({ findingsByCase: baseline.findingsByCase, deltaPaths: [target.location.path], changedHunkFiles: [target.location.path] });
    const touched = round.flat.filter((f) => fileOf(f) === target.location.path).map((f) => f.id);
    expect(touched.length).toBeGreaterThan(0);
    for (const id of touched) {
      expect(round.plan.carried.map((r) => r.id)).not.toContain(id);
      expect(round.plan.reverify.find((r) => r.id === id).reasons).toEqual(expect.arrayContaining([REASONS.CITED_FILE_IN_DELTA, REASONS.HUNK_CHANGED]));
    }
    expect(round.plan.carried.length).toBeGreaterThan(0);
    expect(round.dropped).toEqual([]);
    for (const id of importantIds) {
      const inRound = [...round.plan.carried, ...round.plan.reverify].some((r) => r.id === id);
      expect(inRound).toBe(true);
    }
    expect(scoreOf(round.findingsByCase).total.found).toBe(cases.length);
  });

  test('a push that touches a High path reverifies every finding: nothing is carried and nothing is lost', () => {
    const round = simulateCarryRound({
      findingsByCase: baseline.findingsByCase,
      deltaPaths: ['REVIEW.md'],
      highPaths: ['REVIEW.md'],
    });
    expect(round.plan.carried).toEqual([]);
    expect(round.plan.reverify).toHaveLength(round.flat.length);
    expect(round.dropped).toEqual([]);
    expect(scoreOf(round.findingsByCase).total.found).toBe(cases.length);
  });

  test('a push that changes a case file with unchanged hashes still does not carry that file (cited-file-in-delta)', () => {
    // guards the helper itself: a round that changes a case's file must not report that case as carried
    const target = cases.find((c) => c.id.startsWith('pr228'));
    const round = simulateCarryRound({ findingsByCase: baseline.findingsByCase, deltaPaths: [target.location.path] });
    const carriedFiles = round.plan.carried.map((r) => r.file);
    expect(carriedFiles).not.toContain(target.location.path);
  });
});
