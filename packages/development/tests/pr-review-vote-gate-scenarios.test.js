'use strict';

/**
 * TRD-021-TEST: Vote gate fails when broken (PRD scenarios).
 *
 * Verifies TRD-021 (the gate-can-fail proofs for the verification vote
 * threshold). Validates PRD ACs: AC-025-1, AC-025-2 (REQ-025).
 *
 * TRD-021 shipped two mutation guards in pr-review-cycle-mutation.test.js
 * (Guard 10a: the majority comparison relaxed to a single vote; Guard 10b:
 * the critical/security bypass dropped). This file states the PRD scenarios
 * those guards exist for, and proves them three ways that do not depend on
 * one another:
 *
 *   1. BEHAVIOUR -- the shipped `tallyVotes` refuses the bad case and admits
 *      the good one on the same call shape (AC-025-2: never only the
 *      direction that says yes).
 *   2. THE THRESHOLD IS A VARIABLE, NOT A CONSTANT -- moving the expected
 *      verifier count moves the verdict for an unchanged set of votes. A gate
 *      whose answer never moves is a constant wearing a gate's name.
 *   3. THE BROKEN GATE IS ACTUALLY BROKEN -- the same two mutations the TRD-021
 *      guards apply are compiled HERE, in memory, from the real source text,
 *      and the mutant is shown to produce the outcome the shipped module
 *      refuses. This proves the assertions in the contract tests are
 *      load-bearing without re-running the (slow) subprocess harness, and it
 *      fails loudly if the source is reworded so an anchor stops matching.
 *
 * The source-level control/mutant subprocess proofs themselves stay in
 * pr-review-cycle-mutation.test.js; the inventory block at the end pins that
 * both guards are still there and still aimed at these two failure modes.
 *
 * TRD Reference: docs/TRD/TRD-2026-70e784f2-code-review-process.md#trd-021-test
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { tallyVotes, majorityOf, EXPECTED_VERIFIERS } = require('../lib/pr-review-votes');

const VOTES_PATH = path.join(__dirname, '..', 'lib', 'pr-review-votes.js');
const HARNESS_PATH = path.join(__dirname, 'pr-review-cycle-mutation.test.js');
const VOTES_SOURCE = fs.readFileSync(VOTES_PATH, 'utf8');

const vote = (verifier, verdict) => ({ verifier, verdict });

/** A candidate finding with the fields the tally reads. */
function finding(overrides = {}) {
  return { id: 'F1', severity: 'major', kind: 'defect', reviewer: 'r1', votes: [], ...overrides };
}

const outcomeOf = (result, id = 'F1') => (result.findings.find((entry) => entry.id === id) || {}).outcome;

/**
 * Compiles the real `pr-review-votes.js` source with one mutation applied, in
 * this process, and returns its `tallyVotes`. The mutation must change the
 * text (an anchor that no longer matches is an error, never a silent pass)
 * and the mutant must still compile -- a module that merely fails to load
 * would "fail" every test without proving anything.
 */
function mutantTally(anchor, replacement) {
  expect(VOTES_SOURCE).toContain(anchor);
  const mutated = VOTES_SOURCE.split(anchor).join(replacement);
  expect(mutated).not.toBe(VOTES_SOURCE);

  const module = { exports: {} };
  const wrapper = vm.runInThisContext(`(function (exports, module, require, __filename, __dirname) {${mutated}\n})`, {
    filename: `${VOTES_PATH}#mutant`,
  });
  wrapper(module.exports, module, require, VOTES_PATH, path.dirname(VOTES_PATH));

  expect(typeof module.exports.tallyVotes).toBe('function');
  return module.exports.tallyVotes;
}

describe('Scenario AC-025-1: the verification vote threshold fails when it is deliberately broken', () => {
  const minorityVotes = [vote('v1', 'real'), vote('v2', 'not-real'), vote('v3', 'not-real')];

  test('the shipped threshold refuses a finding only one of three verifiers called real', () => {
    const result = tallyVotes({ findings: [finding({ votes: minorityVotes })], depth: 'standard' });

    expect(outcomeOf(result)).toBe('filtered');
    expect(result.findings[0].reason).toBe('verifier-majority-not-reached');
    expect(result.presented).toEqual([]);
  });

  test('a threshold relaxed to a single vote -- the TRD-021 Guard 10a mutation -- presents that same finding', () => {
    const broken = mutantTally('if (votes.counted.real >= needed) {', 'if (votes.counted.real >= 1) {');
    const result = broken({ findings: [finding({ votes: minorityVotes })], depth: 'standard' });

    // The mutant is exactly the failure the gate exists to prevent: an
    // unverified finding reaching the author as "verified".
    expect(outcomeOf(result)).toBe('present');
    expect(result.findings[0].reason).toBe('verifier-majority');

    // And the shipped module, on the identical input, still refuses it.
    expect(outcomeOf(tallyVotes({ findings: [finding({ votes: minorityVotes })], depth: 'standard' }))).toBe('filtered');
  });

  test('a threshold set to always pass -- expected verifiers forced to 0 -- cannot produce a verified finding either', () => {
    const result = tallyVotes({ findings: [finding({ votes: minorityVotes })], depth: 'standard', expectedVerifiers: 0 });

    // Zero expected verifiers is "nobody verified", never "everybody agreed":
    // the finding is presented, but marked unverified, never `present`.
    expect(outcomeOf(result)).toBe('unverified');
    expect(result.findings[0].presented).toBe(true);
    expect(result.verification).toBe('not-performed');
  });

  test('the threshold is a variable, not a constant: the same two real votes flip with the expected count', () => {
    const votes = [vote('v1', 'real'), vote('v2', 'real'), vote('v3', 'not-real')];

    expect(outcomeOf(tallyVotes({ findings: [finding({ votes })], depth: 'standard' }))).toBe('present');
    expect(outcomeOf(tallyVotes({ findings: [finding({ votes })], depth: 'deep', expectedVerifiers: 5 }))).toBe('filtered');
    expect(majorityOf(EXPECTED_VERIFIERS.standard)).toBe(2);
    expect(majorityOf(EXPECTED_VERIFIERS.deep)).toBe(3);
  });

  test('the denominator is the expected verifier count, so missing verifiers are never read as agreement', () => {
    const oneRealVoteOnly = tallyVotes({ findings: [finding({ votes: [vote('v1', 'real')] })], depth: 'deep' });

    expect(outcomeOf(oneRealVoteOnly)).toBe('filtered');
    expect(oneRealVoteOnly.findings[0].tally).toMatchObject({ real: 1, expected: 5, needed: 3 });
  });
});

