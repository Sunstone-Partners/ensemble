'use strict';

/**
 * TRD-024: Implementation AC tests for `evaluateApprovals`
 * (packages/development/lib/pr-review-approvals.js).
 *
 * In-process calls against the pure module. The PRD scenarios for REQ-014
 * belong to TRD-024-TEST and the `approvals` CLI subcommand to TRD-026;
 * neither is anticipated here.
 */

const { evaluateApprovals } = require('../lib/pr-review-approvals');
const { effectiveTier, assignTier } = require('../lib/pr-review-tier');

const HEAD = 'a'.repeat(40);
const HEAD_TREE = 'b'.repeat(40);
const OTHER_COMMIT = 'c'.repeat(40);
const OTHER_TREE = 'd'.repeat(40);

/** An effective-tier result of the requested tier, built the way a caller does. */
function tierOf(word, overrides = {}) {
  return {
    ok: true,
    tier: word,
    effectiveTier: word,
    humansRequired: { low: 0, medium: 1, high: 2 }[word],
    waiver: { applies: word === 'low', reason: 'test', evidence: null, enabledBy: null },
    refusals: [],
    reasons: [],
    warnings: [],
    ...overrides,
  };
}

const approval = (author, overrides = {}) => ({ author, state: 'APPROVED', commitSha: HEAD, ...overrides });

const ignoredFor = (result, login) => result.ignored.find((entry) => entry.login === login);

describe('AC-014-1: an automated approval never counts', () => {
  test('a configured bot login is ignored as automated, however it is spelled', () => {
    const result = evaluateApprovals({
      reviews: [approval('@CodeRabbitAI'), approval('human-a')],
      headSha: HEAD,
      tier: tierOf('medium'),
      policy: { botLogins: ['coderabbitai'] },
    });

    expect(ignoredFor(result, 'coderabbitai')).toMatchObject({ reason: 'automated' });
    expect(result.approvedBy).toEqual(['human-a']);
    expect(result.humansCounted).toBe(1);
    expect(result.satisfied).toBe(true);
  });

  test('a platform-marked bot is ignored even when the policy never named it', () => {
    const marked = evaluateApprovals({
      reviews: [approval('some-app', { isBot: true })],
      headSha: HEAD,
      tier: tierOf('medium'),
    });
    const byType = evaluateApprovals({
      reviews: [approval('some-app', { authorType: 'Bot' })],
      headSha: HEAD,
      tier: tierOf('medium'),
    });

    for (const result of [marked, byType]) {
      expect(ignoredFor(result, 'some-app')).toMatchObject({ reason: 'automated' });
      expect(result.humansCounted).toBe(0);
      expect(result.satisfied).toBe(false);
      expect(result.reason).toBe('insufficient-human-approvals');
    }
  });

  test('negative control: the same login approving, with no bot marking and no bot list, counts', () => {
    const result = evaluateApprovals({ reviews: [approval('some-app')], headSha: HEAD, tier: tierOf('medium') });
    expect(result.approvedBy).toEqual(['some-app']);
    expect(result.satisfied).toBe(true);
  });

  // TRD-028: the proof target for the bot-filter guard. Stated in plain
  // matchers over the counted result, so a mutant that lets an automated
  // approval count fails HERE, by this test's own assertion.
  test('a bot approval never fills the required human slot', () => {
    const result = evaluateApprovals({
      reviews: [approval('coderabbitai')],
      headSha: HEAD,
      tier: tierOf('medium'),
      policy: { botLogins: ['coderabbitai'] },
    });

    expect(result.humansCounted).toBe(0);
    expect(result.approvedBy).toEqual([]);
    expect(result.satisfied).toBe(false);
    expect(result.ignored.map((entry) => entry.reason)).toEqual(['automated']);
  });
});

