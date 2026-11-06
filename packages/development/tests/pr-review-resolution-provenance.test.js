'use strict';

/**
 * Resolution provenance (kata wbcv, plan 3H items 3-4).
 *
 * The merge gate must stop reading "any text reason" as an answer to an
 * Important or security finding. It honours a recorded resolution only when
 * the resolution names a reason, the login that decided (`by`), a timestamp
 * (`at`) and the head commit it was decided against, equal to the gate's head.
 *
 * HONEST LIMIT, stated in the test names on purpose: these tests prove "a
 * reason is present, decided by a NAMED LOGIN, bound to THIS HEAD". Nothing
 * here (or in the code) proves a human typed it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { evaluateGate, BLOCKER_CODES } = require('../lib/pr-review-gate');
const { recordResolution, recordOperatorResolution } = require('../lib/pr-review-ledger');

const CLI = path.join(__dirname, '..', 'lib', 'pr-review-cli.js');
const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const AT = '2026-11-06T10:00:00Z';

function finding(overrides = {}) {
  return {
    id: 'F-1',
    source: 'code-reviewer',
    locationOrLink: 'packages/development/lib/widget.js:12',
    severity: 'important',
    failureMode: 'unchecked input reaches the widget',
    disposition: 'fix',
    evidence: 'line 12 reads the payload without validating it',
    originalTextOrLink: 'https://example.invalid/pr/1#discussion_r1',
    ...overrides,
  };
}

function gateInput(overrides = {}) {
  return {
    headSha: HEAD,
    ledger: [],
    approvals: {
      ok: true,
      headSha: HEAD,
      satisfied: true,
      reason: 'required-approvals-present',
      tier: 'medium',
      humansRequired: 1,
      humansCounted: 1,
      approvedBy: ['human-a'],
      directedBy: null,
      ignored: [],
      refusals: [],
      reasons: [],
      warnings: [],
    },
    tier: { ok: true, tier: 'medium', effectiveTier: 'medium', humansRequired: 1, refusals: [], reasons: [], warnings: [] },
    description: { ok: true, missing: [], present: ['testing', 'risk', 'rollback'], empty: [], ready: true, warnings: [] },
    security: { status: 'clean', findings: [] },
    ...overrides,
  };
}

const decision = (overrides = {}) => ({ reason: 'the caller validates it upstream', by: 'ldangelo', headSha: HEAD, at: AT, ...overrides });
const resolved = (base, overrides) => ({ ...base, disposition: 'resolved', resolution: decision(overrides) });

describe('recordOperatorResolution refuses a decision that lacks provenance', () => {
  test.each([
    ['reason', { reason: '   ' }],
    ['by', { by: undefined }],
    ['by', { by: 'the review agent on behalf of the user' }],
    ['headSha', { headSha: undefined }],
    ['at', { at: undefined }],
    ['at', { at: 'yesterday-ish' }],
  ])('a missing or unreadable %s is refused and the finding stays unresolved', (_name, bad) => {
    const result = recordOperatorResolution(finding(), decision(bad));

    expect(result.ok).toBe(false);
    expect(result.finding.resolution).toBeUndefined();
    expect(result.finding.disposition).toBe('fix');
  });

  test('a complete decision is recorded with the login, head and timestamp it was given', () => {
    const result = recordOperatorResolution(finding(), decision());

    expect(result.ok).toBe(true);
    expect(result.finding.disposition).toBe('resolved');
    expect(result.finding.resolution).toEqual(decision());
  });
});

describe('AC1: an Important or security finding is closed only by a stated reason', () => {
  test('a blocking finding cannot be accepted without a reason, so the gate still refuses it', () => {
    const refused = recordOperatorResolution(finding(), decision({ reason: '' }));
    expect(refused.ok).toBe(false);

    const result = evaluateGate(gateInput({ ledger: [refused.finding] }));
    expect(result.mergeable).toBe(false);
    expect(result.findings.open).toEqual(['F-1']);
  });

  test('a security finding cannot be closed without a reason, so the gate still refuses it', () => {
    const refused = recordOperatorResolution(finding({ id: 'S-1' }), decision({ reason: '' }));
    expect(refused.ok).toBe(false);

    const result = evaluateGate(gateInput({ security: { status: 'findings', findings: [refused.finding] } }));
    expect(result.mergeable).toBe(false);
    expect(result.securityLane.open).toEqual(['S-1']);
  });
});

describe('AC2: the gate honours a resolution only with a named login on THIS head (decided by a login, not proven human)', () => {
  test('a resolution with every part, bound to the gate head: the Important finding stops blocking', () => {
    const result = evaluateGate(gateInput({ ledger: [resolved(finding())] }));

    expect(result.mergeable).toBe(true);
    expect(result.findings.open).toEqual([]);
  });

  test.each([
    ['no deciding login (by)', { by: undefined }],
    ['a by that is prose, not a login', { by: 'the agent, on the user\u2019s behalf' }],
    ['no head binding (headSha)', { headSha: undefined }],
    ['a head that is not the current one', { headSha: OLD_HEAD }],
    ['no timestamp (at)', { at: undefined }],
  ])('an Important resolution with %s still blocks, and the blocker says why', (_name, bad) => {
    const result = evaluateGate(gateInput({ ledger: [resolved(finding(), bad)] }));

    expect(result.mergeable).toBe(false);
    expect(result.findings.open).toEqual(['F-1']);
    const blocker = result.blockers.find((entry) => entry.code === BLOCKER_CODES.OPEN_IMPORTANT_FINDING);
    expect(blocker.resolutionRejected).toEqual(expect.any(String));
    expect(blocker.message).toContain('does not count');
  });

  test('the head match ignores letter case and padding, so a differently-cased copy of the same sha is the same head', () => {
    const upper = HEAD.toUpperCase();
    const result = evaluateGate(gateInput({ ledger: [resolved(finding(), { headSha: `  ${upper} ` })] }));

    expect(result.mergeable).toBe(true);
  });

  test.each([
    ['no deciding login (by)', { by: undefined }],
    ['a head that is not the current one', { headSha: OLD_HEAD }],
    ['no timestamp (at)', { at: undefined }],
  ])('a security-lane resolution with %s still blocks', (_name, bad) => {
    const lane = { status: 'findings', findings: [resolved(finding({ id: 'S-1' }), bad)] };
    const result = evaluateGate(gateInput({ security: lane }));

    expect(result.mergeable).toBe(false);
    expect(result.securityLane.open).toEqual(['S-1']);
    expect(result.securityLane.resolved).toEqual([]);
    const blocker = result.blockers.find((entry) => entry.code === BLOCKER_CODES.SECURITY_FINDING_OPEN);
    expect(blocker.resolutionRejected).toEqual(expect.any(String));
  });

  test('a security-lane resolution with full provenance on this head stops blocking and is recorded', () => {
    const lane = { status: 'findings', findings: [resolved(finding({ id: 'S-1' }))] };
    const result = evaluateGate(gateInput({ security: lane }));

    expect(result.mergeable).toBe(true);
    expect(result.securityLane.resolved).toEqual([{ id: 'S-1', reason: 'the caller validates it upstream' }]);
  });

  test('a bare recordResolution (reason only, the old shape) no longer unblocks an Important finding', () => {
    const legacy = recordResolution(finding(), { reason: 'ok', by: 'author-a' });
    expect(legacy.ok).toBe(true);

    const result = evaluateGate(gateInput({ ledger: [legacy.finding] }));
    expect(result.mergeable).toBe(false);
  });

  test('an unrecognised-severity finding is held to the same provenance rule', () => {
    const odd = resolved(finding({ severity: 'whoops' }), { by: undefined });
    const result = evaluateGate(gateInput({ ledger: [odd] }));

    expect(result.mergeable).toBe(false);
    expect(result.blockers.map((entry) => entry.code)).toContain(BLOCKER_CODES.OPEN_UNRECOGNISED_FINDING);
  });

  test('a Nit or Pre-existing finding never needed an answer: its resolution is not held to provenance', () => {
    const nit = resolved(finding({ id: 'N-1', severity: 'nit' }), { by: undefined, headSha: undefined });
    const preExisting = resolved(finding({ id: 'P-1', severity: 'pre-existing' }), { by: undefined });
    const result = evaluateGate(gateInput({ ledger: [nit, preExisting] }));

    expect(result.mergeable).toBe(true);
  });

  test('a resolution without provenance does not turn a later head into a pass: a new head makes the old decision stale', () => {
    const decided = resolved(finding(), { headSha: OLD_HEAD });
    const atOldHead = evaluateGate(gateInput({ headSha: OLD_HEAD, ledger: [decided], approvals: undefined }));
    // The approvals result is bound to HEAD, so the old-head gate is not mergeable for that reason;
    // what matters here is that the FINDING is no longer open at the head it was decided on, and is open on the next.
    expect(atOldHead.findings.open).toEqual([]);

    const atNewHead = evaluateGate(gateInput({ ledger: [decided] }));
    expect(atNewHead.findings.open).toEqual(['F-1']);
  });
});

describe('AC4: `ledger resolve` through the real CLI round-trips through state and the gate reads it', () => {
  function runCli(args, payload) {
    const run = spawnSync('node', [CLI, ...args], { input: JSON.stringify(payload), encoding: 'utf8' });
    return { status: run.status, out: JSON.parse(run.stdout) };
  }

  test('resolve -> state-write -> state-read -> gate: the recorded decision unblocks only the head it was made on', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-resolution-'));
    try {
      const resolveRun = runCli(['ledger'], { action: 'resolve', finding: finding(), resolution: decision() });
      expect(resolveRun.status).toBe(0);
      const recorded = resolveRun.out.finding;
      expect(recorded.resolution).toEqual(decision());

      const written = runCli(['state-write'], { prId: '1', cwd, state: { headSha: HEAD, ledger: [recorded] } });
      expect(written.out.ok).toBe(true);
      const read = runCli(['state-read'], { prId: '1', cwd, headSha: HEAD });
      expect(read.out.discarded).toBe(false);
      const { ledger } = read.out.state;
      expect(ledger).toHaveLength(1);
      expect(ledger[0].resolution).toEqual(decision());

      const atHead = runCli(['gate'], gateInput({ ledger }));
      expect(atHead.out.findings.open).toEqual([]);
      expect(atHead.out.mergeable).toBe(true);

      const moved = runCli(['gate'], gateInput({ ledger, headSha: 'c'.repeat(40) }));
      expect(moved.out.findings.open).toEqual(['F-1']);
      expect(moved.out.mergeable).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('resolve with a missing `by` is refused with exit 1 and no finding comes back', () => {
    const run = runCli(['ledger'], { action: 'resolve', finding: finding(), resolution: decision({ by: undefined }) });

    expect(run.status).toBe(1);
    expect(run.out.error).toContain("'by'");
    expect(run.out.finding).toBeUndefined();
  });

  test('the gate answers with the decision list next to its verdict, and the list never changes the verdict', () => {
    const run = runCli(['gate'], gateInput({ ledger: [finding(), finding({ id: 'N-1', severity: 'nit', locationOrLink: 'a.js:3' })] }));
    const bare = evaluateGate(gateInput({ ledger: [finding(), finding({ id: 'N-1', severity: 'nit', locationOrLink: 'a.js:3' })] }));

    expect(run.out.dispositionChoices.map((entry) => entry.id)).toEqual(['F-1', 'N-1']);
    const { dispositionChoices, dispositionGroups, mergeConfirmation, ...verdict } = run.out;
    expect(verdict).toEqual(JSON.parse(JSON.stringify(bare)));
    expect(dispositionGroups).toEqual(expect.any(Array));
    expect(mergeConfirmation).toEqual(expect.any(Object));
  });
});
