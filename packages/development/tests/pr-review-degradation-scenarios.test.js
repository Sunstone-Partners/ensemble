'use strict';

/**
 * TRD-039-TEST: Visible, degradable verification outcomes (PRD scenarios).
 *
 * Validates PRD ACs: AC-005-4 (REQ-005), AC-006-1, AC-006-3 (REQ-006).
 *
 * The Implementation AC tests for the outcome fields live in
 * pr-review-vote-outcomes.test.js and call the library in process. These are
 * the PRD-LEVEL scenarios, run the way the pr-review-cycle skill reaches
 * verification since TRD-018: a FRESH `node pr-review-cli.js votes` process,
 * whose result is then handed to a FRESH `node pr-review-cli.js ledger`
 * process exactly as the skill records a round. Nothing is carried between
 * the two in this test's memory, so a finding can only reach the ledger
 * because the process put it there.
 *
 * Scenarios:
 *   - AC-005-4: a finding the verifiers rejected reaches the author as
 *     "verifier disagrees", with the reason -- not as something to fix.
 *   - AC-006-1: that same finding is still in the ledger, with its votes and
 *     the reason it was not presented.
 *   - AC-006-3: when verification cannot run -- no subagent capability, or a
 *     verifier that timed out or failed -- findings are presented marked
 *     "unverified", the round says verification was not performed (or only
 *     partially), and nothing is dropped.
 */

const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'packages/development/lib/pr-review-cli.js');

/** One verification pass, in its own process. */
function verify(payload) {
  const out = execFileSync('node', [CLI, 'votes'], { input: JSON.stringify(payload), encoding: 'utf8', cwd: REPO_ROOT });
  return JSON.parse(out);
}

