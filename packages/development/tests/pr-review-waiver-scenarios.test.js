'use strict';

/**
 * TRD-041-TEST: Low waiver and recorded tier (PRD scenarios).
 *
 * Validates PRD ACs: AC-013-1, AC-013-4, AC-015-1, AC-015-2 (REQ-013,
 * REQ-015).
 *
 * The Implementation AC tests for `pr-review-tier.js` live in
 * pr-review-waiver.test.js and exercise `effectiveTier`/`assignTier`/
 * `tierRecord` in isolation. These are the PRD-LEVEL scenarios, read the
 * way the requirement states them, each run through the FULL pipeline
 * (`assignTier` -> `effectiveTier` -> `tierRecord`) a real caller would use,
 * never a hand-assembled stand-in for any of the three stages.
 *
 * Scenarios:
 *   - AC-013-1: fewer than 20 Low PRs over 30 days with zero reverts and
 *     zero incidents -- the PR is treated as Medium and needs one human.
 *   - AC-013-4: tier relaxation attempted without a code owner explicitly
 *     enabling it is refused.
 *   - AC-015-1: the record names the tier, the characteristics and paths
 *     that drove it, and who or what assigned it.
 *   - AC-015-2: a tier raised by a sensitive path shows its original and
 *     final tier and the reason.
 */

const { assignTier, effectiveTier, tierRecord } = require('../lib/pr-review-tier');

const OWNER = { login: 'maintainer-one', isCodeOwner: true };
const NOT_OWNER = { login: 'contributor-one', isCodeOwner: false };
const MAINTAINER_POLICY = { lowWaiverEnabled: true, maintainerLogins: ['maintainer-one'] };

/** Runs the real three-stage pipeline a caller would: assign, then make effective, then record. */
function evaluate({ assignInput, policy, evidence, enabledBy, author, assignedBy = 'pr-review-cycle' }) {
  const assignment = assignTier(assignInput);
  const effective = effectiveTier({ assignment, policy, evidence, enabledBy, author });
  const record = tierRecord({ assignment, effective, assignedBy });
  return { assignment, effective, record };
}

describe('Scenario AC-013-1: fewer than 20 Low PRs over 30 days with zero reverts and zero incidents holds the tier at Medium', () => {
  test('a Low-shaped PR with insufficient evidence is treated as Medium and needs one human approval', () => {
    const { record } = evaluate({
      assignInput: { kinds: [{ kind: 'docs', paths: ['docs/guide.md'] }], paths: { sensitive: [], high: [], paths: ['docs/guide.md'] } },
      policy: MAINTAINER_POLICY,
      evidence: { lowPrs: 12, days: 18, reverts: 0, incidents: 0 },
      enabledBy: OWNER,
      author: 'maintainer-one',
    });

    expect(record.ok).toBe(true);
    expect(record.tier).toBe('low');
    expect(record.effectiveTier).toBe('medium');
    expect(record.humansRequired).toBe(1);
  });

  test('exactly at the evidence minimums with every other condition satisfied, the waiver applies and no human is required', () => {
    const { record } = evaluate({
      assignInput: { kinds: [{ kind: 'docs', paths: ['docs/guide.md'] }], paths: { sensitive: [], high: [], paths: ['docs/guide.md'] } },
      policy: MAINTAINER_POLICY,
      evidence: { lowPrs: 20, days: 30, reverts: 0, incidents: 0 },
      enabledBy: OWNER,
      author: 'maintainer-one',
    });

    expect(record.effectiveTier).toBe('low');
    expect(record.humansRequired).toBe(0);
  });
});

