'use strict';

/**
 * Solo-maintainer rule (policy `soloMaintainer`) -- requirement-level scenarios.
 *
 * A repository with exactly one maintainer can never field two humans for a
 * High PR: the director of an agent-authored PR fills one slot, the PR author
 * never fills one, and nobody else exists. With the policy flag on, a High PR
 * that touches no sensitive path and was directed by that maintainer needs one
 * human (the director). The security lane must still pass, and every other
 * case keeps two humans.
 *
 * Every input comes from the REAL chain (`classifyPaths` -> `assignTier` ->
 * `effectiveTier` -> `evaluateApprovals` -> `evaluateGate`), and every case
 * that relaxes sits next to the case that must still be refused.
 */

const { evaluateGate, BLOCKER_CODES } = require('../lib/pr-review-gate');
const { evaluateApprovals } = require('../lib/pr-review-approvals');
const { assignTier, effectiveTier, tierRecord } = require('../lib/pr-review-tier');
const { classifyPaths } = require('../lib/pr-review-paths');
const { checkDescription } = require('../lib/pr-review-description');
const { loadPolicy } = require('../lib/pr-review-policy');

const BASE = 'e'.repeat(40);
const HEAD = 'a'.repeat(40);

const DECLARATION = Object.freeze({
  sourceSha: BASE,
  sensitive: [],
  high: ['packages/agent-core/**'],
});

const SOLO_POLICY = Object.freeze({
  botLogins: ['coderabbitai'],
  maintainerLogins: ['@Maintainer-M'],
  soloMaintainer: true,
});

const DESCRIPTION = [
  '## Summary',
  '',
  'Change.',
  '',
  '## Testing',
  '',
  'Ran the suite.',
  '',
  '## Risk',
  '',
  'Low.',
  '',
  '## How to revert',
  '',
  'Revert the commit.',
  '',
].join('\n');

/** The real tier chain for a PR changing `changedPaths`, High by owner declaration or sensitive floor. */
function tierFor(changedPaths, policy = SOLO_POLICY) {
  const paths = classifyPaths({ changedPaths, declaration: DECLARATION, baseSha: BASE });
  const assignment = assignTier({ paths, kinds: [{ kind: 'product', paths: changedPaths }] });
  return effectiveTier({ assignment, policy, author: 'maintainer-m' });
}

/** A non-sensitive PR the tier chain RAISES to High (it is Medium on its paths alone). */
function raisedTierFor({ secondAssessment, proposedTier } = {}) {
  const changedPaths = ['packages/development/lib/widget.js'];
  const paths = classifyPaths({ changedPaths, declaration: { ...DECLARATION, high: [] }, baseSha: BASE });
  const assignment = assignTier({
    paths,
    kinds: [{ kind: 'product', paths: changedPaths }],
    secondAssessment,
    proposedTier,
  });
  return effectiveTier({ assignment, policy: SOLO_POLICY, author: 'maintainer-m' });
}

const HIGH_PATHS = ['packages/agent-core/src/behavior/event-disposition.ts'];

/** An agent-authored PR directed by `directedBy`, no review submitted yet. */
function approvalsFor(tier, { policy = SOLO_POLICY, directedBy = 'maintainer-m', agentAuthored = true, reviews = [] } = {}) {
  return evaluateApprovals({
    reviews,
    headSha: HEAD,
    tier,
    policy,
    author: 'agent-bot-author',
    directedBy,
    agentAuthored,
  });
}

function gateFor({ tier, approvals, security = { status: 'clean', findings: [] } }) {
  return evaluateGate({
    headSha: HEAD,
    ledger: [],
    approvals,
    tier,
    description: checkDescription({ body: DESCRIPTION, agentAuthored: false }),
    security,
  });
}

const codesOf = (result) => result.blockers.map((entry) => entry.code);

