'use strict';

/**
 * TRD-017: Depth bounds and slice planner (`pr-review-depth.js`).
 *
 * Validates PRD ACs: AC-016-1, AC-016-3, AC-018-1, AC-018-2 (REQ-016,
 * REQ-018). These are the Implementation AC tests; the PRD-scenario tests
 * live in TRD-017-TEST.
 *
 * What is pinned here:
 *   1. the mode defaults from the tier -- Low=Quick, Medium=Standard,
 *      High=Deep -- and while Low is treated as Medium (REQ-013) a Low PR
 *      gets Standard; an explicit request wins (AC-016-3);
 *   2. Quick is a ceiling (one reviewer, no verifier) and Standard and Deep
 *      are floors (at least two reviewers, 3 and 5 verifiers): planned or
 *      used counts outside the mode's bound are reported as violations
 *      (AC-016-1);
 *   3. a PR above the slice threshold is split on sensitive-area and rules
 *      boundaries, and every changed path lands in exactly one slice
 *      (AC-018-1);
 *   4. verifyCoverage names every path that no reviewed slice covered
 *      (AC-018-2).
 *
 * Fail closed: an unreadable request never resolves to the cheapest mode,
 * never reports zero violations and never reports full coverage.
 */

const {
  resolveDepth,
  checkBounds,
  planSlices,
  verifyCoverage,
  MODES,
  DEFAULT_BOUNDS,
  DEFAULT_SLICE_THRESHOLD,
} = require('../lib/pr-review-depth');

// ---------------------------------------------------------------------------
// AC-016-3: the mode defaults from the tier
// ---------------------------------------------------------------------------