describe('AC-014-2: an approval is bound to the commit it was given on', () => {
  test('an approval on another commit whose tree differs is stale and no longer counts', () => {
    const result = evaluateApprovals({
      reviews: [approval('human-a', { commitSha: OTHER_COMMIT, treeSha: OTHER_TREE })],
      headSha: HEAD,
      headTreeSha: HEAD_TREE,
      tier: tierOf('medium'),
    });

    expect(ignoredFor(result, 'human-a')).toMatchObject({ reason: 'stale-commit', commitSha: OTHER_COMMIT });
    expect(result.humansCounted).toBe(0);
    expect(result.satisfied).toBe(false);
  });

  // TRD-028: the proof target for the commit/tree-binding guard, in plain
  // matchers over the counted result for the same reason as above.
  test('a stale approval never fills the required human slot', () => {
    const result = evaluateApprovals({
      reviews: [approval('human-a', { commitSha: OTHER_COMMIT, treeSha: OTHER_TREE })],
      headSha: HEAD,
      headTreeSha: HEAD_TREE,
      tier: tierOf('medium'),
    });

    expect(result.humansCounted).toBe(0);
    expect(result.approvedBy).toEqual([]);
    expect(result.satisfied).toBe(false);
    expect(result.ignored.map((entry) => entry.reason)).toEqual(['stale-commit']);
  });

  test('an approval on another commit whose tree EQUALS the head tree still counts', () => {
    const result = evaluateApprovals({
      reviews: [approval('human-a', { commitSha: OTHER_COMMIT, treeSha: HEAD_TREE })],
      headSha: HEAD,
      headTreeSha: HEAD_TREE,
      tier: tierOf('medium'),
    });

    expect(result.approvedBy).toEqual(['human-a']);
    expect(result.satisfied).toBe(true);
  });

  test('without a readable head tree, only an exact commit match counts', () => {
    const result = evaluateApprovals({
      reviews: [approval('human-a', { commitSha: OTHER_COMMIT, treeSha: HEAD_TREE })],
      headSha: HEAD,
      tier: tierOf('medium'),
    });

    expect(ignoredFor(result, 'human-a')).toMatchObject({ reason: 'stale-commit' });
    expect(result.satisfied).toBe(false);
  });

  test('an approval bound to nothing is unbound, never counted as approval of the head', () => {
    const result = evaluateApprovals({
      reviews: [approval('human-a', { commitSha: undefined }), approval('human-b', { commitSha: 'HEAD' })],
      headSha: HEAD,
      tier: tierOf('high'),
    });

    expect(ignoredFor(result, 'human-a')).toMatchObject({ reason: 'unbound' });
    expect(ignoredFor(result, 'human-b')).toMatchObject({ reason: 'unbound' });
    expect(result.humansCounted).toBe(0);
  });
});