describe('solo maintainer: the one-human path', () => {
  test('a non-sensitive High PR directed by the sole maintainer needs one human, and the gate agrees', () => {
    const tier = tierFor(HIGH_PATHS);
    expect(tier.effectiveTier).toBe('high');
    expect(tier.soloMaintainer).toEqual({ eligible: true, login: 'maintainer-m' });

    const approvals = approvalsFor(tier);
    expect(approvals).toMatchObject({
      satisfied: true,
      humansRequired: 1,
      humansCounted: 1,
      soloMaintainer: true,
      directedBy: 'maintainer-m',
    });
    expect(approvals.reasons).toContain('solo-maintainer-applied');

    const gate = gateFor({ tier, approvals });
    expect(codesOf(gate)).toEqual([]);
    expect(gate.mergeable).toBe(true);
  });

  test('the tier record carries the eligibility so the recorded decision names it', () => {
    const record = tierRecord({ assignment: assignTier({ paths: classifyPaths({ changedPaths: HIGH_PATHS, declaration: DECLARATION, baseSha: BASE }), kinds: [{ kind: 'product', paths: HIGH_PATHS }] }), effective: tierFor(HIGH_PATHS) });
    expect(record.soloMaintainer).toEqual({ eligible: true, login: 'maintainer-m' });
  });

  test('the security lane still blocks: a High solo PR whose security review did not run is refused', () => {
    const tier = tierFor(HIGH_PATHS);
    const gate = gateFor({ tier, approvals: approvalsFor(tier), security: { status: 'not-run', findings: [] } });
    expect(gate.mergeable).toBe(false);
    expect(codesOf(gate)).toContain(BLOCKER_CODES.SECURITY_REVIEW_MISSING);
  });
});

describe('solo maintainer: every other case keeps two humans', () => {
  const refused = (approvals) => {
    expect(approvals).toMatchObject({ satisfied: false, humansRequired: 2, soloMaintainer: false });
    expect(approvals.reason).toBe('insufficient-human-approvals');
  };

  test('a sensitive path (CI workflow) keeps two humans', () => {
    const tier = tierFor(['.github/workflows/ci.yml']);
    expect(tier.soloMaintainer.eligible).toBe(false);
    refused(approvalsFor(tier));
  });

  test('changing the review policy itself keeps two humans', () => {
    const tier = tierFor(['REVIEW.md']);
    expect(tier.soloMaintainer.eligible).toBe(false);
    refused(approvalsFor(tier));
  });

  test('the flag off keeps two humans', () => {
    const policy = { ...SOLO_POLICY, soloMaintainer: false };
    const tier = tierFor(HIGH_PATHS, policy);
    refused(approvalsFor(tier, { policy }));
  });

  test('a flag that is not exactly true keeps two humans', () => {
    const policy = { ...SOLO_POLICY, soloMaintainer: 'true' };
    const tier = tierFor(HIGH_PATHS, policy);
    refused(approvalsFor(tier, { policy }));
  });

  test('a tier raised to High by a second assessment asking for another person keeps two humans', () => {
    const tier = raisedTierFor({ secondAssessment: { needsAnotherPerson: true, reason: 'touches billing' } });
    expect(tier.effectiveTier).toBe('high');
    expect(tier.soloMaintainer.eligible).toBe(false);
    refused(approvalsFor(tier));
  });

  test('a tier raised to High by a proposal keeps two humans', () => {
    const tier = raisedTierFor({ proposedTier: 'high' });
    expect(tier.effectiveTier).toBe('high');
    expect(tier.soloMaintainer.eligible).toBe(false);
    refused(approvalsFor(tier));
  });

  describe('a PR already High by the owner declaration (nothing can rise)', () => {
    const highByDeclaration = (extra) => {
      const paths = classifyPaths({ changedPaths: HIGH_PATHS, declaration: DECLARATION, baseSha: BASE });
      const assignment = assignTier({ paths, kinds: [{ kind: 'product', paths: HIGH_PATHS }], ...extra });
      return effectiveTier({ assignment, policy: SOLO_POLICY, author: 'maintainer-m' });
    };

    test('a second assessment asking for another person is honoured: two humans', () => {
      const tier = highByDeclaration({ secondAssessment: { needsAnotherPerson: true, reason: 'touches billing' } });
      expect(tier.effectiveTier).toBe('high');
      refused(approvalsFor(tier));
    });

    test('an unreadable second assessment cannot say no, so it is honoured too', () => {
      refused(approvalsFor(highByDeclaration({ secondAssessment: 'looks fine' })));
    });

    test('a proposal of High is honoured: two humans', () => {
      refused(approvalsFor(highByDeclaration({ proposedTier: 'high' })));
    });

    test('a second assessment that says no leaves the rule in force', () => {
      const tier = highByDeclaration({ secondAssessment: { needsAnotherPerson: false, reason: 'reviewed' } });
      expect(approvalsFor(tier)).toMatchObject({ satisfied: true, humansRequired: 1, soloMaintainer: true });
    });
  });

  test('two maintainers keep two humans', () => {
    const policy = { ...SOLO_POLICY, maintainerLogins: ['maintainer-m', 'maintainer-n'] };
    const tier = tierFor(HIGH_PATHS, policy);
    refused(approvalsFor(tier, { policy }));
  });

  test('a PR directed by someone other than the sole maintainer keeps two humans', () => {
    const tier = tierFor(HIGH_PATHS);
    refused(approvalsFor(tier, { directedBy: 'someone-else' }));
  });

  test('a PR no agent wrote has no director, so the maintainer cannot fill the slot', () => {
    const tier = tierFor(HIGH_PATHS);
    refused(approvalsFor(tier, { agentAuthored: false }));
  });

  test('a Medium PR is untouched: the rule only ever relaxes High', () => {
    const tier = tierFor(['packages/development/lib/widget.js']);
    expect(tier.effectiveTier).toBe('medium');
    const approvals = approvalsFor(tier);
    expect(approvals).toMatchObject({ humansRequired: 1, soloMaintainer: false });
  });
});