describe('TRD-017 AC-016-3: depth defaults from the tier', () => {
  test('Medium is Standard and High is Deep', () => {
    expect(resolveDepth({ tier: 'medium' }).mode).toBe('standard');
    expect(resolveDepth({ tier: 'high' }).mode).toBe('deep');
    expect(resolveDepth({ tier: 'HIGH' }).mode).toBe('deep');
  });

  test('a Low PR is treated as Medium, so it gets Standard, and the reason says so', () => {
    const result = resolveDepth({ tier: 'low' });
    expect(result.mode).toBe('standard');
    expect(result.tier).toBe('medium');
    expect(result.reasons).toContain('low-treated-as-medium');
  });

  test('Low is Quick only once the Low waiver is enabled', () => {
    const result = resolveDepth({ tier: 'low', lowWaiverEnabled: true });
    expect(result.mode).toBe('quick');
    expect(result.tier).toBe('low');
    expect(result.reasons).not.toContain('low-treated-as-medium');
  });

  test('negative control: a non-boolean waiver value does not enable the waiver', () => {
    for (const waiver of ['true', 1, {}, null]) {
      expect(resolveDepth({ tier: 'low', lowWaiverEnabled: waiver }).mode).toBe('standard');
    }
  });

  test('an effective tier, when one was recorded, is what the mode derives from', () => {
    expect(resolveDepth({ tier: 'low', effectiveTier: 'high' }).mode).toBe('deep');
    expect(resolveDepth({ tier: 'high', effectiveTier: 'medium' }).mode).toBe('standard');
  });

  test('an explicit request wins over the tier default', () => {
    const result = resolveDepth({ tier: 'medium', requested: 'deep' });
    expect(result.mode).toBe('deep');
    expect(result.source).toBe('requested');
    expect(resolveDepth({ tier: 'high', requested: 'quick' }).mode).toBe('quick');
    expect(resolveDepth({ tier: 'high', requested: 'quick' }).reasons).toContain('requested-below-tier-default');
  });

  test('negative control: an unreadable request is ignored and the tier default stands', () => {
    for (const requested of ['thorough', '', 'QUICK ', 5, {}, null]) {
      const result = resolveDepth({ tier: 'medium', requested });
      expect(result.mode).toBe('standard');
      if (requested !== null && requested !== undefined && requested !== '') {
        expect(result.warnings).toContain('unknown-requested-mode');
      }
    }
    expect(resolveDepth({ tier: 'medium', requested: 'QUICK' }).mode).toBe('quick');
  });

  test('fail closed: an unknown or unreadable tier gets the deepest review, not the cheapest', () => {
    for (const tier of [undefined, null, '', 'unknown', 7, {}, ' low']) {
      const result = resolveDepth({ tier });
      expect(result.mode).toBe('deep');
      expect(result.ok).toBe(false);
      expect(result.reasons).toContain('unknown-tier');
    }
    expect(resolveDepth(null).mode).toBe('deep');
    expect(resolveDepth('medium').mode).toBe('deep');
  });

  test('the three modes are the closed set', () => {
    expect(MODES).toEqual(['quick', 'standard', 'deep']);
    expect(Object.isFrozen(MODES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-016-1: bounds on reviewers and verifiers
// ---------------------------------------------------------------------------

describe('TRD-017 AC-016-1: each mode bounds its reviewers and verifiers', () => {
  test('the default bounds are the ones the PRD fixes', () => {
    expect(DEFAULT_BOUNDS.quick).toEqual({ reviewers: { min: 1, max: 1 }, verifiers: { min: 0, max: 0 } });
    expect(DEFAULT_BOUNDS.standard).toEqual({ reviewers: { min: 2, max: null }, verifiers: { min: 3, max: null } });
    expect(DEFAULT_BOUNDS.deep).toEqual({ reviewers: { min: 2, max: null }, verifiers: { min: 5, max: null } });
  });

  test('Quick is a ceiling: a second reviewer or any verifier is a violation', () => {
    const clean = checkBounds({ mode: 'quick', planned: { reviewers: 1, verifiers: 0 } });
    expect(clean.ok).toBe(true);
    expect(clean.violations).toEqual([]);

    const result = checkBounds({ mode: 'quick', planned: { reviewers: 2, verifiers: 1 } });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { set: 'planned', role: 'reviewers', kind: 'exceeds-maximum', bound: 1, count: 2 },
      { set: 'planned', role: 'verifiers', kind: 'exceeds-maximum', bound: 0, count: 1 },
    ]);
  });

  test('Standard and Deep are floors: too few reviewers or verifiers is a violation', () => {
    expect(checkBounds({ mode: 'standard', used: { reviewers: 2, verifiers: 3 } }).violations).toEqual([]);
    expect(checkBounds({ mode: 'standard', used: { reviewers: 1, verifiers: 3 } }).violations).toEqual([
      { set: 'used', role: 'reviewers', kind: 'below-minimum', bound: 2, count: 1 },
    ]);
    expect(checkBounds({ mode: 'deep', used: { reviewers: 2, verifiers: 4 } }).violations).toEqual([
      { set: 'used', role: 'verifiers', kind: 'below-minimum', bound: 5, count: 4 },
    ]);
    expect(checkBounds({ mode: 'deep', used: { reviewers: 3, verifiers: 7 } }).violations).toEqual([]);
  });

  test('planned and used are graded separately, and both are reported', () => {
    const result = checkBounds({ mode: 'standard', planned: { reviewers: 2, verifiers: 3 }, used: { reviewers: 2, verifiers: 0 } });
    expect(result.violations).toEqual([
      { set: 'used', role: 'verifiers', kind: 'below-minimum', bound: 3, count: 0 },
    ]);
  });

  test('a maintainer may redefine a mode, and the redefined bound is what is graded', () => {
    const bounds = { standard: { reviewers: { min: 3, max: null }, verifiers: { min: 3, max: null } } };
    expect(checkBounds({ mode: 'standard', used: { reviewers: 2, verifiers: 3 }, bounds }).violations).toEqual([
      { set: 'used', role: 'reviewers', kind: 'below-minimum', bound: 3, count: 2 },
    ]);
  });

  test('negative control: a redefinition that raises Quick above its ceiling is refused', () => {
    const bounds = { quick: { reviewers: { min: 1, max: 4 }, verifiers: { min: 0, max: 4 } } };
    const result = checkBounds({ mode: 'quick', used: { reviewers: 4, verifiers: 4 }, bounds });
    expect(result.ok).toBe(false);
    expect(result.warnings).toContain('quick-bound-exceeded');
    expect(result.violations.map((v) => v.kind)).toEqual(['exceeds-maximum', 'exceeds-maximum']);
  });

  test('fail closed: counts or a mode it cannot read are a violation, never a clean pass', () => {
    for (const request of [
      null,
      { mode: 'thorough', used: { reviewers: 2, verifiers: 3 } },
      { mode: 'standard' },
      { mode: 'standard', used: { reviewers: -1, verifiers: 3 } },
      { mode: 'standard', used: { reviewers: 2.5, verifiers: 3 } },
      { mode: 'standard', used: { reviewers: '2', verifiers: 3 } },
      { mode: 'standard', used: [2, 3] },
    ]) {
      const result = checkBounds(request);
      expect(result.ok).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-018-1: slicing a large PR by area
// ---------------------------------------------------------------------------

describe('TRD-017 AC-018-1: a large PR is split on area boundaries', () => {
  const areas = ['packages/development/lib', 'packages/git', 'docs'];
  const big = [
    { path: 'packages/development/lib/a.js', lines: 700 },
    { path: 'packages/development/lib/b.js', lines: 500 },
    { path: 'packages/git/commands/pr-merge.yaml', lines: 400 },
    { path: 'docs/guides/x.md', lines: 300 },
    { path: 'README.md', lines: 200 },
  ];

  test('the default threshold is 1500 changed lines', () => {
    expect(DEFAULT_SLICE_THRESHOLD).toBe(1500);
  });

  test('a PR at or below the threshold is one slice', () => {
    const result = planSlices({ paths: [{ path: 'a.js', lines: 10 }], areas });
    expect(result.ok).toBe(true);
    expect(result.sliced).toBe(false);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].paths).toEqual(['a.js']);
    expect(result.totalLines).toBe(10);
  });

  test('a PR above the threshold is split by area, each path in exactly one slice', () => {
    const result = planSlices({ paths: big, areas });
    expect(result.ok).toBe(true);
    expect(result.sliced).toBe(true);

    const assigned = result.slices.flatMap((slice) => slice.paths);
    expect(assigned.slice().sort()).toEqual(big.map((entry) => entry.path).sort());
    expect(new Set(assigned).size).toBe(assigned.length);

    const byArea = Object.fromEntries(result.slices.map((slice) => [slice.area, slice.paths]));
    expect(byArea['packages/development/lib']).toEqual([
      'packages/development/lib/a.js',
      'packages/development/lib/b.js',
    ]);
    expect(byArea['packages/git']).toEqual(['packages/git/commands/pr-merge.yaml']);
    expect(byArea.docs).toEqual(['docs/guides/x.md']);
    expect(byArea['']).toEqual(['README.md']);
    expect(result.uncovered).toEqual([]);
  });

  test('the longest matching area wins, so a nested area is its own slice', () => {
    const result = planSlices({
      paths: [
        { path: 'packages/development/lib/a.js', lines: 900 },
        { path: 'packages/development/commands/b.yaml', lines: 900 },
      ],
      areas: ['packages/development', 'packages/development/lib'],
    });
    const byArea = Object.fromEntries(result.slices.map((slice) => [slice.area, slice.paths]));
    expect(byArea['packages/development/lib']).toEqual(['packages/development/lib/a.js']);
    expect(byArea['packages/development']).toEqual(['packages/development/commands/b.yaml']);
  });

  test('slices carry a stable id and their line count, and the order is stable', () => {
    const first = planSlices({ paths: big, areas });
    const second = planSlices({ paths: big.slice().reverse(), areas });
    expect(first.slices.map((slice) => slice.id)).toEqual(second.slices.map((slice) => slice.id));
    const lib = first.slices.find((slice) => slice.area === 'packages/development/lib');
    expect(lib.lines).toBe(1200);
    expect(lib.id).toBe('packages/development/lib');
  });

  test('a configured threshold is honoured', () => {
    expect(planSlices({ paths: big, areas, threshold: 99999 }).sliced).toBe(false);
    expect(planSlices({ paths: [{ path: 'a.js', lines: 10 }], areas, threshold: 5 }).sliced).toBe(true);
  });

  test('negative control: an unreadable threshold falls back to the default with a warning', () => {
    for (const threshold of [0, -1, 'big', 1.5, {}]) {
      const result = planSlices({ paths: big, areas, threshold });
      expect(result.threshold).toBe(DEFAULT_SLICE_THRESHOLD);
      expect(result.warnings).toContain('invalid-threshold');
      expect(result.sliced).toBe(true);
    }
  });

  test('fail closed: paths it cannot read are refused, never planned as one safe slice', () => {
    for (const request of [
      null,
      { paths: 'all' },
      { paths: [null] },
      { paths: [{ path: '', lines: 1 }] },
      { paths: [{ path: 'a.js', lines: -1 }] },
      { paths: [{ path: 'a.js', lines: 'many' }] },
      { paths: [{ path: 'a.js', lines: 1 }], areas: [7] },
    ]) {
      const result = planSlices(request);
      expect(result.ok).toBe(false);
      expect(result.slices).toEqual([]);
      expect(result.reason).toBeTruthy();
    }
  });

  test('a duplicated path is refused rather than reviewed twice', () => {
    const result = planSlices({ paths: [{ path: 'a.js', lines: 1 }, { path: 'a.js', lines: 2 }] });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('a changed path appears more than once');
  });
});

// ---------------------------------------------------------------------------
// AC-018-2: coverage of the planned slices
// ---------------------------------------------------------------------------

describe('TRD-017 AC-018-2: verifyCoverage names every unreviewed path', () => {
  const plan = planSlices({
    paths: [
      { path: 'packages/development/lib/a.js', lines: 900 },
      { path: 'docs/x.md', lines: 900 },
    ],
    areas: ['packages/development/lib', 'docs'],
  });

  test('every slice reviewed means full coverage', () => {
    const result = verifyCoverage({ slices: plan.slices, reviewed: plan.slices.map((slice) => slice.id) });
    expect(result.ok).toBe(true);
    expect(result.covered).toBe(true);
    expect(result.uncovered).toEqual([]);
    expect(result.reviewedSlices).toEqual(['docs', 'packages/development/lib']);
  });

  test('negative control: an unreviewed slice leaves its paths uncovered and names the slice', () => {
    const result = verifyCoverage({ slices: plan.slices, reviewed: ['docs'] });
    expect(result.covered).toBe(false);
    expect(result.uncovered).toEqual(['packages/development/lib/a.js']);
    expect(result.unreviewedSlices).toEqual(['packages/development/lib']);
  });

  test('a changed path no slice holds is uncovered, even when every slice was reviewed', () => {
    const result = verifyCoverage({
      slices: plan.slices,
      reviewed: plan.slices.map((slice) => slice.id),
      changedPaths: ['packages/development/lib/a.js', 'docs/x.md', 'packages/git/new.yaml'],
    });
    expect(result.covered).toBe(false);
    expect(result.uncovered).toEqual(['packages/git/new.yaml']);
  });

  test('a reviewed id that belongs to no slice is reported, not quietly accepted', () => {
    const result = verifyCoverage({ slices: plan.slices, reviewed: [...plan.slices.map((s) => s.id), 'imaginary'] });
    expect(result.unknownReviewed).toEqual(['imaginary']);
  });

  test('fail closed: an unreadable request is never full coverage', () => {
    for (const request of [null, { slices: 'all', reviewed: [] }, { slices: plan.slices, reviewed: 'all' }, { slices: [null], reviewed: [] }]) {
      const result = verifyCoverage(request);
      expect(result.ok).toBe(false);
      expect(result.covered).toBe(false);
    }
  });

  test('no slices reviewed at all leaves every path uncovered', () => {
    const result = verifyCoverage({ slices: plan.slices, reviewed: [] });
    expect(result.covered).toBe(false);
    expect(result.uncovered.sort()).toEqual(['docs/x.md', 'packages/development/lib/a.js']);
  });
});
