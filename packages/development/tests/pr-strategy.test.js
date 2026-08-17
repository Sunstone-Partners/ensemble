'use strict';

const {
  useStackedPrs,
  branchName,
  planPrActions,
  resolveBranchingStrategy,
  isUnsupportedForgeHost,
  resolvePrBackend,
  buildConsolidatedResolutionMessage,
} = require('../lib/pr-strategy');

describe('useStackedPrs', () => {
  test("returns true only for 'true' (case-insensitive)", () => {
    expect(useStackedPrs({ ENSEMBLE_USE_STACKED_PRS: 'true' })).toBe(true);
    expect(useStackedPrs({ ENSEMBLE_USE_STACKED_PRS: 'TRUE' })).toBe(true);
    expect(useStackedPrs({ ENSEMBLE_USE_STACKED_PRS: 'True' })).toBe(true);
  });

  test('returns false (default single PR) for anything else', () => {
    expect(useStackedPrs({})).toBe(false); // unset
    expect(useStackedPrs({ ENSEMBLE_USE_STACKED_PRS: '' })).toBe(false);
    expect(useStackedPrs({ ENSEMBLE_USE_STACKED_PRS: 'false' })).toBe(false);
    expect(useStackedPrs({ ENSEMBLE_USE_STACKED_PRS: '0' })).toBe(false);
    expect(useStackedPrs({ ENSEMBLE_USE_STACKED_PRS: 'yes' })).toBe(false);
    expect(useStackedPrs({ ENSEMBLE_USE_STACKED_PRS: undefined })).toBe(false);
  });

  test('does not throw when env is undefined', () => {
    expect(useStackedPrs()).toBe(false);
  });
});

describe('branchName', () => {
  test('stacked + prFormat → feature/<slug>-pr-N', () => {
    expect(
      branchName('my-trd', { prFormat: true, stacked: true, phaseN: 2 })
    ).toBe('feature/my-trd-pr-2');
  });

  test('stacked + legacy → feature/<slug>-phase-N', () => {
    expect(
      branchName('my-trd', { prFormat: false, stacked: true, phaseN: 2 })
    ).toBe('feature/my-trd-phase-2');
  });

  test('not stacked → feature/<slug> regardless of phaseN', () => {
    expect(
      branchName('my-trd', { prFormat: true, stacked: false, phaseN: 7 })
    ).toBe('feature/my-trd');
    expect(
      branchName('my-trd', { prFormat: false, stacked: false, phaseN: 1 })
    ).toBe('feature/my-trd');
  });
});

describe('planPrActions — STACKED + prFormat, 3 phases', () => {
  const phases = [
    { n: 1, title: 'Auth', shippableState: 'Users can log in' },
    { n: 2, title: 'Profiles', shippableState: 'Users can edit profiles' },
    { n: 3, title: 'Settings', shippableState: 'Users can change settings' },
  ];
  const actions = planPrActions({
    trdSlug: 'my-trd',
    prFormat: true,
    stacked: true,
    phases,
  });

  test('produces 3 phase-gates + 1 completion', () => {
    expect(actions).toHaveLength(4);
    expect(actions.slice(0, 3).every((a) => a.kind === 'phase-gate')).toBe(true);
    expect(actions[3].kind).toBe('completion');
  });

  test('phase 1: createPr, parent main, appends pr-2, title has "PR 1 —"', () => {
    const p1 = actions[0];
    expect(p1.createPr).toBe(true);
    expect(p1.parentBranch).toBe('main');
    expect(p1.branch).toBe('feature/my-trd-pr-1');
    expect(p1.appendNextBranch).toBe('feature/my-trd-pr-2');
    expect(p1.proposeTitle).toContain('PR 1 —');
    expect(p1.shippableState).toBe('Users can log in');
  });

  test('phase 2: parent pr-1, appends pr-3', () => {
    const p2 = actions[1];
    expect(p2.parentBranch).toBe('feature/my-trd-pr-1');
    expect(p2.appendNextBranch).toBe('feature/my-trd-pr-3');
    expect(p2.branch).toBe('feature/my-trd-pr-2');
    expect(p2.proposeTitle).toContain('PR 2 —');
  });

  test('phase 3: appendNextBranch null', () => {
    const p3 = actions[2];
    expect(p3.appendNextBranch).toBeNull();
    expect(p3.parentBranch).toBe('feature/my-trd-pr-2');
    expect(p3.branch).toBe('feature/my-trd-pr-3');
  });

  test('completion: no PR, summaryKind stacked', () => {
    const done = actions[3];
    expect(done.createPr).toBe(false);
    expect(done.summaryKind).toBe('stacked');
    expect(done.proposeTitle).toBeNull();
    expect(done.branch).toBeNull();
  });
});

