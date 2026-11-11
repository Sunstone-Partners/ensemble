'use strict';

/**
 * TRD-024-TEST: Commit-bound human approvals (PRD scenarios).
 *
 * Verifies TRD-024 (`lib/pr-review-approvals.js`).
 * Validates PRD ACs: AC-014-1, AC-014-2, AC-014-3, AC-014-4, AC-014-5 (REQ-014).
 *
 * These are the REQUIREMENT-level scenarios, each read the way REQ-014 states
 * it: "a human approval means a PERSON, on a SPECIFIC commit". The
 * implementation ACs (field-level behavior of `evaluateApprovals`) are
 * covered by pr-review-approvals.test.js; this file never re-states them.
 *
 * Two deliberate differences from the implementation suite:
 *
 *   - the tier is produced by the REAL `assignTier` + `effectiveTier` chain
 *     over a real `classifyPaths` result, never a hand-built tier literal, so
 *     a scenario cannot pass against a tier shape the evaluator would never
 *     receive (AC-014-4 and AC-014-5 depend on that chain);
 *   - every scenario carries the case that must be REFUSED next to the case
 *     that passes, so no rule here is proven only in the direction that
 *     grants approval.
 *
 * TRD Reference: docs/TRD/TRD-2026-70e784f2-code-review-process.md#trd-024-test
 */

const { evaluateApprovals } = require('../lib/pr-review-approvals');
const { assignTier, effectiveTier, HUMANS_REQUIRED } = require('../lib/pr-review-tier');
const { classifyPaths } = require('../lib/pr-review-paths');

const BASE = 'e'.repeat(40);
const HEAD = 'a'.repeat(40);
const HEAD_TREE = 'b'.repeat(40);
const OLDER_COMMIT = 'c'.repeat(40);
const OTHER_TREE = 'd'.repeat(40);

/** Evidence that satisfies every Low-waiver minimum. */
const GOOD_EVIDENCE = { lowPrs: 25, days: 45, reverts: 0, incidents: 0 };

const POLICY = Object.freeze({
  botLogins: ['coderabbitai', 'dependabot'],
  maintainerLogins: ['maintainer-m'],
  lowWaiverEnabled: true,
});

const approval = (author, overrides = {}) => ({ author, state: 'APPROVED', commitSha: HEAD, ...overrides });

/**
 * The real tier chain: classify the changed paths, assign the tier from the
 * kinds of change, then resolve the effective tier under the policy.
 */
function tierFor({ changedPaths, kinds, policy = POLICY, author, evidence, enabledBy }) {
  const paths = classifyPaths({ changedPaths, baseSha: BASE });
  const assignment = assignTier({ paths, kinds });
  return effectiveTier({ assignment, policy, author, evidence, enabledBy });
}

/** A docs-only PR: Low on its own, so the waiver rules are the only thing that can change it. */
const lowTier = (overrides = {}) =>
  tierFor({
    changedPaths: ['docs/guide.md'],
    kinds: [{ kind: 'docs', paths: ['docs/guide.md'] }],
    ...overrides,
  });

/** A PR that touches a sensitive area: floored to High by the declaration defaults. */
const highTier = (overrides = {}) =>
  tierFor({
    changedPaths: ['.github/workflows/ci.yml'],
    kinds: [{ kind: 'product', paths: ['.github/workflows/ci.yml'] }],
    ...overrides,
  });

/** An ordinary product change: Medium. */
const mediumTier = (overrides = {}) =>
  tierFor({
    changedPaths: ['packages/development/lib/widget.js'],
    kinds: [{ kind: 'product', paths: ['packages/development/lib/widget.js'] }],
    ...overrides,
  });

const ignoredFor = (result, login) => result.ignored.find((entry) => entry.login === login);

describe('Scenario AC-014-1: an approval recorded by an agent or automated account is not a human approval', () => {
  test('the repository bot list names it: the approval is ignored as automated and the PR still needs its human', () => {
    const tier = mediumTier();
    const result = evaluateApprovals({
      reviews: [approval('coderabbitai')],
      headSha: HEAD,
      tier,
      policy: POLICY,
      author: 'author-a',
    });

    expect(tier.effectiveTier).toBe('medium');
    expect(ignoredFor(result, 'coderabbitai')).toMatchObject({ reason: 'automated' });
    expect(result.humansCounted).toBe(0);
    expect(result.satisfied).toBe(false);
    expect(result.reason).toBe('insufficient-human-approvals');
  });

  test('the platform marks it as a bot even though the policy never named it: still not a human approval', () => {
    const result = evaluateApprovals({
      reviews: [approval('some-review-app', { isBot: true })],
      headSha: HEAD,
      tier: mediumTier(),
      policy: POLICY,
      author: 'author-a',
    });

    expect(ignoredFor(result, 'some-review-app')).toMatchObject({ reason: 'automated' });
    expect(result.satisfied).toBe(false);
  });

  test('the same PR with one person approving the head is satisfied: the rule refuses bots, not everyone', () => {
    const result = evaluateApprovals({
      reviews: [approval('coderabbitai'), approval('human-a')],
      headSha: HEAD,
      tier: mediumTier(),
      policy: POLICY,
      author: 'author-a',
    });

    expect(result.approvedBy).toEqual(['human-a']);
    expect(result.satisfied).toBe(true);
  });
});

