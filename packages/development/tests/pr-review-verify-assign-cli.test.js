'use strict';

/**
 * Verify per candidate, through the SHIPPED entry point (kata f1w6).
 *
 * Every call is a fresh `node pr-review-cli.js <subcommand>` process fed JSON on stdin. The scenario has the
 * shape of the first measurement, PR #234: 11 candidate groups, 3 verifiers per candidate (Standard), four
 * reviewers. The subcommands run chained the way a review reaches them -- `verify-assign` plans, each agent
 * "votes" on only its own candidates, `votes` tallies against the plan, `depth` grades the plan -- and every
 * step carries the case that must be refused beside the one that passes.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'lib', 'pr-review-cli.js');

function runCli(subcommand, payload) {
  const res = spawnSync('node', subcommand === undefined ? [CLI] : [CLI, subcommand], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
  });
  const result = typeof res.stdout === 'string' && res.stdout.trim() !== '' ? JSON.parse(res.stdout) : null;
  return { code: res.status, stderr: res.stderr, result };
}

const REVIEWERS = ['r1', 'r2', 'r3', 'r4'];
const GROUPS = Array.from({ length: 11 }, (_, index) => ({
  id: `G${index + 1}`,
  severity: 'major',
  kind: 'defect',
  reviewer: REVIEWERS[index % REVIEWERS.length],
}));

/** What the verifier agents return: each votes only on the candidates it was handed. */
function castVotes(plan, verdictFor = () => 'real') {
  return GROUPS.map((group) => ({
    ...group,
    votes: plan.agents
      .filter((agent) => agent.candidates.includes(group.id))
      .map((agent) => ({ verifier: agent.verifier, verdict: verdictFor(agent.verifier, group.id) })),
  }));
}

describe('verify-assign through the CLI: the #234-shaped round (11 groups, 3 verifiers each)', () => {
  const planned = runCli('verify-assign', { candidates: GROUPS, depth: 'standard', verifierCount: 11, maxCandidatesPerVerifier: 3 });
  const plan = planned.result;

  test('plans exactly 3 distinct verifiers for each of the 11 candidates, spread over 11 small agents', () => {
    expect(planned.code).toBe(0);
    expect(planned.stderr).toBe('');
    expect(plan.ok).toBe(true);
    expect(plan.k).toBe(3);
    expect(plan.assignments).toHaveLength(11);
    for (const entry of plan.assignments) {
      expect(new Set(entry.verifiers).size).toBe(3);
    }
    // 33 verifier-slots over 11 small agents: each agent holds three candidates, not all eleven.
    expect(plan.agents).toHaveLength(11);
    expect(plan.load).toEqual({ min: 3, max: 3 });
  });

  test('chained: every assigned verifier voting confirms all 11, and the plan grades inside Standard\'s bounds', () => {
    const tally = runCli('votes', { depth: 'standard', assignment: plan.assignments, findings: castVotes(plan) });
    expect(tally.code).toBe(0);
    expect(tally.result.verification).toBe('performed');
    expect(tally.result.findings.map((entry) => entry.outcome)).toEqual(Array(11).fill('present'));

    const graded = runCli('depth', {
      tier: 'medium',
      planned: { reviewers: REVIEWERS.length, verifiers: plan.assignments },
    });
    expect(graded.result.mode).toBe('standard');
    expect(graded.result.ok).toBe(true);
    expect(graded.result.violations).toEqual([]);
  });

  test('chained: one verifier\'s vote on one candidate goes missing and ONLY that candidate stops being confirmed', () => {
    const dropped = plan.agents[0];
    const lostId = dropped.candidates[0];
    const findings = castVotes(plan).map((entry) =>
      entry.id === lostId ? { ...entry, votes: entry.votes.filter((item) => item.verifier !== dropped.verifier) } : entry
    );

    const tally = runCli('votes', { depth: 'standard', assignment: plan.assignments, findings });
    const byId = Object.fromEntries(tally.result.findings.map((entry) => [entry.id, entry]));
    expect(byId[lostId].outcome).toBe('unverified');
    expect(byId[lostId].incompleteVerifiers).toEqual([{ verifier: dropped.verifier, reason: 'no-vote' }]);
    expect(Object.values(byId).filter((entry) => entry.outcome === 'present')).toHaveLength(10);
    expect(tally.result.verification).toBe('partial');

    // Without the plan the same votes still read as a 2-of-3 majority: the plan is what catches the loss.
    const unplanned = runCli('votes', { depth: 'standard', findings });
    expect(unplanned.result.findings.find((entry) => entry.id === lostId).outcome).toBe('present');
  });

  test('chained: a duplicate vote by one verifier is refused and a vote by a stranger does not stand in for the missing one', () => {
    const [first] = plan.assignments;
    const findings = castVotes(plan).map((entry) => {
      if (entry.id !== first.id) return entry;
      const [keep, ...rest] = entry.votes;
      return { ...entry, votes: [keep, keep, { verifier: 'stranger', verdict: 'real' }, rest[0]] };
    });
    const tally = runCli('votes', { depth: 'standard', assignment: plan.assignments, findings });
    const entry = tally.result.findings.find((item) => item.id === first.id);
    expect(entry.ignoredVotes.map((item) => item.reason).sort()).toEqual(['duplicate-vote', 'not-assigned']);
    expect(entry.tally.real).toBe(2);
    expect(entry.outcome).toBe('unverified');
  });

  test('the plan graded at the wrong depth is refused: a Standard plan is below Deep\'s floor of 5', () => {
    const graded = runCli('depth', { tier: 'high', planned: { reviewers: 4, verifiers: plan.assignments } });
    expect(graded.result.mode).toBe('deep');
    expect(graded.result.ok).toBe(false);
    expect(graded.result.violations).toEqual([{ set: 'planned', role: 'verifiers', kind: 'below-minimum', bound: 5, count: 3 }]);

    const tally = runCli('votes', { depth: 'deep', assignment: plan.assignments, findings: castVotes(plan) });
    expect(tally.result.verification).toBe('blocked');
    expect(tally.result.reason).toMatch(/assigned 3 distinct verifiers but the depth expects 5/);
  });
});

