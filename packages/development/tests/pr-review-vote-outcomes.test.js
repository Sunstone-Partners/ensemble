'use strict';

/**
 * TRD-039: Vote outcomes -- visibility, per-finding degradation and ledger
 * recording (`pr-review-votes.js`).
 *
 * Validates PRD ACs: AC-005-4, AC-006-1, AC-006-3 (REQ-005).
 *
 * These are the Implementation AC tests. The PRD-scenario tests live in
 * TRD-039-TEST.
 *
 * What is pinned here:
 *   1. a finding filtered because the verifier majority was not reached
 *      stays in `findings` (never dropped) with its tally, the threshold and
 *      an `authorLabel` of exactly "verifier disagrees" -- never "required
 *      fix" (AC-005-4, AC-006-1);
 *   2. a finding whose assigned verifiers did not all return a usable vote
 *      (timeout, tool failure) is `unverified` / `verifier-incomplete` and
 *      still presented, even when the votes that did arrive would otherwise
 *      reach a majority, while a sibling finding whose verifiers all
 *      returned keeps its ordinary tally-based outcome untouched
 *      (AC-006-3);
 *   3. `verificationCapability: false` (no subagent capability at all) marks
 *      every finding `unverified` / `no-subagent-capability`, presented, and
 *      `result.verification` is `not-performed` -- nothing is dropped on
 *      that account (AC-006-3);
 *   4. a result that is `blocked`, `not-performed` or `partial` always names
 *      `recoveryAction`.
 */

const { tallyVotes } = require('../lib/pr-review-votes');

function candidate(overrides) {
  return {
    id: 'F1',
    severity: 'important',
    reviewer: 'reviewer-a',
    kind: 'bug',
    votes: [],
    ...overrides,
  };
}

const real = (verifier) => ({ verifier, verdict: 'real' });
const notReal = (verifier) => ({ verifier, verdict: 'not-real' });

const entryOf = (result, id) => result.findings.find((entry) => entry.id === id);

describe('TRD-039 AC-005-4, AC-006-1: a finding that fails verification is "verifier disagrees", never dropped', () => {
  test('a finding whose verifiers mostly voted not-real is filtered but stays in findings with its tally and authorLabel', () => {
    const finding = candidate({
      id: 'F1',
      votes: [real('v1'), notReal('v2'), notReal('v3')],
    });
    const result = tallyVotes({ findings: [finding], depth: 'standard' });

    const entry = entryOf(result, 'F1');
    expect(entry.outcome).toBe('filtered');
    expect(entry.reason).toBe('verifier-majority-not-reached');
    expect(entry.presented).toBe(false);
    expect(entry.authorLabel).toBe('verifier disagrees');
    expect(entry.tally).toEqual({ real: 1, notReal: 2, abstain: 0, expected: 3, needed: 2 });
  });

  test('authorLabel is never set for a finding the majority voted real', () => {
    const finding = candidate({ id: 'F1', votes: [real('v1'), real('v2'), notReal('v3')] });
    const result = tallyVotes({ findings: [finding], depth: 'standard' });
    const entry = entryOf(result, 'F1');
    expect(entry.outcome).toBe('present');
    expect(entry.authorLabel).toBeUndefined();
  });
});