describe('Scenario AC-014-2: new commits the system cannot vouch for cost the approval', () => {
  test('an approval on an older commit whose tree differs no longer counts, and approval is requested again', () => {
    const result = evaluateApprovals({
      reviews: [approval('human-a', { commitSha: OLDER_COMMIT, treeSha: OTHER_TREE })],
      headSha: HEAD,
      headTreeSha: HEAD_TREE,
      tier: mediumTier(),
      policy: POLICY,
      author: 'author-a',
    });

    expect(ignoredFor(result, 'human-a')).toMatchObject({ reason: 'stale-commit', commitSha: OLDER_COMMIT });
    expect(result.humansCounted).toBe(0);
    expect(result.satisfied).toBe(false);
    expect(result.humansRequired).toBe(1);
  });

  test('a push the system CAN vouch for -- same tree under a new commit -- keeps the approval', () => {
    const result = evaluateApprovals({
      reviews: [approval('human-a', { commitSha: OLDER_COMMIT, treeSha: HEAD_TREE })],
      headSha: HEAD,
      headTreeSha: HEAD_TREE,
      tier: mediumTier(),
      policy: POLICY,
      author: 'author-a',
    });

    expect(result.approvedBy).toEqual(['human-a']);
    expect(result.satisfied).toBe(true);
  });

  test('an approval bound to no commit at all is never evidence for this head', () => {
    const result = evaluateApprovals({
      reviews: [approval('human-a', { commitSha: undefined })],
      headSha: HEAD,
      tier: mediumTier(),
      policy: POLICY,
      author: 'author-a',
    });

    expect(ignoredFor(result, 'human-a')).toMatchObject({ reason: 'unbound' });
    expect(result.satisfied).toBe(false);
  });
});

describe('Scenario AC-014-3: the person who directed an agent-authored PR counts as a reviewer', () => {
  test('a directing person fills one required slot, as if they had written the code themselves', () => {
    const result = evaluateApprovals({
      reviews: [],
      headSha: HEAD,
      tier: mediumTier(),
      policy: POLICY,
      author: 'agent-bot',
      agentAuthored: true,
      directedBy: 'human-director',
    });

    expect(result.directedBy).toBe('human-director');
    expect(result.approvedBy).toEqual(['human-director']);
    expect(result.satisfied).toBe(true);
  });

  test('the same PR with no directing person named is not approved by the agent that wrote it', () => {
    const result = evaluateApprovals({
      reviews: [],
      headSha: HEAD,
      tier: mediumTier(),
      policy: POLICY,
      author: 'agent-bot',
      agentAuthored: true,
    });

    expect(result.directedBy).toBeNull();
    expect(result.satisfied).toBe(false);
  });

  test('a direction attributed to a bot is refused: an automated account can direct nothing', () => {
    const result = evaluateApprovals({
      reviews: [],
      headSha: HEAD,
      tier: mediumTier(),
      policy: POLICY,
      author: 'agent-bot',
      agentAuthored: true,
      directedBy: 'dependabot',
    });

    expect(result.directedBy).toBeNull();
    expect(ignoredFor(result, 'dependabot')).toMatchObject({ reason: 'automated' });
    expect(result.satisfied).toBe(false);
  });

  test('a director who also approved is credited once, not twice: High still needs a second person', () => {
    const result = evaluateApprovals({
      reviews: [approval('human-director')],
      headSha: HEAD,
      tier: highTier(),
      policy: POLICY,
      author: 'agent-bot',
      agentAuthored: true,
      directedBy: 'human-director',
    });

    expect(result.approvedBy).toEqual(['human-director']);
    expect(result.humansCounted).toBe(1);
    expect(result.humansRequired).toBe(2);
    expect(result.satisfied).toBe(false);
  });
});

describe('Scenario AC-014-4: a High-tier PR requires two distinct people', () => {
  test('the sensitive path floors the PR to High, and one approval is not enough', () => {
    const tier = highTier();
    const result = evaluateApprovals({
      reviews: [approval('human-a')],
      headSha: HEAD,
      tier,
      policy: POLICY,
      author: 'author-a',
    });

    expect(tier.effectiveTier).toBe('high');
    expect(result.humansRequired).toBe(HUMANS_REQUIRED.high);
    expect(result.satisfied).toBe(false);
  });

  test('two DISTINCT people satisfy it; the same person approving twice does not', () => {
    const twice = evaluateApprovals({
      reviews: [approval('human-a'), approval('HUMAN-A')],
      headSha: HEAD,
      tier: highTier(),
      policy: POLICY,
      author: 'author-a',
    });
    expect(twice.humansCounted).toBe(1);
    expect(twice.satisfied).toBe(false);

    const distinct = evaluateApprovals({
      reviews: [approval('human-a'), approval('human-b')],
      headSha: HEAD,
      tier: highTier(),
      policy: POLICY,
      author: 'author-a',
    });
    expect(distinct.approvedBy).toEqual(['human-a', 'human-b']);
    expect(distinct.satisfied).toBe(true);
  });

  test('the author is never one of the two: their own approval is ignored as a self-approval', () => {
    const result = evaluateApprovals({
      reviews: [approval('author-a'), approval('human-b')],
      headSha: HEAD,
      tier: highTier(),
      policy: POLICY,
      author: 'author-a',
    });

    expect(ignoredFor(result, 'author-a')).toMatchObject({ reason: 'self-approval' });
    expect(result.humansCounted).toBe(1);
    expect(result.satisfied).toBe(false);
  });
});

