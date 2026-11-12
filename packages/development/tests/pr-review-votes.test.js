'use strict';

/**
 * TRD-016: Vote tally core -- majority, non-findings and critical bypass
 * (`pr-review-votes.js`).
 *
 * Validates PRD ACs: AC-005-1, AC-005-2, AC-006-2 (REQ-005, REQ-006). These
 * are the Implementation AC tests; the PRD-scenario tests live in
 * TRD-016-TEST.
 *
 * What is pinned here:
 *   1. a finding is `present` only when a STRICT MAJORITY of the depth's
 *      EXPECTED verifiers voted it real -- 2 of 3 at Standard, 3 of 5 at Deep
 *      -- so missing votes can never be read as agreement (AC-005-1);
 *   2. a verifier may not verify its own finding, and a verdict outside
 *      real / not-real / abstain is not a vote at all;
 *   3. style-only, diagnostic and cleanup findings are `filtered` with reason
 *      `non-finding`: the author is never asked to answer them (AC-005-2);
 *   4. a critical or security-relevant finding that splits or is rejected is
 *      `disputed` and still presented for a human to adjudicate (AC-006-2).
 *
 * Fail closed throughout: nothing is dropped, an unreadable finding stays
 * visible as `unverified`, and no request this module cannot read produces a
 * `present` finding.
 */

const { tallyVotes, EXPECTED_VERIFIERS, majorityOf } = require('../lib/pr-review-votes');

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
const abstain = (verifier) => ({ verifier, verdict: 'abstain' });

const outcomeOf = (result, id) => result.findings.find((entry) => entry.id === id).outcome;

describe('TRD-016 AC-005-1: present needs a strict majority of the expected verifiers', () => {
  test('the expected verifier count comes from the depth: Quick 0, Standard 3, Deep 5', () => {
    expect(EXPECTED_VERIFIERS).toEqual({ quick: 0, standard: 3, deep: 5 });
    expect(majorityOf(3)).toBe(2);
    expect(majorityOf(5)).toBe(3);
  });

  test('2 of 3 real votes at Standard presents the finding', () => {
    const result = tallyVotes({
      depth: 'standard',
      findings: [candidate({ votes: [real('v1'), real('v2'), notReal('v3')] })],
    });

    expect(result.ok).toBe(true);
    expect(result.verification).toBe('performed');
    expect(outcomeOf(result, 'F1')).toBe('present');
    expect(result.findings[0].tally).toEqual({ real: 2, notReal: 1, abstain: 0, expected: 3, needed: 2 });
  });

  test('1 of 3 real votes does not present it: it is filtered as verifier-rejected', () => {
    const result = tallyVotes({
      depth: 'standard',
      findings: [candidate({ votes: [real('v1'), notReal('v2'), notReal('v3')] })],
    });

    expect(outcomeOf(result, 'F1')).toBe('filtered');
    expect(result.findings[0].reason).toBe('verifier-majority-not-reached');
  });

  test('missing votes are never agreement: 2 real votes out of 5 expected at Deep is not a majority', () => {
    const result = tallyVotes({
      depth: 'deep',
      findings: [candidate({ votes: [real('v1'), real('v2')] })],
    });

    expect(outcomeOf(result, 'F1')).not.toBe('present');
    expect(result.findings[0].tally).toEqual({ real: 2, notReal: 0, abstain: 0, expected: 5, needed: 3 });
  });

  test('3 of 5 real votes at Deep presents it; abstentions never fill the gap', () => {
    const presented = tallyVotes({
      depth: 'deep',
      findings: [candidate({ votes: [real('v1'), real('v2'), real('v3'), abstain('v4'), abstain('v5')] })],
    });
    expect(outcomeOf(presented, 'F1')).toBe('present');

    const abstained = tallyVotes({
      depth: 'deep',
      findings: [candidate({ votes: [real('v1'), real('v2'), abstain('v3'), abstain('v4'), abstain('v5')] })],
    });
    expect(outcomeOf(abstained, 'F1')).not.toBe('present');
  });

  test('a verifier may not verify its own finding: that vote does not count', () => {
    const result = tallyVotes({
      depth: 'standard',
      findings: [candidate({ reviewer: 'v1', votes: [real('v1'), real('v2'), notReal('v3')] })],
    });

    expect(result.findings[0].tally.real).toBe(1);
    expect(result.findings[0].ignoredVotes).toEqual([{ verifier: 'v1', reason: 'own-finding' }]);
    expect(outcomeOf(result, 'F1')).toBe('filtered');
  });

  test('a verdict outside real, not-real and abstain is not a vote', () => {
    const result = tallyVotes({
      depth: 'standard',
      findings: [candidate({ votes: [real('v1'), { verifier: 'v2', verdict: 'probably' }, { verifier: 'v3', verdict: true }] })],
    });

    expect(result.findings[0].tally).toEqual({ real: 1, notReal: 0, abstain: 0, expected: 3, needed: 2 });
    expect(result.findings[0].ignoredVotes).toEqual([
      { verifier: 'v2', reason: 'unknown-verdict' },
      { verifier: 'v3', reason: 'unknown-verdict' },
    ]);
    expect(outcomeOf(result, 'F1')).not.toBe('present');
  });

  test('one verifier cannot vote twice to make a majority', () => {
    const result = tallyVotes({
      depth: 'standard',
      findings: [candidate({ votes: [real('v1'), real('v1'), real('v1')] })],
    });

    expect(result.findings[0].tally.real).toBe(1);
    expect(result.findings[0].ignoredVotes).toEqual([
      { verifier: 'v1', reason: 'duplicate-vote' },
      { verifier: 'v1', reason: 'duplicate-vote' },
    ]);
    expect(outcomeOf(result, 'F1')).not.toBe('present');
  });

  test('an explicit expectedVerifiers count overrides the depth default, but never below the votes cast', () => {
    const result = tallyVotes({
      depth: 'standard',
      expectedVerifiers: 5,
      findings: [candidate({ votes: [real('v1'), real('v2')] })],
    });

    expect(result.findings[0].tally.expected).toBe(5);
    expect(outcomeOf(result, 'F1')).not.toBe('present');
  });

  test('at Quick no verifier is expected, so findings are unverified and still presented, never silently "present"', () => {
    const result = tallyVotes({ depth: 'quick', findings: [candidate({})] });

    expect(result.verification).toBe('not-performed');
    expect(result.reason).toBe('depth-quick-no-verifiers');
    expect(outcomeOf(result, 'F1')).toBe('unverified');
  });
});

