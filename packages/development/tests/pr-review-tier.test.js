'use strict';

/**
 * TRD-023: Tier assignment -- change kinds, sensitive floor and raise-only
 * (`pr-review-tier.js`).
 *
 * Validates PRD ACs: AC-012-1, AC-012-2, AC-012-3, AC-013-2, AC-013-3
 * (REQ-012, REQ-013, REQ-015). These are the Implementation AC tests; the
 * PRD-scenario tests live in TRD-023-TEST.
 *
 * What is pinned here:
 *   1. the tier comes from the KIND of change: docs, copy and
 *      additive-behind-flag are Low, ordinary product changes are Medium, and
 *      a sensitive or owner-listed High path is High whatever the classifier
 *      concluded (AC-012-1, AC-013-3);
 *   2. a missing, unknown or uncited kind is `other`, which is Medium -- a
 *      classifier that says nothing cannot buy a cheaper review;
 *   3. identical facts give an identical tier, whoever wrote the PR
 *      (AC-012-2);
 *   4. a second assessment raises the tier one level when it is exactly
 *      `true`, leaves it when exactly `false`, and raises on ANY other value
 *      (AC-012-3, fail toward more review);
 *   5. a proposed tier below the computed one is ignored, and only a
 *      CODEOWNERS-checked owner decision can lower a tier -- never below the
 *      sensitive floor (AC-013-2).
 *
 * Every rule has a negative control, so a gate that stopped grading is caught.
 */

const { assignTier, TIERS, LOW_KINDS, KINDS } = require('../lib/pr-review-tier');

const noPaths = { sensitive: [], high: [] };

// ---------------------------------------------------------------------------
// AC-012-1: the tier comes from the kind of change
// ---------------------------------------------------------------------------

describe('TRD-023 AC-012-1: the tier is assigned from the kind of change', () => {
  test('documentation, copy and additive-behind-flag changes are Low', () => {
    const result = assignTier({
      kinds: [
        { kind: 'docs', paths: ['README.md'] },
        { kind: 'copy', paths: ['src/strings.en.json'] },
        { kind: 'additive-behind-flag', paths: ['src/feature.js'] },
      ],
      paths: noPaths,
    });
    expect(result.ok).toBe(true);
    expect(result.tier).toBe('low');
    expect(result.reasons).toContain('all-kinds-low-risk');
  });

  test('an ordinary product change is Medium', () => {
    const result = assignTier({ kinds: [{ kind: 'product', paths: ['src/checkout.js'] }], paths: noPaths });
    expect(result.tier).toBe('medium');
    expect(result.reasons).toContain('product-change');
  });

  test('one product path among low-risk ones is enough for Medium', () => {
    const result = assignTier({
      kinds: [{ kind: 'docs', paths: ['README.md'] }, { kind: 'product', paths: ['src/checkout.js'] }],
      paths: noPaths,
    });
    expect(result.tier).toBe('medium');
  });

  test('a sensitive path is High whatever the classifier concluded (AC-013-3)', () => {
    const result = assignTier({
      kinds: [{ kind: 'docs', paths: ['.github/workflows/ci.yml'] }],
      paths: { sensitive: ['.github/workflows/ci.yml'], high: [] },
    });
    expect(result.tier).toBe('high');
    expect(result.reasons).toContain('sensitive-path');
    expect(result.floor).toBe('high');
  });

  test('an owner-listed High path is High', () => {
    const result = assignTier({
      kinds: [{ kind: 'docs', paths: ['src/billing.js'] }],
      paths: { sensitive: [], high: ['src/billing.js'] },
    });
    expect(result.tier).toBe('high');
    expect(result.reasons).toContain('owner-high-path');
  });

  test('a classifyPaths result can be passed straight in', () => {
    const classified = {
      ok: true,
      sensitive: ['.github/workflows/ci.yml'],
      high: [],
      prSensitive: true,
      paths: [{ path: '.github/workflows/ci.yml', sensitive: true }],
    };
    expect(assignTier({ kinds: [{ kind: 'docs', paths: ['.github/workflows/ci.yml'] }], paths: classified }).tier).toBe('high');
  });

  test('the closed sets are what the data model fixes', () => {
    expect(TIERS).toEqual(['low', 'medium', 'high']);
    expect(KINDS).toEqual(['docs', 'copy', 'additive-behind-flag', 'product', 'other']);
    expect(LOW_KINDS).toEqual(['docs', 'copy', 'additive-behind-flag']);
    expect(Object.isFrozen(TIERS) && Object.isFrozen(KINDS) && Object.isFrozen(LOW_KINDS)).toBe(true);
  });
});

