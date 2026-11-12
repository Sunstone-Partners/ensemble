'use strict';

/**
 * TRD-041: Low-waiver evidence, effective tier and recorded decision
 * (`pr-review-tier.js`).
 *
 * Validates PRD ACs: AC-013-1, AC-013-4, AC-015-1, AC-015-2 (REQ-013,
 * REQ-015). These are the Implementation AC tests; the PRD-scenario tests
 * live in TRD-041-TEST.
 *
 * What is pinned here:
 *   1. a Low assigned tier is EFFECTIVELY Medium -- one human approval --
 *      until the evidence exists (at least 20 Low PRs over at least 30 days
 *      with zero reverts and zero incidents) AND a code owner enabled the
 *      waiver; with both, a maintainer's Low PR needs no human, and every
 *      other author's Low PR still needs one (AC-013-1);
 *   2. relaxation attempted without the recorded evidence is REFUSED, with
 *      the refusal named so the approval evaluator can report it (AC-013-4);
 *   3. the recorded decision carries the tier, the effective tier, the
 *      characteristics and paths that drove it, who or what assigned it, and
 *      the original and final tier of every raise (AC-015-1, AC-015-2).
 *
 * Fail closed: an unreadable request, evidence or enablement never produces a
 * cheaper review. The waiver is granted only on facts that can be read.
 */

const {
  assignTier,
  effectiveTier,
  tierRecord,
  WAIVER_EVIDENCE_MINIMUMS,
  HUMANS_REQUIRED,
} = require('../lib/pr-review-tier');

const SUFFICIENT = { lowPrs: 20, days: 30, reverts: 0, incidents: 0 };
const OWNER = { login: 'maintainer-one', isCodeOwner: true };
const POLICY = { lowWaiverEnabled: true, maintainerLogins: ['maintainer-one', 'maintainer-two'] };

/** A Low assignment produced by the real assignTier, never a hand-written stand-in. */
function lowAssignment() {
  const assignment = assignTier({
    kinds: [{ kind: 'docs', paths: ['docs/guide.md'] }],
    paths: { sensitive: [], high: [], paths: ['docs/guide.md'] },
  });
  expect(assignment.tier).toBe('low');
  return assignment;
}

describe('TRD-041 AC-013-1: a Low tier is effectively Medium until the evidence and the waiver exist', () => {
  test('no waiver enabled: Low is treated as Medium and one human is required', () => {
    const result = effectiveTier({
      assignment: lowAssignment(),
      policy: { lowWaiverEnabled: false, maintainerLogins: ['maintainer-one'] },
      evidence: SUFFICIENT,
      enabledBy: OWNER,
      author: 'maintainer-one',
    });

    expect(result.ok).toBe(true);
    expect(result.tier).toBe('low');
    expect(result.effectiveTier).toBe('medium');
    expect(result.humansRequired).toBe(1);
    expect(result.waiver.applies).toBe(false);
    expect(result.waiver.reason).toBe('waiver-not-enabled');
  });

  test('too few Low PRs, too short a window, a revert or an incident each hold the tier at Medium', () => {
    const cases = [
      [{ ...SUFFICIENT, lowPrs: 19 }, 'insufficient-low-pr-count'],
      [{ ...SUFFICIENT, days: 29 }, 'insufficient-window'],
      [{ ...SUFFICIENT, reverts: 1 }, 'reverts-recorded'],
      [{ ...SUFFICIENT, incidents: 1 }, 'incidents-recorded'],
    ];

    for (const [evidence, reason] of cases) {
      const result = effectiveTier({ assignment: lowAssignment(), policy: POLICY, evidence, enabledBy: OWNER, author: 'maintainer-one' });
      expect(result.effectiveTier).toBe('medium');
      expect(result.humansRequired).toBe(1);
      expect(result.waiver.reason).toBe(reason);
    }
  });

  test('with the evidence, owner enablement and a maintainer author, Low means no human required', () => {
    const result = effectiveTier({
      assignment: lowAssignment(),
      policy: POLICY,
      evidence: SUFFICIENT,
      enabledBy: OWNER,
      author: 'maintainer-one',
    });

    expect(result.effectiveTier).toBe('low');
    expect(result.humansRequired).toBe(0);
    expect(result.waiver.applies).toBe(true);
    expect(result.waiver.evidence).toEqual(SUFFICIENT);
  });

  test('any other author stays at one human even when the waiver is live', () => {
    const result = effectiveTier({
      assignment: lowAssignment(),
      policy: POLICY,
      evidence: SUFFICIENT,
      enabledBy: OWNER,
      author: 'outside-contributor',
    });

    expect(result.effectiveTier).toBe('medium');
    expect(result.humansRequired).toBe(1);
    expect(result.waiver.applies).toBe(false);
    expect(result.waiver.reason).toBe('author-not-maintainer');
  });

  test('only a code owner can enable the waiver', () => {
    const result = effectiveTier({
      assignment: lowAssignment(),
      policy: POLICY,
      evidence: SUFFICIENT,
      enabledBy: { login: 'maintainer-one', isCodeOwner: false },
      author: 'maintainer-one',
    });

    expect(result.effectiveTier).toBe('medium');
    expect(result.waiver.reason).toBe('waiver-not-enabled-by-code-owner');
  });

  test('the waiver never touches Medium or High: the humans they require are unchanged', () => {
    const medium = effectiveTier({
      assignment: assignTier({ kinds: [{ kind: 'product', paths: ['lib/a.js'] }], paths: { sensitive: [], high: [], paths: ['lib/a.js'] } }),
      policy: POLICY,
      evidence: SUFFICIENT,
      enabledBy: OWNER,
      author: 'maintainer-one',
    });
    expect(medium.tier).toBe('medium');
    expect(medium.effectiveTier).toBe('medium');
    expect(medium.humansRequired).toBe(1);
    expect(medium.waiver.applies).toBe(false);
    expect(medium.waiver.reason).toBe('not-low-tier');

    const high = effectiveTier({
      assignment: assignTier({
        kinds: [{ kind: 'docs', paths: ['.github/workflows/ci.yml'] }],
        paths: { sensitive: ['.github/workflows/ci.yml'], high: [], paths: ['.github/workflows/ci.yml'] },
      }),
      policy: POLICY,
      evidence: SUFFICIENT,
      enabledBy: OWNER,
      author: 'maintainer-one',
    });
    expect(high.tier).toBe('high');
    expect(high.effectiveTier).toBe('high');
    expect(high.humansRequired).toBe(2);
  });

  test('the evidence minimums are the stated rule: 20 Low PRs, 30 days, zero reverts, zero incidents', () => {
    expect(WAIVER_EVIDENCE_MINIMUMS).toEqual({ lowPrs: 20, days: 30, maxReverts: 0, maxIncidents: 0 });
    expect(HUMANS_REQUIRED).toEqual({ low: 0, medium: 1, high: 2 });
  });
});