describe('AC-014-3 / AC-014-4: who fills a required slot, and how many slots there are', () => {
  test('the person who directed an agent-authored PR fills one slot', () => {
    const result = evaluateApprovals({
      reviews: [],
      headSha: HEAD,
      tier: tierOf('medium'),
      agentAuthored: true,
      directedBy: 'person-a',
    });

    expect(result.directedBy).toBe('person-a');
    expect(result.humansCounted).toBe(1);
    expect(result.satisfied).toBe(true);
  });

  test('directedBy is read only for an agent-authored PR', () => {
    const result = evaluateApprovals({
      reviews: [],
      headSha: HEAD,
      tier: tierOf('medium'),
      directedBy: 'person-a',
    });

    expect(result.directedBy).toBeNull();
    expect(result.satisfied).toBe(false);
  });

  test('the director is one person, not two: their own approval does not also fill the second High slot', () => {
    const result = evaluateApprovals({
      reviews: [approval('person-a')],
      headSha: HEAD,
      tier: tierOf('high'),
      agentAuthored: true,
      directedBy: 'person-a',
    });

    expect(result.approvedBy).toEqual(['person-a']);
    expect(result.humansCounted).toBe(1);
    expect(result.humansRequired).toBe(2);
    expect(result.satisfied).toBe(false);
  });

  test('High needs two DISTINCT people: two approvals from one login are one human', () => {
    const duplicate = evaluateApprovals({
      reviews: [approval('human-a'), approval('human-a')],
      headSha: HEAD,
      tier: tierOf('high'),
    });
    const distinct = evaluateApprovals({
      reviews: [approval('human-a'), approval('human-b')],
      headSha: HEAD,
      tier: tierOf('high'),
    });

    expect(duplicate.humansCounted).toBe(1);
    expect(duplicate.satisfied).toBe(false);
    expect(distinct.humansCounted).toBe(2);
    expect(distinct.satisfied).toBe(true);
  });

  test('Medium needs one human and an effective-Low PR needs none', () => {
    const medium = evaluateApprovals({ reviews: [], headSha: HEAD, tier: tierOf('medium') });
    const low = evaluateApprovals({ reviews: [], headSha: HEAD, tier: tierOf('low') });

    expect(medium.humansRequired).toBe(1);
    expect(medium.satisfied).toBe(false);
    expect(low.humansRequired).toBe(0);
    expect(low.satisfied).toBe(true);
    expect(low.reason).toBe('no-human-approval-required');
  });

  test('the author never approves their own PR into the count', () => {
    const result = evaluateApprovals({
      reviews: [approval('human-a')],
      headSha: HEAD,
      tier: tierOf('medium'),
      author: 'Human-A',
    });

    expect(ignoredFor(result, 'human-a')).toMatchObject({ reason: 'self-approval' });
    expect(result.satisfied).toBe(false);
  });
});

describe('AC-014-5: the Low waiver never relaxes a PR authored by a non-maintainer', () => {
  const docsAssignment = () =>
    assignTier({
      kinds: [{ kind: 'docs', paths: ['docs/a.md'] }],
      paths: { ok: true, paths: [{ path: 'docs/a.md', sensitive: false, high: false }], sensitive: [], high: [] },
    });

  const waiverInput = (author) => ({
    assignment: docsAssignment(),
    policy: { lowWaiverEnabled: true, maintainerLogins: ['maintainer-a'] },
    enabledBy: { login: 'owner-a', isCodeOwner: true },
    evidence: { lowPrs: 25, days: 45, reverts: 0, incidents: 0 },
    author,
  });

  test('a maintainer author with the recorded evidence needs no human approval', () => {
    const tier = effectiveTier(waiverInput('maintainer-a'));
    expect(tier.effectiveTier).toBe('low');

    const result = evaluateApprovals({ reviews: [], headSha: HEAD, tier, author: 'maintainer-a' });
    expect(result.humansRequired).toBe(0);
    expect(result.satisfied).toBe(true);
  });

  test('the same PR from a non-maintainer author still requires one human', () => {
    const tier = effectiveTier(waiverInput('contributor-b'));
    expect(tier.effectiveTier).toBe('medium');

    const result = evaluateApprovals({ reviews: [], headSha: HEAD, tier, author: 'contributor-b' });
    expect(result.humansRequired).toBe(1);
    expect(result.satisfied).toBe(false);

    const withApproval = evaluateApprovals({
      reviews: [approval('human-a')],
      headSha: HEAD,
      tier,
      author: 'contributor-b',
    });
    expect(withApproval.satisfied).toBe(true);
  });

  test('a relaxation the tier evaluator refused keeps approval required, with the refusal visible', () => {
    const tier = effectiveTier({
      assignment: docsAssignment(),
      policy: { lowWaiverEnabled: true, maintainerLogins: ['maintainer-a'] },
      enabledBy: { login: 'owner-a', isCodeOwner: true },
      author: 'maintainer-a',
      // No evidence recorded at all.
    });
    expect(tier.refusals).toHaveLength(1);

    const result = evaluateApprovals({ reviews: [approval('human-a')], headSha: HEAD, tier, author: 'maintainer-a' });
    expect(result.satisfied).toBe(false);
    expect(result.reason).toBe('tier-relaxation-refused');
    expect(result.refusals[0]).toMatchObject({ code: 'low-waiver-unsupported' });
  });
});