describe('verify-assign through the CLI: refusals', () => {
  test('a pool smaller than K is an explicit error naming the candidates, exit 0, never a shortfall plan', () => {
    const { code, result } = runCli('verify-assign', { candidates: GROUPS.slice(0, 2), depth: 'standard', verifierPool: ['v1', 'v2'] });
    expect(code).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('verifier-pool-too-small');
    expect(result.assignments).toEqual([]);
    expect(result.shortfalls.map((entry) => entry.id)).toEqual(['G1', 'G2']);
  });

  test('a reviewer in a pool of exactly K is excluded, which leaves the candidate short', () => {
    const { result } = runCli('verify-assign', {
      candidates: [{ id: 'G1', reviewer: 'v1' }],
      depth: 'standard',
      verifierPool: ['v1', 'v2', 'v3'],
    });
    expect(result.ok).toBe(false);
    expect(result.shortfalls).toEqual([{ id: 'G1', eligible: 2, needed: 3 }]);
  });

  test('a reviewerOf sent over JSON is not a function and is refused, never silently ignored', () => {
    const { result } = runCli('verify-assign', { candidates: GROUPS.slice(0, 1), depth: 'standard', verifierCount: 3, reviewerOf: 'reviewer' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/reviewerOf must be a function/);
  });

  test('unparseable stdin exits 1 with a JSON error and writes nothing else', () => {
    const { code, result } = runCli('verify-assign', '{ not json');
    expect(code).toBe(1);
    expect(result.error).toMatch(/invalid JSON on stdin/);
  });

  test('the usage line names verify-assign, so an unknown subcommand tells the caller it exists', () => {
    const { code, result } = runCli('verify-assgin', {});
    expect(code).toBe(1);
    expect(result.error).toMatch(/\|votes\|verify-assign\|depth\|/);
  });
});