describe('solo maintainer: the gate does not take the approvals evaluator on trust', () => {
  test('approvals that claim the solo rule on a PR the tier says is not eligible are refused as a tier mismatch', () => {
    const solo = tierFor(HIGH_PATHS);
    const forged = approvalsFor(solo); // solo-applied: humansRequired 1
    const sensitiveTier = tierFor(['.github/workflows/ci.yml']);

    const gate = gateFor({ tier: sensitiveTier, approvals: forged });
    expect(gate.mergeable).toBe(false);
    expect(codesOf(gate)).toContain(BLOCKER_CODES.APPROVALS_TIER_MISMATCH);
  });

  test('approvals that name a different director than the eligible maintainer are refused as a tier mismatch', () => {
    const tier = tierFor(HIGH_PATHS);
    const approvals = { ...approvalsFor(tier), directedBy: 'someone-else' };

    const gate = gateFor({ tier, approvals });
    expect(codesOf(gate)).toContain(BLOCKER_CODES.APPROVALS_TIER_MISMATCH);
  });

  test('approvals that lowered the count without claiming the solo rule are refused as a tier mismatch', () => {
    const tier = tierFor(HIGH_PATHS);
    const approvals = { ...approvalsFor(tier), soloMaintainer: false };

    const gate = gateFor({ tier, approvals });
    expect(codesOf(gate)).toContain(BLOCKER_CODES.APPROVALS_TIER_MISMATCH);
  });
});

describe('solo maintainer: the policy block accepts the key', () => {
  const block = (extra) =>
    ['```ensemble-review-policy', JSON.stringify({ sourceSha: BASE, maintainerLogins: ['maintainer-m'], ...extra }), '```'].join('\n');

  test('soloMaintainer: true is read, not treated as an unknown key', () => {
    const result = loadPolicy({ text: block({ soloMaintainer: true }), baseSha: BASE });
    expect(result.ok).toBe(true);
    expect(result.source).toBe('policy');
    expect(result.policy.soloMaintainer).toBe(true);
  });

  test('a non-boolean value is rejected and the safe default (off) stands', () => {
    const result = loadPolicy({ text: block({ soloMaintainer: 'yes' }), baseSha: BASE });
    expect(result.policy.soloMaintainer).toBe(false);
    expect(result.rejected.map((entry) => entry.key)).toContain('soloMaintainer');
  });
});