describe('TRD-016 AC-005-2: style, diagnostic and cleanup findings are filtered as non-findings', () => {
  test.each(['style', 'diagnostic', 'cleanup'])('a %s finding is filtered with reason non-finding', (kind) => {
    const result = tallyVotes({
      depth: 'standard',
      findings: [candidate({ kind, votes: [real('v1'), real('v2'), real('v3')] })],
    });

    expect(outcomeOf(result, 'F1')).toBe('filtered');
    expect(result.findings[0].reason).toBe('non-finding');
  });

  test('a non-finding is filtered even when every verifier called it real -- it still needs no answer', () => {
    const result = tallyVotes({
      depth: 'deep',
      findings: [candidate({ kind: 'style', votes: [real('v1'), real('v2'), real('v3'), real('v4'), real('v5')] })],
    });
    expect(outcomeOf(result, 'F1')).toBe('filtered');
  });

  test('negative control: a bug finding with the same votes is presented', () => {
    const result = tallyVotes({
      depth: 'standard',
      findings: [candidate({ kind: 'bug', votes: [real('v1'), real('v2'), real('v3')] })],
    });
    expect(outcomeOf(result, 'F1')).toBe('present');
  });

  test('a security finding is never treated as a non-finding, whatever kind it claims', () => {
    const result = tallyVotes({
      depth: 'standard',
      findings: [candidate({ kind: 'style', security: true, votes: [notReal('v1'), notReal('v2'), notReal('v3')] })],
    });
    expect(outcomeOf(result, 'F1')).toBe('disputed');
  });
});

describe('TRD-016 AC-006-2: a critical or security finding that splits or is rejected is disputed', () => {
  test('a security finding rejected by every verifier is disputed, not filtered', () => {
    const result = tallyVotes({
      depth: 'standard',
      findings: [candidate({ security: true, votes: [notReal('v1'), notReal('v2'), notReal('v3')] })],
    });

    expect(outcomeOf(result, 'F1')).toBe('disputed');
    expect(result.findings[0].reason).toBe('security-finding-not-verified');
  });

  test('a critical finding on a split vote is disputed and presented for human adjudication', () => {
    const result = tallyVotes({
      depth: 'deep',
      findings: [candidate({ severity: 'critical', votes: [real('v1'), real('v2'), notReal('v3'), notReal('v4'), abstain('v5')] })],
    });

    expect(outcomeOf(result, 'F1')).toBe('disputed');
    expect(result.findings[0].presented).toBe(true);
  });

  test('a security finding that does reach the majority is simply present', () => {
    const result = tallyVotes({
      depth: 'standard',
      findings: [candidate({ security: true, votes: [real('v1'), real('v2'), notReal('v3')] })],
    });
    expect(outcomeOf(result, 'F1')).toBe('present');
  });

  test('present and disputed findings are presented; a filtered one is not', () => {
    const result = tallyVotes({
      depth: 'standard',
      findings: [
        candidate({ id: 'P', votes: [real('v1'), real('v2')] }),
        candidate({ id: 'D', security: true, votes: [notReal('v1'), notReal('v2'), notReal('v3')] }),
        candidate({ id: 'N', kind: 'style', votes: [real('v1'), real('v2')] }),
      ],
    });

    expect(result.findings.map((entry) => [entry.id, entry.presented])).toEqual([
      ['P', true],
      ['D', true],
      ['N', false],
    ]);
    expect(result.presented.map((entry) => entry.id)).toEqual(['P', 'D']);
  });
});

