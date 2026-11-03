'use strict';

/**
 * TRD-016-TEST: Vote majority and critical bypass (PRD scenarios).
 *
 * Validates PRD ACs: AC-005-1, AC-005-2 (REQ-005), AC-006-2 (REQ-006).
 *
 * The Implementation AC tests for `tallyVotes` live in pr-review-votes.test.js
 * and call the library in process. These are the PRD-LEVEL scenarios, run the
 * way the pr-review-cycle skill actually reaches verification since TRD-018: a
 * FRESH `node pr-review-cli.js votes` process per round, one depth at a time,
 * so a finding can only be presented because the votes said so -- never
 * because an object in this test's memory carried an answer over.
 *
 * Scenarios:
 *   - AC-005-1: every finding is voted on by verifiers who did not produce it,
 *     and reaches the author only on a majority of the verifiers the DEPTH
 *     expects (0 at Quick, 3 at Standard, 5 at Deep) -- not of the votes that
 *     happened to arrive.
 *   - AC-005-2: purely stylistic, diagnostic or cleanup findings are not put
 *     to the author as something to answer.
 *   - AC-006-2: a critical or security-relevant finding that the verifiers
 *     split on or reject is still presented, marked disputed, for a person to
 *     adjudicate.
 */

const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'packages/development/lib/pr-review-cli.js');

const { EXPECTED_VERIFIERS } = require('../lib/pr-review-votes');

/** One verification pass, in its own process. */
function verify(payload) {
  const out = execFileSync('node', [CLI, 'votes'], { input: JSON.stringify(payload), encoding: 'utf8', cwd: REPO_ROOT });
  return JSON.parse(out);
}

const vote = (verifier, verdict) => ({ verifier, verdict });

/** `count` verifiers voting `verdict`, named v1..vN so none of them is the reviewer. */
const votes = (count, verdict) => Array.from({ length: count }, (unused, index) => vote(`v${index + 1}`, verdict));

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

const outcomeOf = (result, id) => result.findings.find((entry) => entry.id === id).outcome;
const presentedIds = (result) => result.presented.map((entry) => entry.id);

describe('Scenario AC-005-1: a finding reaches the author only on a majority of the depth\'s verifiers', () => {
  test('the depth decides how many verifiers are expected: Quick 0, Standard 3, Deep 5', () => {
    expect(EXPECTED_VERIFIERS).toEqual({ quick: 0, standard: 3, deep: 5 });

    const standard = verify({ depth: 'standard', findings: [candidate({ votes: votes(3, 'real') })] });
    const deep = verify({ depth: 'deep', findings: [candidate({ votes: votes(3, 'real') })] });

    expect(standard.findings[0].tally).toMatchObject({ expected: 3, needed: 2 });
    expect(deep.findings[0].tally).toMatchObject({ expected: 5, needed: 3 });
  });

  test('two of three verifiers calling it real presents it at Standard; one of three does not', () => {
    const majority = verify({
      depth: 'standard',
      findings: [candidate({ id: 'MAJ', votes: [vote('v1', 'real'), vote('v2', 'real'), vote('v3', 'not-real')] })],
    });
    const minority = verify({
      depth: 'standard',
      findings: [candidate({ id: 'MIN', votes: [vote('v1', 'real'), vote('v2', 'not-real'), vote('v3', 'not-real')] })],
    });

    expect([outcomeOf(majority, 'MAJ'), presentedIds(majority)]).toEqual(['present', ['MAJ']]);
    expect([outcomeOf(minority, 'MIN'), presentedIds(minority)]).toEqual(['filtered', []]);
    expect(minority.findings[0].reason).toBe('verifier-majority-not-reached');
  });

  test('the SAME two real votes are not a majority at Deep: the denominator is what the depth expects', () => {
    const payload = { findings: [candidate({ id: 'D1', votes: [vote('v1', 'real'), vote('v2', 'real')] })] };

    expect(outcomeOf(verify({ ...payload, depth: 'standard' }), 'D1')).toBe('present');
    expect(outcomeOf(verify({ ...payload, depth: 'deep' }), 'D1')).toBe('filtered');
  });

  test('verifiers that never returned are never agreement -- a finding cannot be presented by silence', () => {
    const result = verify({ depth: 'deep', findings: [candidate({ id: 'S1', votes: [vote('v1', 'real'), vote('v2', 'real'), vote('v3', 'abstain')] })] });

    expect(outcomeOf(result, 'S1')).toBe('filtered');
    expect(result.findings[0].tally).toMatchObject({ real: 2, abstain: 1, expected: 5, needed: 3 });
  });

  test('a verifier may not verify its own finding: the reviewer\'s own vote is ignored and named', () => {
    const result = verify({
      depth: 'standard',
      findings: [candidate({ id: 'OWN', reviewer: 'reviewer-a', votes: [vote('reviewer-a', 'real'), vote('v2', 'real'), vote('v3', 'not-real')] })],
    });

    expect(outcomeOf(result, 'OWN')).toBe('filtered');
    expect(result.findings[0].ignoredVotes).toContainEqual({ verifier: 'reviewer-a', reason: 'own-finding' });
  });

  test('one verifier cannot vote twice to manufacture a majority', () => {
    const result = verify({
      depth: 'standard',
      findings: [candidate({ id: 'DUP', votes: [vote('v1', 'real'), vote('v1', 'real'), vote('v2', 'not-real')] })],
    });

    expect(outcomeOf(result, 'DUP')).toBe('filtered');
    expect(result.findings[0].ignoredVotes).toContainEqual({ verifier: 'v1', reason: 'duplicate-vote' });
  });

  test('at Quick no verifier is expected, so nothing is presented AS VERIFIED -- it is marked unverified instead', () => {
    const result = verify({ depth: 'quick', findings: [candidate({ id: 'Q1', votes: votes(3, 'real') })] });

    expect(outcomeOf(result, 'Q1')).toBe('unverified');
    expect(presentedIds(result)).toEqual(['Q1']);
    expect(result.verification).toBe('not-performed');
    expect(result.reason).toBe('depth-quick-no-verifiers');
  });

  test('a whole round at Standard: the majority finding is asked, the rejected one is not', () => {
    const result = verify({
      depth: 'standard',
      findings: [
        candidate({ id: 'A', votes: [vote('v1', 'real'), vote('v2', 'real'), vote('v3', 'real')] }),
        candidate({ id: 'B', reviewer: 'reviewer-b', votes: [vote('v1', 'not-real'), vote('v2', 'not-real'), vote('v3', 'real')] }),
      ],
    });

    expect(presentedIds(result)).toEqual(['A']);
    expect(result.findings).toHaveLength(2);
    expect(outcomeOf(result, 'B')).toBe('filtered');
  });
});