describe('TRD-041 AC-013-4: relaxation without the recorded evidence is refused', () => {
  test('an enabled waiver with no evidence at all is refused and named', () => {
    const result = effectiveTier({
      assignment: lowAssignment(),
      policy: POLICY,
      enabledBy: OWNER,
      author: 'maintainer-one',
    });

    expect(result.effectiveTier).toBe('medium');
    expect(result.humansRequired).toBe(1);
    expect(result.refusals).toEqual([
      { code: 'low-waiver-unsupported', detail: 'no-evidence', nextAction: expect.any(String) },
    ]);
  });

  test('an enabled waiver with unreadable evidence is refused, never granted on a guess', () => {
    for (const evidence of [null, [], 'twenty', { lowPrs: '20', days: 30, reverts: 0, incidents: 0 }, { lowPrs: 20 }]) {
      const result = effectiveTier({ assignment: lowAssignment(), policy: POLICY, evidence, enabledBy: OWNER, author: 'maintainer-one' });
      expect(result.effectiveTier).toBe('medium');
      expect(result.humansRequired).toBe(1);
      expect(result.refusals.length).toBeGreaterThan(0);
      expect(result.refusals[0].code).toBe('low-waiver-unsupported');
    }
  });

  test('negative control: a satisfied waiver records no refusal', () => {
    const result = effectiveTier({ assignment: lowAssignment(), policy: POLICY, evidence: SUFFICIENT, enabledBy: OWNER, author: 'maintainer-one' });
    expect(result.refusals).toEqual([]);
  });

  test('fail closed: a request it cannot read is High with two humans, never a cheaper review', () => {
    for (const bad of [null, undefined, 'low', 7, [], { assignment: null }, { assignment: { tier: 'cheap' } }]) {
      const result = effectiveTier(bad);
      expect(result.ok).toBe(false);
      expect(result.tier).toBe('high');
      expect(result.effectiveTier).toBe('high');
      expect(result.humansRequired).toBe(2);
      expect(result.waiver.applies).toBe(false);
    }
  });

  test('fail closed: an assignment that itself failed is High with two humans', () => {
    const blockedAssignment = assignTier({ paths: 'not a classification' });
    expect(blockedAssignment.ok).toBe(false);

    const result = effectiveTier({ assignment: blockedAssignment, policy: POLICY, evidence: SUFFICIENT, enabledBy: OWNER, author: 'maintainer-one' });
    expect(result.ok).toBe(false);
    expect(result.effectiveTier).toBe('high');
    expect(result.humansRequired).toBe(2);
  });

  test('a policy that cannot be read is a policy with no waiver', () => {
    for (const policy of [undefined, null, 'policy', { lowWaiverEnabled: 'yes' }, { lowWaiverEnabled: 1 }]) {
      const result = effectiveTier({ assignment: lowAssignment(), policy, evidence: SUFFICIENT, enabledBy: OWNER, author: 'maintainer-one' });
      expect(result.effectiveTier).toBe('medium');
      expect(result.humansRequired).toBe(1);
      expect(result.waiver.applies).toBe(false);
    }
  });
});