describe('Scenario AC-013-4: tier relaxation without a code owner explicitly enabling it is refused', () => {
  test('a waiver "enabled" by someone who is not a code owner is refused, never granted', () => {
    const { record } = evaluate({
      assignInput: { kinds: [{ kind: 'docs', paths: ['docs/guide.md'] }], paths: { sensitive: [], high: [], paths: ['docs/guide.md'] } },
      policy: MAINTAINER_POLICY,
      evidence: { lowPrs: 20, days: 30, reverts: 0, incidents: 0 },
      enabledBy: NOT_OWNER,
      author: 'maintainer-one',
    });

    expect(record.effectiveTier).toBe('medium');
    expect(record.humansRequired).toBe(1);
    expect(record.waiver.applies).toBe(false);
  });

  test('no enablement at all is refused with the reason named for the approval evaluator', () => {
    const { record } = evaluate({
      assignInput: { kinds: [{ kind: 'docs', paths: ['docs/guide.md'] }], paths: { sensitive: [], high: [], paths: ['docs/guide.md'] } },
      policy: MAINTAINER_POLICY,
      evidence: { lowPrs: 20, days: 30, reverts: 0, incidents: 0 },
      enabledBy: undefined,
      author: 'maintainer-one',
    });

    expect(record.waiver.applies).toBe(false);
    expect(record.waiver.reason).toBeTruthy();
  });
});

describe('Scenario AC-015-1: the record names the tier, the characteristics and paths that drove it, and who assigned it', () => {
  test('a product change over a sensitive path records its tier, its characteristics, its paths and the assigner', () => {
    const { record } = evaluate({
      assignInput: {
        kinds: [{ kind: 'product', paths: ['packages/development/lib/a.js'] }],
        paths: { sensitive: ['.github/workflows/ci.yml'], high: [], paths: ['packages/development/lib/a.js', '.github/workflows/ci.yml'] },
        author: 'agent-author',
      },
      policy: MAINTAINER_POLICY,
      evidence: { lowPrs: 20, days: 30, reverts: 0, incidents: 0 },
      enabledBy: OWNER,
      author: 'agent-author',
      assignedBy: 'pr-review-cycle',
    });

    expect(record.ok).toBe(true);
    expect(record.tier).toBe('high');
    expect(record.characteristics).toEqual([{ kind: 'product', paths: ['packages/development/lib/a.js'] }]);
    expect(record.paths.sensitive).toEqual(['.github/workflows/ci.yml']);
    expect(record.assignedBy).toBe('pr-review-cycle');
  });
});

describe('Scenario AC-015-2: a tier raised by a sensitive path or a second assessment shows its original and final tier and the reason', () => {
  test('a sensitive-path floor raises a Low-shaped PR: the record shows the original tier beneath the floor and the final tier', () => {
    const { record } = evaluate({
      assignInput: {
        kinds: [{ kind: 'product', paths: ['packages/development/lib/a.js'] }],
        paths: { sensitive: ['.github/workflows/ci.yml'], high: [], paths: ['packages/development/lib/a.js', '.github/workflows/ci.yml'] },
        secondAssessment: { needsAnotherPerson: true, reason: 'touches the release gate', evidencePaths: ['.github/workflows/ci.yml'] },
      },
      policy: MAINTAINER_POLICY,
      evidence: { lowPrs: 20, days: 30, reverts: 0, incidents: 0 },
      enabledBy: OWNER,
      author: 'agent-author',
    });

    expect(record.originalTier).toBe('medium');
    expect(record.finalTier).toBe('high');
  });

  test('a second assessment raises a Low PR with no sensitive path: the record shows the raise, its from, to and reason', () => {
    const { record } = evaluate({
      assignInput: {
        kinds: [{ kind: 'docs', paths: ['docs/guide.md'] }],
        paths: { sensitive: [], high: [], paths: ['docs/guide.md'] },
        secondAssessment: { needsAnotherPerson: true, reason: 'wording changes a published promise' },
      },
      policy: MAINTAINER_POLICY,
      evidence: { lowPrs: 20, days: 30, reverts: 0, incidents: 0 },
      enabledBy: OWNER,
      author: 'maintainer-one',
    });

    expect(record.raised).toEqual([{ from: 'low', to: 'medium', reason: 'wording changes a published promise' }]);
    expect(record.originalTier).toBe('low');
    expect(record.finalTier).toBe('medium');
  });
});