describe('Scenario AC-025-2: the vote gate is proven in both directions, including the critical bypass', () => {
  const rejectedByAll = [vote('v1', 'not-real'), vote('v2', 'not-real'), vote('v3', 'not-real')];

  test('the trivial passing case: a majority of real votes presents the finding', () => {
    const result = tallyVotes({
      findings: [finding({ votes: [vote('v1', 'real'), vote('v2', 'real'), vote('v3', 'not-real')] })],
      depth: 'standard',
    });

    expect(outcomeOf(result)).toBe('present');
    expect(result.presented.map((entry) => entry.id)).toEqual(['F1']);
  });

  test('the second case that must be refused: an ordinary finding every verifier rejected is filtered', () => {
    const result = tallyVotes({ findings: [finding({ votes: rejectedByAll })], depth: 'standard' });

    expect(outcomeOf(result)).toBe('filtered');
    expect(result.presented).toEqual([]);
  });

  test('a security finding every verifier rejected is NOT closed by the vote: it is disputed and presented', () => {
    const result = tallyVotes({
      findings: [finding({ id: 'S1', security: true, votes: rejectedByAll })],
      depth: 'standard',
    });

    expect(outcomeOf(result, 'S1')).toBe('disputed');
    expect(result.findings[0].reason).toBe('security-finding-not-verified');
    expect(result.presented.map((entry) => entry.id)).toEqual(['S1']);
  });

  test('dropping the critical bypass -- the TRD-021 Guard 10b mutation -- would let a vote close a security finding', () => {
    const broken = mutantTally(
      '    if (isSecurityLane(finding)) {\n      // Critical and security-relevant findings are never closed by a vote:',
      '    if (false) {\n      // Critical and security-relevant findings are never closed by a vote:'
    );
    const result = broken({ findings: [finding({ id: 'S1', security: true, votes: rejectedByAll })], depth: 'standard' });

    expect(outcomeOf(result, 'S1')).toBe('filtered');
    expect(result.presented).toEqual([]);

    // The shipped module refuses to do that on the identical input.
    const shipped = tallyVotes({ findings: [finding({ id: 'S1', security: true, votes: rejectedByAll })], depth: 'standard' });
    expect(outcomeOf(shipped, 'S1')).toBe('disputed');
  });

  test('the bypass is reached by every spelling of the security lane, not just one flag', () => {
    for (const variant of [{ security: true }, { lane: 'security' }, { severity: 'critical' }]) {
      const result = tallyVotes({ findings: [finding({ id: 'S1', votes: rejectedByAll, ...variant })], depth: 'standard' });
      expect(outcomeOf(result, 'S1')).toBe('disputed');
    }
  });

  test('a mutant that changes nothing is rejected by this file, so no proof here can be vacuous', () => {
    expect(() => mutantTally('if (votes.counted.real >= needed) {', 'if (votes.counted.real >= needed) {')).toThrow();
    expect(() => mutantTally('a-phrase-the-votes-module-never-contains', 'x')).toThrow();
  });
});

describe('Inventory: TRD-021 still carries both source-level guards for this gate', () => {
  const HARNESS = fs.readFileSync(HARNESS_PATH, 'utf8');

  test('the mutation harness names a guard for the verification vote threshold', () => {
    expect(HARNESS).toMatch(/describe\('Guard \d+[a-z/\d]*: verification vote threshold/);
  });

  test('both failure modes are guarded: the relaxed majority and the dropped critical bypass', () => {
    expect(HARNESS).toContain("id: 'Guard 10a'");
    expect(HARNESS).toContain("id: 'Guard 10b'");
    expect(HARNESS).toContain('1 of 3 real votes does not present it: it is filtered as verifier-rejected');
    expect(HARNESS).toContain('a security finding rejected by every verifier is disputed, not filtered');
  });

  test('each guarded contract test still exists in the votes contract suite', () => {
    const contract = fs.readFileSync(path.join(__dirname, 'pr-review-votes.test.js'), 'utf8');

    expect(contract).toContain('1 of 3 real votes does not present it: it is filtered as verifier-rejected');
    expect(contract).toContain('a security finding rejected by every verifier is disputed, not filtered');
  });

  test('both mutation anchors still match the shipped source, so a reword cannot silently unguard it', () => {
    expect(VOTES_SOURCE).toContain('if (votes.counted.real >= needed) {');
    expect(VOTES_SOURCE).toContain('    if (isSecurityLane(finding)) {');
  });
});