describe('TRD-041 AC-015-1 and AC-015-2: the tier decision is recorded', () => {
  const assignment = assignTier({
    kinds: [{ kind: 'product', paths: ['packages/development/lib/a.js'] }],
    paths: {
      sensitive: ['.github/workflows/ci.yml'],
      high: [],
      paths: ['packages/development/lib/a.js', '.github/workflows/ci.yml'],
    },
    secondAssessment: { needsAnotherPerson: true, reason: 'touches the release gate', evidencePaths: ['.github/workflows/ci.yml'] },
    author: 'agent-author',
  });

  test('the record carries the tier, the effective tier and who assigned it', () => {
    const effective = effectiveTier({ assignment, policy: POLICY, evidence: SUFFICIENT, enabledBy: OWNER, author: 'agent-author' });
    const record = tierRecord({ assignment, effective, assignedBy: 'pr-review-cycle', at: '2026-10-27T10:00:00Z' });

    expect(record.ok).toBe(true);
    expect(record.tier).toBe('high');
    expect(record.effectiveTier).toBe('high');
    expect(record.humansRequired).toBe(2);
    expect(record.assignedBy).toBe('pr-review-cycle');
    expect(record.at).toBe('2026-10-27T10:00:00Z');
  });

  test('the record names the characteristics and the paths that drove the tier', () => {
    const effective = effectiveTier({ assignment, policy: POLICY, evidence: SUFFICIENT, enabledBy: OWNER, author: 'agent-author' });
    const record = tierRecord({ assignment, effective, assignedBy: 'pr-review-cycle' });

    expect(record.reasons).toEqual(expect.arrayContaining(['product-change', 'sensitive-path']));
    expect(record.characteristics).toEqual([{ kind: 'product', paths: ['packages/development/lib/a.js'] }]);
    expect(record.paths.sensitive).toEqual(['.github/workflows/ci.yml']);
    expect(record.paths.uncited).toEqual(['.github/workflows/ci.yml']);
  });

  test('the original and the final tier are both recorded when a floor raised the PR', () => {
    const effective = effectiveTier({ assignment, policy: POLICY, evidence: SUFFICIENT, enabledBy: OWNER, author: 'agent-author' });
    const record = tierRecord({ assignment, effective, assignedBy: 'pr-review-cycle' });

    // The sensitive floor already put this PR at High, so the second
    // assessment had nothing left to raise: no raise is invented for it.
    expect(record.raised).toEqual([]);
    expect(record.originalTier).toBe('medium');
    expect(record.finalTier).toBe('high');
  });

  test('a raise from a second assessment is recorded with its from, to and reason', () => {
    const raisedAssignment = assignTier({
      kinds: [{ kind: 'docs', paths: ['docs/guide.md'] }],
      paths: { sensitive: [], high: [], paths: ['docs/guide.md'] },
      secondAssessment: { needsAnotherPerson: true, reason: 'wording changes a published promise' },
    });
    const effective = effectiveTier({ assignment: raisedAssignment, policy: POLICY, evidence: SUFFICIENT, enabledBy: OWNER, author: 'maintainer-one' });
    const record = tierRecord({ assignment: raisedAssignment, effective, assignedBy: 'second-assessment' });

    expect(record.raised).toEqual([{ from: 'low', to: 'medium', reason: 'wording changes a published promise' }]);
    expect(record.originalTier).toBe('low');
    expect(record.finalTier).toBe('medium');
    expect(record.tier).toBe('medium');
  });

  test('the waiver outcome is part of the record, including the refusal when there is one', () => {
    const lowOne = lowAssignment();
    const refused = effectiveTier({ assignment: lowOne, policy: POLICY, enabledBy: OWNER, author: 'maintainer-one' });
    const record = tierRecord({ assignment: lowOne, effective: refused, assignedBy: 'pr-review-cycle' });

    expect(record.waiver.applies).toBe(false);
    expect(record.refusals[0].code).toBe('low-waiver-unsupported');
    expect(record.effectiveTier).toBe('medium');
    expect(record.humansRequired).toBe(1);
  });

  test('fail closed: a record it cannot build is High with two humans and says why', () => {
    for (const bad of [null, undefined, {}, { assignment: lowAssignment() }, { effective: 'none' }]) {
      const record = tierRecord(bad);
      expect(record.ok).toBe(false);
      expect(record.tier).toBe('high');
      expect(record.effectiveTier).toBe('high');
      expect(record.humansRequired).toBe(2);
      expect(record.reasons.length).toBeGreaterThan(0);
    }
  });
});