/** One recorded review round, in its own process -- the skill's next step after verification. */
function recordRound(incoming, round = 1, ledger = []) {
  const out = execFileSync('node', [CLI, 'ledger'], {
    input: JSON.stringify({ action: 'recordRound', ledger, incoming, round }),
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  return JSON.parse(out);
}

const vote = (verifier, verdict) => ({ verifier, verdict });

function candidate(overrides = {}) {
  return {
    id: 'F1',
    severity: 'important',
    reviewer: 'reviewer-a',
    failureMode: 'unchecked array index',
    locationOrLink: 'packages/development/lib/a.js:10',
    votes: [],
    ...overrides,
  };
}

/** Three verifiers, one of whom calls it real: a genuine failed verification, not an absent one. */
const REJECTED_VOTES = [vote('v1', 'real'), vote('v2', 'not-real'), vote('v3', 'not-real')];

const byId = (entries, id) => entries.find((entry) => entry.id === id);

describe('Scenario AC-005-4: a finding that fails verification reads as "verifier disagrees", not as a required fix', () => {
  test('the author-facing label is the verifiers\' disagreement, and the reason is named', () => {
    const result = verify({ depth: 'standard', findings: [candidate({ votes: REJECTED_VOTES })] });

    const finding = byId(result.findings, 'F1');
    expect(finding.authorLabel).toBe('verifier disagrees');
    expect(finding.reason).toBe('verifier-majority-not-reached');
    expect(finding.outcome).toBe('filtered');
  });

  test('it is not put to the author as work: it is not in the presented set', () => {
    const result = verify({ depth: 'standard', findings: [candidate({ votes: REJECTED_VOTES })] });

    expect(result.presented.map((entry) => entry.id)).not.toContain('F1');
    expect(byId(result.findings, 'F1').presented).toBe(false);
  });

  test('negative control: the same finding the verifiers accept IS a required fix, with no disagreement label', () => {
    const result = verify({
      depth: 'standard',
      findings: [candidate({ votes: [vote('v1', 'real'), vote('v2', 'real'), vote('v3', 'not-real')] })],
    });

    const finding = byId(result.findings, 'F1');
    expect(finding.outcome).toBe('present');
    expect(finding.presented).toBe(true);
    expect(finding.authorLabel).toBeUndefined();
  });
});

describe('Scenario AC-006-1: a finding filtered out by verification is still in the ledger, with its votes and the reason', () => {
  test('the record the ledger receives carries the votes, the tally and the reason it was not presented', () => {
    const verified = verify({ depth: 'standard', findings: [candidate({ votes: REJECTED_VOTES })] });
    const recorded = recordRound(verified.findings);

    expect(recorded.ok).toBe(true);
    const entry = byId(recorded.findings, 'F1');
    expect(entry).toBeDefined();
    expect(entry.votes).toEqual(REJECTED_VOTES);
    expect(entry.tally).toMatchObject({ real: 1, notReal: 2, expected: 3, needed: 2 });
    expect(entry.reason).toBe('verifier-majority-not-reached');
    expect(entry.presented).toBe(false);
    expect(entry.authorLabel).toBe('verifier disagrees');
  });

  test('nothing is dropped on the way to the ledger: every verified finding is recorded, presented or not', () => {
    const verified = verify({
      depth: 'standard',
      findings: [
        candidate({ id: 'REJECTED', votes: REJECTED_VOTES }),
        candidate({ id: 'ACCEPTED', locationOrLink: 'b.js:2', failureMode: 'null deref', votes: [vote('v1', 'real'), vote('v2', 'real'), vote('v3', 'abstain')] }),
        candidate({ id: 'NON-FINDING', kind: 'style', locationOrLink: 'c.js:3', failureMode: 'naming', votes: [vote('v1', 'real'), vote('v2', 'real'), vote('v3', 'real')] }),
      ],
    });
    expect(verified.findings).toHaveLength(3);

    const recorded = recordRound(verified.findings);
    expect(recorded.findings.map((entry) => entry.id).sort()).toEqual(['ACCEPTED', 'NON-FINDING', 'REJECTED']);
    // Each one still says why it ended where it did.
    expect(byId(recorded.findings, 'REJECTED').reason).toBe('verifier-majority-not-reached');
    expect(byId(recorded.findings, 'NON-FINDING').reason).toBe('non-finding');
    expect(byId(recorded.findings, 'ACCEPTED').reason).toBe('verifier-majority');
  });
});

describe('Scenario AC-006-3: verification that cannot run leaves findings presented and marked "unverified"', () => {
  test('no subagent capability: every finding is unverified, presented, and the round says verification was not performed', () => {
    const result = verify({
      depth: 'standard',
      verificationCapability: false,
      findings: [candidate({ id: 'A' }), candidate({ id: 'B', locationOrLink: 'b.js:2', failureMode: 'null deref' })],
    });

    expect(result.verification).toBe('not-performed');
    expect(result.reason).toBe('no-subagent-capability');
    expect(result.recoveryAction).toBe('re-run-verification');
    expect(result.findings).toHaveLength(2);
    for (const entry of result.findings) {
      expect(entry.outcome).toBe('unverified');
      expect(entry.authorLabel).toBe('unverified');
      expect(entry.presented).toBe(true);
    }
    expect(result.presented.map((entry) => entry.id).sort()).toEqual(['A', 'B']);
  });

  test('a verifier that timed out or failed degrades that finding only, and the round reports partial verification', () => {
    const result = verify({
      depth: 'standard',
      findings: [
        candidate({
          id: 'TIMED-OUT',
          // The votes that did arrive would have been a majority; incomplete
          // coverage must still not let it pass as verified.
          votes: [vote('v1', 'real'), vote('v2', 'real')],
          incompleteVerifiers: [{ verifier: 'v3', reason: 'timeout' }],
        }),
        candidate({
          id: 'COMPLETE',
          locationOrLink: 'b.js:2',
          failureMode: 'null deref',
          votes: [vote('v1', 'real'), vote('v2', 'real'), vote('v3', 'not-real')],
        }),
      ],
    });

    const degraded = byId(result.findings, 'TIMED-OUT');
    expect(degraded.outcome).toBe('unverified');
    expect(degraded.reason).toBe('verifier-incomplete');
    expect(degraded.authorLabel).toBe('unverified');
    expect(degraded.presented).toBe(true);

    // Its sibling is untouched: degradation is per finding, not per round.
    expect(byId(result.findings, 'COMPLETE').outcome).toBe('present');

    expect(result.verification).toBe('partial');
    expect(result.reason).toBe('some-verifiers-did-not-return');
    expect(result.recoveryAction).toBe('supply-the-missing-votes');
  });

  test('an unverified finding reaches the ledger too: it is recorded with its reason, never dropped on that account', () => {
    const verified = verify({ depth: 'standard', verificationCapability: false, findings: [candidate({ id: 'U' })] });
    const recorded = recordRound(verified.findings);

    const entry = byId(recorded.findings, 'U');
    expect(entry).toBeDefined();
    expect(entry.outcome).toBe('unverified');
    expect(entry.reason).toBe('no-subagent-capability');
    expect(recorded.presented.map((item) => item.id)).toContain('U');
  });

  test('the status is stated, never implied: a round with verification it could not run never reports "performed"', () => {
    const noCapability = verify({ depth: 'standard', verificationCapability: false, findings: [candidate()] });
    const quick = verify({ depth: 'quick', findings: [candidate()] });
    const allDegraded = verify({
      depth: 'standard',
      findings: [candidate({ votes: [vote('v1', 'real')], incompleteVerifiers: [{ verifier: 'v2', reason: 'tool-failure' }] })],
    });

    for (const result of [noCapability, quick, allDegraded]) {
      expect(result.verification).toBe('not-performed');
      expect(typeof result.reason).toBe('string');
      expect(typeof result.recoveryAction).toBe('string');
      expect(result.findings.every((entry) => entry.presented)).toBe(true);
    }
    expect(quick.reason).toBe('depth-quick-no-verifiers');
    expect(allDegraded.reason).toBe('verifier-incomplete');
  });
});