describe('fail closed: an unreadable request is never an absent requirement', () => {
  test.each([
    ['invalid-input', undefined],
    ['invalid-tier', { reviews: [], headSha: HEAD }],
    ['invalid-reviews', { reviews: 'all of them', headSha: HEAD, tier: tierOf('low') }],
    ['invalid-head-sha', { reviews: [], headSha: 'HEAD', tier: tierOf('low') }],
    ['unknown-tier', { reviews: [], headSha: HEAD, tier: { ok: true, effectiveTier: 'cheap', humansRequired: 0 } }],
    ['tier-blocked', { reviews: [], headSha: HEAD, tier: { ok: false, effectiveTier: 'high', humansRequired: 2 } }],
  ])('%s is blocked: two humans required, nothing granted', (reason, input) => {
    const result = evaluateApprovals(input);

    expect(result.ok).toBe(false);
    expect(result.satisfied).toBe(false);
    expect(result.reason).toBe(reason);
    expect(result.humansRequired).toBe(2);
    expect(result.approvedBy).toEqual([]);
  });

  test('an unreadable review is reported, never read as an approval', () => {
    const result = evaluateApprovals({
      reviews: [null, { state: 'APPROVED', commitSha: HEAD }, approval('human-a')],
      headSha: HEAD,
      tier: tierOf('high'),
    });

    expect(result.ignored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'unreadable-review' }),
        expect.objectContaining({ reason: 'unreadable-approver' }),
      ])
    );
    expect(result.humansCounted).toBe(1);
    expect(result.satisfied).toBe(false);
  });

  test('a state that is not an approval is simply not one -- not an approval, not an error', () => {
    const result = evaluateApprovals({
      reviews: [
        { author: 'human-a', state: 'CHANGES_REQUESTED', commitSha: HEAD },
        { author: 'human-b', state: 'COMMENTED', commitSha: HEAD },
      ],
      headSha: HEAD,
      tier: tierOf('medium'),
    });

    expect(result.humansCounted).toBe(0);
    expect(result.ignored).toEqual([]);
    expect(result.satisfied).toBe(false);
  });
});

describe('per-reviewer latest review and the tier floor', () => {
  test('a later CHANGES_REQUESTED or DISMISSED removes the same reviewer\'s approval; COMMENTED does not', () => {
    const run = (reviews) => evaluateApprovals({ reviews, headSha: HEAD, tier: tierOf('medium') });
    expect(run([approval('a'), approval('a', { state: 'CHANGES_REQUESTED' })]).satisfied).toBe(false);
    expect(run([approval('a'), approval('a', { state: 'DISMISSED' })]).satisfied).toBe(false);
    expect(run([approval('a'), approval('a', { state: 'COMMENTED' })]).satisfied).toBe(true);
    expect(run([approval('a', { state: 'CHANGES_REQUESTED' }), approval('a')]).satisfied).toBe(true);
  });

  test('submittedAt outranks array order when both carry one', () => {
    const result = evaluateApprovals({
      reviews: [
        approval('a', { state: 'CHANGES_REQUESTED', submittedAt: '2026-01-02T00:00:00Z' }),
        approval('a', { submittedAt: '2026-01-01T00:00:00Z' }),
      ],
      headSha: HEAD,
      tier: tierOf('medium'),
    });
    expect(result.satisfied).toBe(false);
  });

  test('a tier result cannot lower the floor; the result carries headSha', () => {
    const result = evaluateApprovals({
      reviews: [approval('a')],
      headSha: HEAD,
      tier: tierOf('high', { humansRequired: 1 }),
    });
    expect(result.humansRequired).toBe(2);
    expect(result.satisfied).toBe(false);
    expect(result.headSha).toBe(HEAD);
  });
});