describe('Scenario AC-005-2: stylistic, diagnostic and cleanup findings are not put to the author', () => {
  test.each(['style', 'diagnostic', 'cleanup'])('a %s finding is filtered as a non-finding, even with every vote real', (kind) => {
    const result = verify({ depth: 'standard', findings: [candidate({ id: 'N1', kind, severity: 'nit', votes: votes(3, 'real') })] });

    expect(outcomeOf(result, 'N1')).toBe('filtered');
    expect(result.findings[0].reason).toBe('non-finding');
    expect(presentedIds(result)).toEqual([]);
  });

  test('negative control: a defect with the same votes IS put to the author', () => {
    const result = verify({ depth: 'standard', findings: [candidate({ id: 'D1', kind: 'bug', votes: votes(3, 'real') })] });

    expect(outcomeOf(result, 'D1')).toBe('present');
    expect(presentedIds(result)).toEqual(['D1']);
  });

  test('a filtered non-finding is still in the ledger with its votes, so nothing is lost by filtering it', () => {
    const result = verify({ depth: 'standard', findings: [candidate({ id: 'N1', kind: 'style', votes: votes(3, 'real') })] });

    const entry = result.findings[0];
    expect(entry.tally).toMatchObject({ real: 3, expected: 3, needed: 2 });
    expect(entry.locationOrLink).toBe('packages/development/lib/a.js:10');
  });

  test('a security finding is never excused as a non-finding, whatever kind it claims to be', () => {
    const result = verify({
      depth: 'standard',
      findings: [candidate({ id: 'S1', kind: 'style', security: true, votes: [vote('v1', 'not-real'), vote('v2', 'not-real'), vote('v3', 'not-real')] })],
    });

    expect(outcomeOf(result, 'S1')).toBe('disputed');
    expect(presentedIds(result)).toEqual(['S1']);
  });
});

describe('Scenario AC-006-2: a critical or security finding that splits or is rejected is still presented, disputed', () => {
  test('every verifier rejects a security finding and a person still has to decide', () => {
    const result = verify({
      depth: 'standard',
      findings: [candidate({ id: 'SEC', security: true, votes: votes(3, 'not-real') })],
    });

    expect(outcomeOf(result, 'SEC')).toBe('disputed');
    expect(result.findings[0].reason).toBe('security-finding-not-verified');
    expect(presentedIds(result)).toEqual(['SEC']);
  });

  test('a critical finding on a split vote is disputed, not quietly dropped', () => {
    const result = verify({
      depth: 'deep',
      findings: [candidate({ id: 'CRIT', severity: 'critical', votes: [vote('v1', 'real'), vote('v2', 'not-real'), vote('v3', 'not-real'), vote('v4', 'abstain'), vote('v5', 'abstain')] })],
    });

    expect(outcomeOf(result, 'CRIT')).toBe('disputed');
    expect(presentedIds(result)).toEqual(['CRIT']);
  });

  test('a security finding that DOES reach the majority is simply present: dispute is for disagreement', () => {
    const result = verify({ depth: 'standard', findings: [candidate({ id: 'SEC', security: true, votes: votes(3, 'real') })] });

    expect(outcomeOf(result, 'SEC')).toBe('present');
  });

  test('an ordinary rejected finding is filtered while the security one beside it is disputed', () => {
    const result = verify({
      depth: 'standard',
      findings: [
        candidate({ id: 'ORD', votes: votes(3, 'not-real') }),
        candidate({ id: 'SEC', security: true, votes: votes(3, 'not-real') }),
      ],
    });

    expect([outcomeOf(result, 'ORD'), outcomeOf(result, 'SEC')]).toEqual(['filtered', 'disputed']);
    expect(presentedIds(result)).toEqual(['SEC']);
  });

  test('nothing handed to verification is ever lost: every candidate comes back with an outcome', () => {
    const result = verify({
      depth: 'standard',
      findings: [
        candidate({ id: 'A', votes: votes(3, 'real') }),
        candidate({ id: 'B', votes: votes(3, 'not-real') }),
        candidate({ id: 'C', kind: 'style', votes: votes(3, 'real') }),
        candidate({ id: 'D', security: true, votes: votes(3, 'not-real') }),
        candidate({ id: 'E', votes: 'two of them said yes' }),
      ],
    });

    expect(result.findings.map((entry) => entry.id)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(result.findings.map((entry) => entry.outcome)).toEqual(['present', 'filtered', 'filtered', 'disputed', 'unverified']);
    expect(presentedIds(result)).toEqual(['A', 'D', 'E']);
  });
});