describe('TRD-023: a missing, unknown or uncited kind is `other`, which is Medium', () => {
  test('an unknown kind word is other', () => {
    const result = assignTier({ kinds: [{ kind: 'refactor', paths: ['src/a.js'] }], paths: noPaths });
    expect(result.tier).toBe('medium');
    expect(result.reasons).toContain('unknown-kind');
    expect(result.kinds).toEqual([{ kind: 'other', declared: 'refactor', paths: ['src/a.js'] }]);
  });

  test('a kind record with no kind at all is other', () => {
    expect(assignTier({ kinds: [{ paths: ['src/a.js'] }], paths: noPaths }).tier).toBe('medium');
  });

  test('no classifier output at all is Medium, never Low', () => {
    for (const kinds of [[], undefined, null, 'docs', {}]) {
      const result = assignTier({ kinds, paths: noPaths });
      expect(result.tier).toBe('medium');
      expect(result.reasons).toContain('no-kinds-cited');
    }
  });

  test('a changed path no kind cited is other, so an all-docs claim cannot hide a product file', () => {
    const result = assignTier({
      kinds: [{ kind: 'docs', paths: ['README.md'] }],
      paths: { sensitive: [], high: [], paths: [{ path: 'README.md' }, { path: 'src/checkout.js' }] },
    });
    expect(result.tier).toBe('medium');
    expect(result.reasons).toContain('uncited-path');
    expect(result.uncitedPaths).toEqual(['src/checkout.js']);
  });

  test('negative control: when every changed path is cited, nothing is uncited', () => {
    const result = assignTier({
      kinds: [{ kind: 'docs', paths: ['README.md'] }],
      paths: { sensitive: [], high: [], paths: [{ path: 'README.md' }] },
    });
    expect(result.tier).toBe('low');
    expect(result.uncitedPaths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-012-2: the author never changes the tier
// ---------------------------------------------------------------------------

describe('TRD-023 AC-012-2: identical facts give an identical tier', () => {
  const facts = (author) => ({
    kinds: [{ kind: 'product', paths: ['src/checkout.js'] }],
    paths: noPaths,
    author,
  });

  test('two PRs with the same change from different authors get the same tier', () => {
    const mine = assignTier(facts('alice'));
    const theirs = assignTier(facts('bob'));
    const anonymous = assignTier(facts(undefined));
    expect(mine.tier).toBe(theirs.tier);
    expect(mine.reasons).toEqual(theirs.reasons);
    expect(anonymous.tier).toBe(mine.tier);
  });

  test('a maintainer login in the author field buys nothing', () => {
    expect(assignTier({ ...facts('trusted-maintainer'), maintainers: ['trusted-maintainer'] }).tier).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// AC-012-3: the second assessment raises the tier
// ---------------------------------------------------------------------------

describe('TRD-023 AC-012-3: a second assessment raises the tier one level', () => {
  const low = { kinds: [{ kind: 'docs', paths: ['README.md'] }], paths: noPaths };

  test('exactly true raises one level and records the raise with its reason', () => {
    const result = assignTier({
      ...low,
      secondAssessment: { needsAnotherPerson: true, reason: 'touches the release script indirectly', evidencePaths: ['scripts/release.js'] },
    });
    expect(result.tier).toBe('medium');
    expect(result.raised).toEqual([
      { from: 'low', to: 'medium', reason: 'touches the release script indirectly' },
    ]);
  });

  test('a Medium raised by a second assessment is High', () => {
    const result = assignTier({
      kinds: [{ kind: 'product', paths: ['src/a.js'] }],
      paths: noPaths,
      secondAssessment: { needsAnotherPerson: true, reason: 'subtle concurrency change' },
    });
    expect(result.tier).toBe('high');
  });

  test('High is already the top: a raise leaves it High', () => {
    const result = assignTier({
      kinds: [{ kind: 'product', paths: ['src/a.js'] }],
      paths: { sensitive: ['src/a.js'], high: [] },
      secondAssessment: { needsAnotherPerson: true, reason: 'also risky' },
    });
    expect(result.tier).toBe('high');
  });

  test('negative control: exactly false leaves the tier alone', () => {
    const result = assignTier({ ...low, secondAssessment: { needsAnotherPerson: false, reason: 'no' } });
    expect(result.tier).toBe('low');
    expect(result.raised).toEqual([]);
  });

  test('any other value is treated as true: the assessment fails toward more review', () => {
    for (const value of ['false', 'no', 0, 1, null, {}, [], undefined]) {
      const result = assignTier({ ...low, secondAssessment: { needsAnotherPerson: value } });
      expect(result.tier).toBe('medium');
      expect(result.raised[0].reason).toBe('second-assessment-unreadable');
    }
  });

  test('a second assessment that is not an object at all is ignored, not read as true', () => {
    expect(assignTier({ ...low, secondAssessment: undefined }).tier).toBe('low');
    expect(assignTier({ ...low, secondAssessment: null }).tier).toBe('low');
    expect(assignTier({ ...low, secondAssessment: 'needs another person' }).tier).toBe('medium');
    expect(assignTier({ ...low, secondAssessment: 'needs another person' }).warnings).toContain('invalid-second-assessment');
  });
});

// ---------------------------------------------------------------------------
// AC-013-2: raise-only; only a code owner can lower
// ---------------------------------------------------------------------------

describe('TRD-023 AC-013-2: a proposal may raise a tier, never lower it', () => {
  const product = { kinds: [{ kind: 'product', paths: ['src/a.js'] }], paths: noPaths };

  test('a proposal above the computed tier is accepted', () => {
    const result = assignTier({ ...product, proposedTier: 'high', proposedBy: { login: 'agent' } });
    expect(result.tier).toBe('high');
    expect(result.raised).toEqual([{ from: 'medium', to: 'high', reason: 'proposed-tier' }]);
  });

  test('negative control: a proposal below the computed tier is ignored and named', () => {
    const result = assignTier({ ...product, proposedTier: 'low', proposedBy: { login: 'the-author' } });
    expect(result.tier).toBe('medium');
    expect(result.ignored).toEqual([{ proposedTier: 'low', by: 'the-author', reason: 'lowering-needs-code-owner' }]);
  });

  test('a code-owner decision may lower a tier, and the decision is recorded', () => {
    const result = assignTier({
      ...product,
      proposedTier: 'low',
      proposedBy: { login: 'owner', isCodeOwner: true },
    });
    expect(result.tier).toBe('low');
    expect(result.lowered).toEqual([{ from: 'medium', to: 'low', by: 'owner' }]);
  });

  test('negative control: only an explicit, checked code-owner flag counts', () => {
    for (const by of [{ login: 'owner', isCodeOwner: 'true' }, { login: 'owner', isCodeOwner: 1 }, { login: 'owner' }, 'owner', undefined]) {
      expect(assignTier({ ...product, proposedTier: 'low', proposedBy: by }).tier).toBe('medium');
    }
  });

  test('not even a code owner may lower below the sensitive floor', () => {
    const result = assignTier({
      kinds: [{ kind: 'product', paths: ['.github/workflows/ci.yml'] }],
      paths: { sensitive: ['.github/workflows/ci.yml'], high: [] },
      proposedTier: 'medium',
      proposedBy: { login: 'owner', isCodeOwner: true },
    });
    expect(result.tier).toBe('high');
    expect(result.ignored).toEqual([
      { proposedTier: 'medium', by: 'owner', reason: 'sensitive-floor-holds' },
    ]);
  });

  test('an unreadable proposal is ignored, never applied', () => {
    for (const proposedTier of ['lowest', '', 5, {}, null]) {
      const result = assignTier({ ...product, proposedTier, proposedBy: { login: 'owner', isCodeOwner: true } });
      expect(result.tier).toBe('medium');
      if (proposedTier !== null && proposedTier !== '') expect(result.warnings).toContain('unknown-proposed-tier');
    }
  });
});

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------

describe('TRD-023: fail closed -- an unreadable request never buys a cheaper review', () => {
  test('a request it cannot read is High with ok false', () => {
    for (const bad of [null, undefined, 'medium', [], 7]) {
      const result = assignTier(bad);
      expect(result.ok).toBe(false);
      expect(result.tier).toBe('high');
      expect(result.reasons).toContain('invalid-input');
    }
  });

  test('a path classification it cannot read is High', () => {
    for (const paths of [null, 'none', { sensitive: 'ci.yml', high: [] }, { sensitive: [], high: [7] }]) {
      const result = assignTier({ kinds: [{ kind: 'docs', paths: ['README.md'] }], paths });
      expect(result.ok).toBe(false);
      expect(result.tier).toBe('high');
      expect(result.reasons).toContain('invalid-path-classification');
    }
  });

  test('a blocked classifyPaths result (ok:false) is High', () => {
    const blocked = { ok: false, reason: 'invalid-input', sensitive: [], high: [], prSensitive: true };
    const result = assignTier({ kinds: [{ kind: 'docs', paths: ['README.md'] }], paths: blocked });
    expect(result.tier).toBe('high');
    expect(result.reasons).toContain('path-classification-blocked');
  });

  test('a kind record whose paths are not a list of paths is other, not low', () => {
    for (const paths of ['README.md', [7], null]) {
      const result = assignTier({ kinds: [{ kind: 'docs', paths }], paths: noPaths });
      expect(result.tier).toBe('medium');
      expect(result.warnings).toContain('invalid-kind-paths');
    }
  });

  test('a kind record that is not an object at all is other', () => {
    expect(assignTier({ kinds: ['docs'], paths: noPaths }).tier).toBe('medium');
  });

  test('the result never reports a tier outside the closed set', () => {
    const samples = [
      assignTier(null),
      assignTier({ kinds: [{ kind: 'docs', paths: ['a.md'] }], paths: noPaths }),
      assignTier({ kinds: [{ kind: 'product', paths: ['a.js'] }], paths: noPaths }),
      assignTier({ kinds: [{ kind: 'product', paths: ['a.js'] }], paths: { sensitive: ['a.js'], high: [] } }),
    ];
    for (const sample of samples) expect(TIERS).toContain(sample.tier);
  });
});

describe('tierRecord humansRequired floor', () => {
  const { tierRecord } = require('../lib/pr-review-tier');
  const build = (humansRequired, word = 'high') => ({
    assignment: { ok: true, baseTier: word },
    effective: { tier: word, effectiveTier: word, humansRequired },
  });

  test('rejects NaN, negative and non-integer counts', () => {
    for (const bad of [NaN, -1, 1.5, '2', undefined]) expect(tierRecord(build(bad)).ok).toBe(false);
  });

  test('a count below the tier floor is raised to it', () => {
    const record = tierRecord(build(0));
    expect(record.ok).toBe(true);
    expect(record.humansRequired).toBe(2);
  });
});