describe('Scenario AC-014-5: the Low waiver applies only to maintainer-authored PRs', () => {
  const waiverInput = { policy: POLICY, evidence: GOOD_EVIDENCE, enabledBy: { login: 'owner-o', isCodeOwner: true } };

  test('a maintainer-authored Low PR with the waiver enabled needs no human approval', () => {
    const tier = lowTier({ ...waiverInput, author: 'maintainer-m' });
    const result = evaluateApprovals({ reviews: [], headSha: HEAD, tier, policy: POLICY, author: 'maintainer-m' });

    expect(tier.effectiveTier).toBe('low');
    expect(tier.waiver.applies).toBe(true);
    expect(result.humansRequired).toBe(0);
    expect(result.satisfied).toBe(true);
    expect(result.reason).toBe('no-human-approval-required');
  });

  test('every other author\'s Low PR still requires one human approval', () => {
    const tier = lowTier({ ...waiverInput, author: 'contributor-c' });
    const result = evaluateApprovals({ reviews: [], headSha: HEAD, tier, policy: POLICY, author: 'contributor-c' });

    expect(tier.tier).toBe('low');
    expect(tier.effectiveTier).toBe('medium');
    expect(tier.waiver.applies).toBe(false);
    expect(tier.reasons).toContain('author-not-maintainer');
    expect(result.humansRequired).toBe(1);
    expect(result.satisfied).toBe(false);
  });

  test('that non-maintainer Low PR is satisfied by one person approving the head: it needs one human, not two', () => {
    const tier = lowTier({ ...waiverInput, author: 'contributor-c' });
    const result = evaluateApprovals({
      reviews: [approval('human-a')],
      headSha: HEAD,
      tier,
      policy: POLICY,
      author: 'contributor-c',
    });

    expect(result.satisfied).toBe(true);
    expect(result.humansCounted).toBe(1);
  });

  test('a maintainer Low PR with the waiver NOT enabled by a code owner still needs a human', () => {
    const tier = lowTier({ policy: POLICY, evidence: GOOD_EVIDENCE, author: 'maintainer-m', enabledBy: { login: 'owner-o', isCodeOwner: false } });
    const result = evaluateApprovals({ reviews: [], headSha: HEAD, tier, policy: POLICY, author: 'maintainer-m' });

    expect(tier.effectiveTier).toBe('medium');
    expect(result.satisfied).toBe(false);
  });

  test('a maintainer Low PR whose waiver evidence is missing is refused, and the refusal travels into the approvals result', () => {
    const tier = lowTier({ policy: POLICY, author: 'maintainer-m', enabledBy: { login: 'owner-o', isCodeOwner: true } });
    const result = evaluateApprovals({ reviews: [approval('human-a')], headSha: HEAD, tier, policy: POLICY, author: 'maintainer-m' });

    expect(tier.refusals.map((entry) => entry.code)).toContain('low-waiver-unsupported');
    expect(result.refusals.map((entry) => entry.code)).toContain('low-waiver-unsupported');
    expect(result.satisfied).toBe(false);
    expect(result.reason).toBe('tier-relaxation-refused');
  });
});

describe('REQ-014 fail-closed: an unreadable approval picture never approves', () => {
  // Each case breaks exactly one fact; `build` is called at test time so the
  // real tier chain runs inside the case that uses it.
  test.each([
    ['no tier at all', () => ({ reviews: [], headSha: HEAD })],
    ['a blocked tier', () => ({ reviews: [], headSha: HEAD, tier: { ok: false, effectiveTier: 'low', humansRequired: 0 } })],
    ['a head that is not an object id', () => ({ reviews: [], headSha: 'HEAD', tier: mediumTier() })],
    ['reviews that are not a list', () => ({ reviews: 'approved', headSha: HEAD, tier: mediumTier() })],
    ['a tier word this evaluator does not know', () => ({ reviews: [], headSha: HEAD, tier: { ok: true, effectiveTier: 'trivial', humansRequired: 0 } })],
  ])('%s is refused, never a pass', (_label, build) => {
    const result = evaluateApprovals(build());

    expect(result.satisfied).toBe(false);
    expect(result.humansRequired).toBeGreaterThan(0);
  });

  test('a review whose state cannot be read is not an approval', () => {
    const result = evaluateApprovals({
      reviews: [{ author: 'human-a', state: { looks: 'approved' }, commitSha: HEAD }],
      headSha: HEAD,
      tier: mediumTier(),
      policy: POLICY,
      author: 'author-a',
    });

    expect(result.humansCounted).toBe(0);
    expect(result.satisfied).toBe(false);
  });
});