describe('TRD-016: fail closed -- nothing is dropped and nothing is waved through', () => {
  test('every finding handed in comes back out, whatever its outcome', () => {
    const result = tallyVotes({
      depth: 'standard',
      findings: [candidate({ id: 'A' }), candidate({ id: 'B', kind: 'style' }), candidate({ id: 'C', security: true })],
    });
    expect(result.findings.map((entry) => entry.id)).toEqual(['A', 'B', 'C']);
  });

  test('a finding this module cannot read stays visible as unverified, never filtered away', () => {
    const result = tallyVotes({
      depth: 'standard',
      findings: [candidate({ id: 'A', votes: 'all of them' }), candidate({ id: 'B', votes: [null] })],
    });

    expect(outcomeOf(result, 'A')).toBe('unverified');
    expect(result.findings[0].reason).toBe('unreadable-votes');
    expect(outcomeOf(result, 'B')).toBe('unverified');
    expect(result.findings.every((entry) => entry.presented)).toBe(true);
  });

  test('a request it cannot read is refused, never an empty pass', () => {
    for (const bad of [null, undefined, [], 'standard', 7, {}, { findings: {} }, { findings: [], depth: 'shallow' }]) {
      const result = tallyVotes(bad);
      expect(result.ok).toBe(false);
      expect(result.verification).toBe('blocked');
      expect(Array.isArray(result.findings)).toBe(true);
      expect(result.findings.every((entry) => entry.outcome !== 'present')).toBe(true);
    }
  });

  test('an unknown depth is refused rather than defaulting to the cheapest verification', () => {
    const result = tallyVotes({ depth: 'light', findings: [candidate({ votes: [real('v1'), real('v2')] })] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/depth/);
  });

  test('a finding with no id is refused: an outcome that cannot be attributed is no outcome', () => {
    const result = tallyVotes({ depth: 'standard', findings: [{ severity: 'important', votes: [] }] });
    expect(result.ok).toBe(false);
  });
});

describe('incomplete verification and malformed security flags', () => {
  test.each([
    ['zero votes', []],
    ['only unknown verdicts', [{ verifier: 'v1', verdict: 'maybe' }, { verifier: 'v2', verdict: 'x' }, { verifier: 'v3', verdict: 'y' }]],
    ['only unnamed verifiers', [{ verdict: 'not-real' }, { verdict: 'not-real' }, { verdict: 'not-real' }]],
  ])('%s: unverified, verifier-incomplete, presented', (_name, votes) => {
    const result = tallyVotes({ depth: 'standard', findings: [candidate({ votes })] });
    const entry = result.findings[0];
    expect(entry.outcome).toBe('unverified');
    expect(entry.reason).toBe('verifier-incomplete');
    expect(entry.presented).toBe(true);
    expect(result.verification).not.toBe('performed');
  });

  test('a full set of usable votes without a majority stays filtered', () => {
    const result = tallyVotes({ depth: 'standard', findings: [candidate({ votes: [notReal('v1'), notReal('v2'), real('v3')] })] });
    expect(result.findings[0].outcome).toBe('filtered');
    expect(result.findings[0].reason).toBe('verifier-majority-not-reached');
    expect(result.verification).toBe('performed');
  });

  test.each([
    ['security "true"', { security: 'true' }],
    ['security "yes"', { security: 'yes' }],
    ['security 1', { security: 1 }],
    ['lane "Security"', { lane: 'Security' }],
    ['critical "true"', { critical: 'true' }],
  ])('%s goes to the security lane, never filtered', (_name, flags) => {
    const result = tallyVotes({
      depth: 'standard',
      findings: [candidate({ ...flags, votes: [notReal('v1'), notReal('v2'), notReal('v3')] })],
    });
    expect(result.findings[0].outcome).toBe('disputed');
    expect(result.findings[0].presented).toBe(true);
  });
});