describe('planPrActions — SINGLE, 3 phases', () => {
  const phases = [
    { n: 1, title: 'Auth', shippableState: 'Users can log in' },
    { n: 2, title: 'Profiles' },
    { n: 3, title: 'Settings' },
  ];
  const actions = planPrActions({
    trdSlug: 'my-trd',
    prFormat: true,
    stacked: false,
    phases,
    trdTitle: 'My TRD',
  });

  test('every phase-gate: no PR, single branch, null parent/append/title', () => {
    const gates = actions.filter((a) => a.kind === 'phase-gate');
    expect(gates).toHaveLength(3);
    gates.forEach((g) => {
      expect(g.createPr).toBe(false);
      expect(g.proposeTitle).toBeNull();
      expect(g.parentBranch).toBeNull();
      expect(g.appendNextBranch).toBeNull();
      expect(g.branch).toBe('feature/my-trd');
    });
  });

  test('completion: creates the single PR', () => {
    const done = actions[actions.length - 1];
    expect(done.kind).toBe('completion');
    expect(done.createPr).toBe(true);
    expect(done.branch).toBe('feature/my-trd');
    expect(done.summaryKind).toBe('single');
    expect(done.proposeTitle).toBe('feat(my-trd): My TRD');
  });

  test('completion title falls back to slug when trdTitle absent', () => {
    const a = planPrActions({
      trdSlug: 'my-trd',
      prFormat: true,
      stacked: false,
      phases: [{ n: 1, title: 'Auth' }],
    });
    const done = a[a.length - 1];
    expect(done.proposeTitle).toBe('feat(my-trd): my-trd');
  });
});

describe('planPrActions — STACKED + legacy (prFormat=false)', () => {
  const actions = planPrActions({
    trdSlug: 'my-trd',
    prFormat: false,
    stacked: true,
    phases: [
      { n: 1, title: 'One' },
      { n: 2, title: 'Two' },
    ],
  });

  test('proposeTitle uses "Phase N —"', () => {
    expect(actions[0].proposeTitle).toBe('feat(my-trd): Phase 1 — One');
    expect(actions[1].proposeTitle).toBe('feat(my-trd): Phase 2 — Two');
  });

  test('branches use -phase- prefix', () => {
    expect(actions[0].branch).toBe('feature/my-trd-phase-1');
    expect(actions[0].appendNextBranch).toBe('feature/my-trd-phase-2');
    expect(actions[1].branch).toBe('feature/my-trd-phase-2');
    expect(actions[1].parentBranch).toBe('feature/my-trd-phase-1');
  });
});