describe('TRD-039 AC-006-3: per-finding degradation from incomplete verifier coverage', () => {
  test('a finding with an incomplete verifier is unverified and presented even though its votes would otherwise reach a majority', () => {
    const degraded = candidate({
      id: 'F1',
      votes: [real('v1'), real('v2')],
      incompleteVerifiers: [{ verifier: 'v3', reason: 'timeout' }],
    });
    const result = tallyVotes({ findings: [degraded], depth: 'standard' });

    const entry = entryOf(result, 'F1');
    expect(entry.outcome).toBe('unverified');
    expect(entry.reason).toBe('verifier-incomplete');
    expect(entry.presented).toBe(true);
    expect(entry.authorLabel).toBe('unverified');
    expect(entry.incompleteVerifiers).toEqual([{ verifier: 'v3', reason: 'timeout' }]);
  });

  test('a sibling finding whose verifiers all returned keeps its ordinary tally-based outcome', () => {
    const degraded = candidate({ id: 'F1', votes: [real('v1'), real('v2')], incompleteVerifiers: [{ verifier: 'v3', reason: 'timeout' }] });
    const complete = candidate({ id: 'F2', votes: [real('v1'), real('v2'), notReal('v3')] });
    const result = tallyVotes({ findings: [degraded, complete], depth: 'standard' });

    expect(entryOf(result, 'F1').outcome).toBe('unverified');
    expect(entryOf(result, 'F2').outcome).toBe('present');
    expect(entryOf(result, 'F2').reason).toBe('verifier-majority');
  });

  test('the round verification state is "partial" when some but not all findings are degraded, and names a recovery action', () => {
    const degraded = candidate({ id: 'F1', votes: [], incompleteVerifiers: [{ verifier: 'v1', reason: 'timeout' }] });
    const complete = candidate({ id: 'F2', votes: [real('v1'), real('v2'), real('v3')] });
    const result = tallyVotes({ findings: [degraded, complete], depth: 'standard' });

    expect(result.verification).toBe('partial');
    expect(result.reason).toBe('some-verifiers-did-not-return');
    expect(result.recoveryAction).toBe('supply-the-missing-votes');
    expect(result.findings).toHaveLength(2);
  });

  test('the round verification state is "not-performed" when every finding is degraded', () => {
    const degraded = candidate({ id: 'F1', votes: [], incompleteVerifiers: [{ verifier: 'v1', reason: 'timeout' }] });
    const result = tallyVotes({ findings: [degraded], depth: 'standard' });

    expect(result.verification).toBe('not-performed');
    expect(result.reason).toBe('verifier-incomplete');
    expect(result.recoveryAction).toBe('supply-the-missing-votes');
  });

  test('a malformed incompleteVerifiers entry is ignored, not read as a crash or a silent pass', () => {
    const finding = candidate({ id: 'F1', votes: [real('v1'), real('v2'), real('v3')], incompleteVerifiers: ['not-an-object', { reason: 'no verifier name' }] });
    const result = tallyVotes({ findings: [finding], depth: 'standard' });
    expect(entryOf(result, 'F1').outcome).toBe('present');
  });
});

describe('TRD-039 AC-006-3: no subagent capability at all', () => {
  test('verificationCapability:false marks every finding unverified and presented, and nothing is dropped', () => {
    const findings = [candidate({ id: 'F1' }), candidate({ id: 'F2', votes: [real('v1'), real('v2'), real('v3')] })];
    const result = tallyVotes({ findings, depth: 'standard', verificationCapability: false });

    expect(result.verification).toBe('not-performed');
    expect(result.reason).toBe('no-subagent-capability');
    expect(result.recoveryAction).toBe('re-run-verification');
    expect(result.findings).toHaveLength(2);
    for (const entry of result.findings) {
      expect(entry.outcome).toBe('unverified');
      expect(entry.reason).toBe('no-subagent-capability');
      expect(entry.presented).toBe(true);
      expect(entry.authorLabel).toBe('unverified');
    }
    expect(result.presented.map((entry) => entry.id).sort()).toEqual(['F1', 'F2']);
  });

  test('no subagent capability overrides even a Quick-depth round the same way', () => {
    const result = tallyVotes({ findings: [candidate({ id: 'F1' })], depth: 'quick', verificationCapability: false });
    expect(result.verification).toBe('not-performed');
    expect(result.reason).toBe('no-subagent-capability');
    expect(entryOf(result, 'F1').reason).toBe('no-subagent-capability');
  });
});

describe('TRD-039: a blocked result also names a recovery action', () => {
  test('a structurally invalid request is blocked with recoveryAction "re-run-verification"', () => {
    const result = tallyVotes({ findings: 'not-an-array', depth: 'standard' });
    expect(result.ok).toBe(false);
    expect(result.verification).toBe('blocked');
    expect(result.recoveryAction).toBe('re-run-verification');
  });
});

describe('TRD-039: depth Quick still carries a recovery action', () => {
  test('Quick depth is not-performed with recoveryAction "re-run-verification"', () => {
    const result = tallyVotes({ findings: [candidate({ id: 'F1' })], depth: 'quick' });
    expect(result.verification).toBe('not-performed');
    expect(result.reason).toBe('depth-quick-no-verifiers');
    expect(result.recoveryAction).toBe('re-run-verification');
    expect(entryOf(result, 'F1').authorLabel).toBe('unverified');
  });
});