describe('planPrActions — empty phases', () => {
  test('stacked: only completion entry', () => {
    const actions = planPrActions({
      trdSlug: 'my-trd',
      prFormat: true,
      stacked: true,
      phases: [],
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('completion');
    expect(actions[0].summaryKind).toBe('stacked');
    expect(actions[0].createPr).toBe(false);
  });

  test('single: only completion entry', () => {
    const actions = planPrActions({
      trdSlug: 'my-trd',
      prFormat: true,
      stacked: false,
      phases: [],
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('completion');
    expect(actions[0].summaryKind).toBe('single');
    expect(actions[0].createPr).toBe(true);
  });

  test('does not throw when phases omitted entirely', () => {
    expect(() =>
      planPrActions({ trdSlug: 'my-trd', prFormat: true, stacked: true })
    ).not.toThrow();
  });
});

describe('resolveBranchingStrategy — TRD §1.3 precedence table', () => {
  test('unset + exit 0 → git-town, auto-detect, proceed', () => {
    expect(resolveBranchingStrategy({}, 0)).toEqual({
      strategy: 'git-town',
      source: 'auto-detect',
      action: 'proceed',
      message: null,
    });
  });

  test('unset + exit 1 → plain-git, auto-detect, proceed (silent)', () => {
    expect(resolveBranchingStrategy({}, 1)).toEqual({
      strategy: 'plain-git',
      source: 'auto-detect',
      action: 'proceed',
      message: null,
    });
  });

  test('unset + exit 2 → plain-git, auto-detect, warn once', () => {
    const result = resolveBranchingStrategy({}, 2);
    expect(result.strategy).toBe('plain-git');
    expect(result.source).toBe('auto-detect');
    expect(result.action).toBe('warn');
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
  });

  test('env=plain-git + exit 0 → plain-git, env, proceed (explicit always honored)', () => {
    expect(
      resolveBranchingStrategy({ ENSEMBLE_BRANCHING_STRATEGY: 'plain-git' }, 0)
    ).toEqual({ strategy: 'plain-git', source: 'env', action: 'proceed', message: null });
  });

  test('env=plain-git + exit 1 or 2 → plain-git, env, proceed regardless of git-town state', () => {
    for (const exitCode of [1, 2]) {
      expect(
        resolveBranchingStrategy({ ENSEMBLE_BRANCHING_STRATEGY: 'plain-git' }, exitCode)
      ).toEqual({ strategy: 'plain-git', source: 'env', action: 'proceed', message: null });
    }
  });

  test('env=git-town + exit 0 → git-town, env, proceed (explicit matches reality)', () => {
    expect(
      resolveBranchingStrategy({ ENSEMBLE_BRANCHING_STRATEGY: 'git-town' }, 0)
    ).toEqual({ strategy: 'git-town', source: 'env', action: 'proceed', message: null });
  });

  test('env=git-town + exit 1 → HALT (explicit request cannot be honored)', () => {
    const result = resolveBranchingStrategy({ ENSEMBLE_BRANCHING_STRATEGY: 'git-town' }, 1);
    expect(result.strategy).toBeNull();
    expect(result.source).toBe('env');
    expect(result.action).toBe('halt');
    expect(typeof result.message).toBe('string');
  });

  test('env=git-town + exit 2 → HALT (explicit request cannot be honored)', () => {
    const result = resolveBranchingStrategy({ ENSEMBLE_BRANCHING_STRATEGY: 'git-town' }, 2);
    expect(result.strategy).toBeNull();
    expect(result.source).toBe('env');
    expect(result.action).toBe('halt');
    expect(typeof result.message).toBe('string');
  });

  test('exit codes 3/4 are out of scope — halts defensively regardless of env', () => {
    for (const exitCode of [3, 4]) {
      expect(resolveBranchingStrategy({}, exitCode).action).toBe('halt');
      expect(
        resolveBranchingStrategy({ ENSEMBLE_BRANCHING_STRATEGY: 'plain-git' }, exitCode).action
      ).toBe('proceed'); // explicit plain-git still always wins, even here
    }
  });
});

describe('isUnsupportedForgeHost', () => {
  test('flags dev.azure.com URLs', () => {
    expect(isUnsupportedForgeHost('https://dev.azure.com/org/project/_git/repo')).toBe(true);
  });

  test('does not flag github.com, gitlab.com, or a self-hosted Bitbucket URL', () => {
    expect(isUnsupportedForgeHost('https://github.com/org/repo')).toBe(false);
    expect(isUnsupportedForgeHost('https://gitlab.com/org/repo')).toBe(false);
    expect(isUnsupportedForgeHost('https://bitbucket.mycompany.com/scm/org/repo.git')).toBe(false);
  });

  test('does not throw on unparseable input', () => {
    expect(isUnsupportedForgeHost('')).toBe(false);
    expect(isUnsupportedForgeHost(undefined)).toBe(false);
    expect(isUnsupportedForgeHost('not a url')).toBe(false);
  });
});

describe('resolvePrBackend', () => {
  const supportedHost = 'https://github.com/org/repo';
  const unsupportedHost = 'https://dev.azure.com/org/project/_git/repo';

  test.each(['gh', 'ado', 'manual'])(
    'ENSEMBLE_PR_BACKEND=%s honored on a supported host — env, no resolution needed',
    (backend) => {
      expect(resolvePrBackend({ ENSEMBLE_PR_BACKEND: backend }, supportedHost)).toEqual({
        backend,
        source: 'env',
        needsResolution: false,
      });
    }
  );

  test.each(['gh', 'ado', 'manual'])(
    'ENSEMBLE_PR_BACKEND=%s honored on an unsupported host too — explicit request always wins',
    (backend) => {
      expect(resolvePrBackend({ ENSEMBLE_PR_BACKEND: backend }, unsupportedHost)).toEqual({
        backend,
        source: 'env',
        needsResolution: false,
      });
    }
  );

  test('unset + supported host → gh, auto-detect, no resolution needed', () => {
    expect(resolvePrBackend({}, supportedHost)).toEqual({
      backend: 'gh',
      source: 'auto-detect',
      needsResolution: false,
    });
  });

  test('unset + unsupported host → null backend, auto-detect, needs resolution', () => {
    expect(resolvePrBackend({}, unsupportedHost)).toEqual({
      backend: null,
      source: 'auto-detect',
      needsResolution: true,
    });
  });

  test('unrecognized ENSEMBLE_PR_BACKEND value is treated as unset (falls through to auto-detect)', () => {
    expect(resolvePrBackend({ ENSEMBLE_PR_BACKEND: 'bogus' }, supportedHost)).toEqual({
      backend: 'gh',
      source: 'auto-detect',
      needsResolution: false,
    });
    expect(resolvePrBackend({ ENSEMBLE_PR_BACKEND: 'bogus' }, unsupportedHost)).toEqual({
      backend: null,
      source: 'auto-detect',
      needsResolution: true,
    });
  });
});

describe('buildConsolidatedResolutionMessage', () => {
  const defaultBranching = resolveBranchingStrategy({}, 0); // git-town, auto-detect, proceed
  const defaultBackend = resolvePrBackend({}, 'https://github.com/org/repo'); // gh, auto-detect

  test('pure-default case (both axes auto-detected to today\'s behavior) → null', () => {
    expect(buildConsolidatedResolutionMessage(defaultBranching, defaultBackend)).toBeNull();
  });

  test('branching fallback only (plain-git auto-detect) → one string naming both axes', () => {
    const branching = resolveBranchingStrategy({}, 1); // plain-git, auto-detect, proceed
    const message = buildConsolidatedResolutionMessage(branching, defaultBackend);
    expect(typeof message).toBe('string');
    expect(message).toContain("branching strategy resolved to 'plain-git' (auto-detect)");
    expect(message).toContain("PR backend resolved to 'gh' (auto-detect)");
  });

  test('backend prompt-needed only (unsupported host) → one string naming both axes', () => {
    const backend = resolvePrBackend({}, 'https://dev.azure.com/org/project/_git/repo');
    const message = buildConsolidatedResolutionMessage(defaultBranching, backend);
    expect(typeof message).toBe('string');
    expect(message).toContain("branching strategy resolved to 'git-town' (auto-detect)");
    expect(message).toContain('PR backend resolution needed');
  });

  test('both axes non-default (env override + unsupported host) → single consolidated string', () => {
    const branching = resolveBranchingStrategy({ ENSEMBLE_BRANCHING_STRATEGY: 'plain-git' }, 0);
    const backend = resolvePrBackend({}, 'https://dev.azure.com/org/project/_git/repo');
    const message = buildConsolidatedResolutionMessage(branching, backend);
    expect(typeof message).toBe('string');
    expect(message).toContain("branching strategy resolved to 'plain-git' (env)");
    expect(message).toContain('PR backend resolution needed');
    // exactly one message, not two separate ones
    expect(message.split('\n')).toHaveLength(1);
  });
});
