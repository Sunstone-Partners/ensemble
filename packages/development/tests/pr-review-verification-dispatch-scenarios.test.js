'use strict';

/**
 * TRD-040-TEST: Verification dispatch and degraded modes (PRD scenarios).
 *
 * Validates PRD ACs: AC-005-3 (REQ-005), AC-006-4 (REQ-006).
 *
 * TRD Reference: docs/TRD/TRD-2026-70e784f2-code-review-process.md#trd-040-test
 * PRD Reference: docs/PRD/PRD-2026-70e784f2-code-review-process.md#req-005
 *
 * The Implementation AC tests for TRD-040's prose live in
 * pr-review-verification-dispatch-skill.test.js; the per-module outcome tests
 * live in pr-review-votes.test.js and pr-review-vote-outcomes.test.js. These
 * are the PRD-LEVEL scenarios for the DISPATCH itself: what actually happens
 * to a CodeRabbit comment once review runs on the same PR, and what the author
 * is handed when the runtime cannot dispatch a second reviewer at all.
 *
 * They are run the way a review really reaches verification:
 *
 *   - every grading call is a FRESH `node pr-review-cli.js <subcommand>`
 *     PROCESS fed the payload the skill documents on stdin, chained in the
 *     skill's own order (ledger validate -> dedupe -> recordRound -> votes ->
 *     state-write -> state-read), so no answer can survive in this test's
 *     memory between steps;
 *   - the reduced-review notice is read out of the SHIPPED SKILL and compared
 *     with what the state report carries, so the two can never drift;
 *   - "nothing was edited, resolved or suppressed" is proven against the
 *     shipped surface -- the libraries the skill may call -- not asserted.
 *
 * Scenarios:
 *   - AC-005-3: CodeRabbit's findings on the same PR enter the same ledger and
 *     receive the same verification, and no CodeRabbit comment is edited,
 *     resolved or suppressed.
 *   - AC-006-4: a runtime with no multi-reviewer capability still reviews, in
 *     a single pass, and the report carries a visible reduced-review notice.
 */

const fs = require('fs');
const { readSkillBundle } = require('./helpers/pr-review-cycle-skill');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const LIB_DIR = path.join(__dirname, '..', 'lib');
const CLI = path.join(LIB_DIR, 'pr-review-cli.js');
const SKILL_PATH = path.join(__dirname, '..', 'skills', 'pr-review-cycle', 'SKILL.md');
const SKILL = readSkillBundle();

/** The bot login a host repository configures in BOT_LOGINS. */
const BOT = 'coderabbitai[bot]';

/** One CLI call, in its own process: one JSON payload in, one JSON object out. */
function cli(subcommand, payload, options = {}) {
  const run = spawnSync('node', [CLI, subcommand], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: options.cwd || REPO_ROOT,
  });
  expect([subcommand, run.status, run.stderr]).toEqual([subcommand, 0, '']);
  return JSON.parse(run.stdout);
}

function tmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-dispatch-'));
}

/** A ledger-shaped candidate, as a local reviewer subagent reports one. */
function candidate(overrides = {}) {
  return {
    id: 'F1',
    source: 'reviewer-a',
    reviewer: 'reviewer-a',
    locationOrLink: 'packages/development/lib/pr-review-votes.js:140',
    severity: 'important',
    failureMode: 'unchecked array index',
    disposition: 'fix',
    evidence: 'the loop indexes votes[i + 1] without a length check',
    originalTextOrLink: 'local-reviewer-a-note-1',
    ...overrides,
  };
}

/**
 * A CodeRabbit comment converted into a ledger entry exactly as Step 3 of the
 * skill documents: the bot's login as `source`, the file and line it anchored
 * to as `locationOrLink`, and the PERMALINK of the comment it came from as
 * `originalTextOrLink` -- so the thread stays reachable from the ledger.
 */
function botCandidate(overrides = {}) {
  return candidate({
    id: 'CR1',
    source: BOT,
    reviewer: BOT,
    locationOrLink: 'packages/development/lib/pr-review-gate.js:88',
    severity: 'important',
    failureMode: 'null dereference',
    evidence: 'gate reads approvals.length before checking approvals is an array',
    originalTextOrLink: 'https://github.com/acme/app/pull/7#discussion_r1',
    ...overrides,
  });
}

const vote = (verifier, verdict) => ({ verifier, verdict });
const MAJORITY = [vote('v1', 'real'), vote('v2', 'real'), vote('v3', 'not-real')];
const REJECTED = [vote('v1', 'real'), vote('v2', 'not-real'), vote('v3', 'not-real')];
const byId = (entries, id) => entries.find((entry) => entry.id === id);

describe('Scenario AC-005-3: CodeRabbit findings enter the same ledger and the same verification', () => {
  test('a converted bot comment is a valid ledger entry on the same terms as a local reviewer\'s finding', () => {
    const validated = cli('ledger', { action: 'validate', findings: [candidate(), botCandidate()] });

    expect(validated.ok).toBe(true);
    expect(validated.offendingIds).toEqual([]);
  });

  test('an incomplete bot comment is rejected for completion, never quietly dropped from the ledger', () => {
    const noAnchor = botCandidate({ id: 'CR-bad', locationOrLink: '' });
    const validated = cli('ledger', { action: 'validate', findings: [candidate(), noAnchor] });

    expect(validated.ok).toBe(false);
    expect(validated.offendingIds).toEqual(['CR-bad']);
  });

  test('the bot\'s entry keeps its source and the permalink back to the comment it came from', () => {
    const deduped = cli('ledger', { action: 'dedupe', findings: [botCandidate()] });

    expect(deduped.findings).toHaveLength(1);
    expect(deduped.findings[0].source).toBe(BOT);
    expect(deduped.findings[0].originalTextOrLink).toBe('https://github.com/acme/app/pull/7#discussion_r1');
  });

  test('a local reviewer and CodeRabbit on the same defect merge into one fix, and BOTH original links survive', () => {
    const sameAnchor = { locationOrLink: 'packages/development/lib/pr-review-gate.js:88', failureMode: 'null dereference' };
    const deduped = cli('ledger', {
      action: 'dedupe',
      findings: [
        candidate({ id: 'F9', originalTextOrLink: 'local-reviewer-a-note-9', ...sameAnchor }),
        botCandidate({ id: 'CR9' }),
      ],
    });

    expect(deduped.findings).toHaveLength(1);
    expect(deduped.findings[0].originalLinks.sort()).toEqual([
      'https://github.com/acme/app/pull/7#discussion_r1',
      'local-reviewer-a-note-9',
    ]);
  });

  test('the bot\'s finding is recorded in the same round ledger, and a repeat is suppressed BY NAME, not deleted', () => {
    const roundOne = cli('ledger', { action: 'recordRound', ledger: [], incoming: [candidate(), botCandidate()], round: 1 });

    expect(roundOne.findings.map((entry) => entry.id).sort()).toEqual(['CR1', 'F1']);
    expect(roundOne.newFindings.map((entry) => entry.id).sort()).toEqual(['CR1', 'F1']);

    const roundTwo = cli('ledger', {
      action: 'recordRound',
      ledger: roundOne.findings,
      incoming: [botCandidate({ id: 'CR1-again' })],
      round: 2,
    });

    expect(roundTwo.repeats).toHaveLength(1);
    expect(roundTwo.newFindings).toEqual([]);
    expect(roundTwo.findings.map((entry) => entry.id)).toContain('CR1');
  });

  test('the bot\'s finding is verified by the same majority rule, with the same denominator', () => {
    const result = cli('votes', {
      depth: 'standard',
      findings: [
        { ...candidate(), votes: MAJORITY },
        { ...botCandidate(), votes: MAJORITY },
      ],
    });

    expect(result.ok).toBe(true);
    expect(byId(result.findings, 'CR1')).toMatchObject({ outcome: 'present', presented: true });
    expect(byId(result.findings, 'CR1').tally).toMatchObject({ real: 2, notReal: 1, expected: 3 });
    // Identical facts, identical outcome: who raised it changed nothing.
    expect(byId(result.findings, 'CR1').outcome).toBe(byId(result.findings, 'F1').outcome);
  });

  test('a bot finding is NOT pre-trusted: the verifiers can refuse it, exactly as they refuse a human\'s', () => {
    const result = cli('votes', { depth: 'standard', findings: [{ ...botCandidate(), votes: REJECTED }] });

    const finding = byId(result.findings, 'CR1');
    expect(finding.outcome).toBe('filtered');
    expect(finding.authorLabel).toBe('verifier disagrees');
    expect(result.presented.map((entry) => entry.id)).not.toContain('CR1');
    // Refused is not erased: the record, its votes and the reason stay auditable.
    expect(finding.reason).toBe('verifier-majority-not-reached');
    expect(finding.votes).toHaveLength(3);
  });

  test('a bot finding is NOT pre-dismissed either: an unverified one still reaches the author, marked', () => {
    const result = cli('votes', {
      depth: 'standard',
      findings: [{ ...botCandidate(), votes: [vote('v1', 'real'), vote('v2', 'real')], incompleteVerifiers: [{ verifier: 'v3', reason: 'timeout' }] }],
    });

    const finding = byId(result.findings, 'CR1');
    expect(finding.outcome).toBe('unverified');
    expect(finding.reason).toBe('verifier-incomplete');
    expect(result.presented.map((entry) => entry.id)).toContain('CR1');
    expect(result.recoveryAction).toBe('supply-the-missing-votes');
  });

  test('CodeRabbit does not get to verify its own finding -- its vote on it is not counted as agreement', () => {
    const result = cli('votes', {
      depth: 'standard',
      findings: [{ ...botCandidate(), votes: [vote(BOT, 'real'), vote('v2', 'real'), vote('v3', 'not-real')] }],
    });

    const finding = byId(result.findings, 'CR1');
    expect(finding.tally.real).toBe(1);
    expect(finding.outcome).not.toBe('present');
  });

  test('no CodeRabbit comment can be edited, resolved or suppressed: nothing on this surface can write to GitHub', () => {
    const reviewLibs = fs.readdirSync(LIB_DIR).filter((name) => /^pr-review-.*\.js$/.test(name));
    expect(reviewLibs.length).toBeGreaterThan(5);

    for (const name of reviewLibs) {
      const source = fs.readFileSync(path.join(LIB_DIR, name), 'utf8');
      // No process spawning (so no `gh`), no HTTP client, no socket: a module
      // that cannot reach GitHub cannot minimise, resolve or delete a comment.
      for (const forbidden of ['child_process', 'require(\'https\')', 'require("https")', 'fetch(', 'XMLHttpRequest']) {
        expect([name, forbidden, source.includes(forbidden)]).toEqual([name, forbidden, false]);
      }
    }
  });

  test('the remote step READS the bot\'s thread and returns a verdict -- it never acts on the thread', () => {
    const thread = { id: 'PRRT_1', resolved: false };
    const facts = {
      headSha: 'a'.repeat(40),
      botLogins: [BOT],
      reviews: [{ author: BOT, state: 'COMMENTED', commit: 'a'.repeat(40) }],
      comments: [{ author: BOT, commit: 'a'.repeat(40), body: 'possible null dereference' }],
      threads: [thread],
      checkRuns: [],
    };
    const result = cli('remote', facts);

    // Every key it answers with is an observation about what was read.
    expect(Object.keys(result).sort()).toEqual(['collected', 'reasons', 'remotePhase', 'unresolvedThreads', 'unverifiable']);
    // The bot's unresolved thread comes back EXACTLY as it was supplied -- it is
    // reported as still unresolved, never resolved, edited or dropped on its behalf.
    expect(result.unresolvedThreads).toEqual([thread]);
    expect(result.remotePhase).toBe('REMOTE_REVIEW_PENDING');
    expect(result.reasons).toContain('unresolved review threads remain');
  });

  test('the skill a maintainer reads says the same thing the surface enforces', () => {
    const flat = SKILL.replace(/\s+/g, ' ');
    expect(flat).toContain('A bot finding is never pre-trusted into `present` and never pre-dismissed');
    expect(flat).toContain('Never edit, resolve, minimise, hide, delete or `@coderabbitai resolve` a CodeRabbit comment');
    expect(flat).toContain('never push a commit whose purpose is to make one disappear');
  });
});

describe('Scenario AC-006-4: a runtime with no multi-reviewer capability reviews once, visibly reduced', () => {
  /** What the single pass found: a real round of candidates, not an empty one. */
  const singlePass = [
    { ...candidate({ id: 'S1' }), votes: [] },
    { ...candidate({ id: 'S2', locationOrLink: 'packages/development/lib/pr-review-tier.js:40', severity: 'nit' }), votes: [] },
    { ...botCandidate({ id: 'S3' }), votes: [] },
  ];

  test('the CLI refuses to call a one-reviewer pass a conforming Standard review -- which is why a notice is owed', () => {
    const graded = cli('depth', { tier: 'medium', used: { reviewers: 1, verifiers: 0 } });

    expect(graded.mode).toBe('standard');
    expect(graded.ok).toBe(false);
    expect(graded.violations.map((entry) => entry.role).sort()).toEqual(['reviewers', 'verifiers']);
  });

  test('the review still runs: every candidate the single pass found reaches the author, marked unverified', () => {
    const result = cli('votes', { depth: 'standard', findings: singlePass, verificationCapability: false });

    expect(result.ok).toBe(true);
    expect(result.findings.map((entry) => entry.id).sort()).toEqual(['S1', 'S2', 'S3']);
    for (const finding of result.findings) {
      expect([finding.id, finding.outcome, finding.reason]).toEqual([finding.id, 'unverified', 'no-subagent-capability']);
      expect([finding.id, finding.authorLabel]).toEqual([finding.id, 'unverified']);
    }
    // Nothing is dropped on the degraded path (REQ-006).
    expect(result.presented.map((entry) => entry.id).sort()).toEqual(['S1', 'S2', 'S3']);
  });

  test('the round says verification was NOT performed, and names what to do about it', () => {
    const result = cli('votes', { depth: 'standard', findings: singlePass, verificationCapability: false });

    expect(result.verification).toBe('not-performed');
    expect(result.recoveryAction).toBe('re-run-verification');
  });

  test('negative control: with capability, the same candidates ARE verified and some are refused', () => {
    const verified = cli('votes', {
      depth: 'standard',
      findings: [
        { ...candidate({ id: 'S1' }), votes: MAJORITY },
        { ...candidate({ id: 'S2', locationOrLink: 'packages/development/lib/pr-review-tier.js:40' }), votes: REJECTED },
      ],
    });

    expect(verified.verification).toBe('performed');
    expect(byId(verified.findings, 'S1').outcome).toBe('present');
    expect(byId(verified.findings, 'S2').outcome).toBe('filtered');
    expect(verified.recoveryAction).toBeUndefined();
  });

  test('the report carries the reduced-review notice the skill prints, verbatim', () => {
    const fenced = SKILL.match(/```\n(\s*REDUCED REVIEW:[\s\S]*?)```/);
    expect(fenced).not.toBeNull();

    const notice = fenced[1].trim();
    expect(notice).toContain('no subagent capability');
    expect(notice).toContain('one reviewer');
    expect(notice).toContain('verification: not-performed, reason: no-subagent-capability');
    expect(notice).toContain('Re-run this review on a runtime with subagents before relying on it.');

    // The words of the notice describe the result the CLI actually produced.
    const result = cli('votes', { depth: 'standard', findings: singlePass, verificationCapability: false });
    expect(notice).toContain(`verification: ${result.verification}`);
    expect(notice).toContain(`reason: ${result.findings[0].reason}`);
  });

  test('the notice survives into the state report, so the next reader and the next round both see it', () => {
    const cwd = tmpCwd();
    const headSha = 'b'.repeat(40);
    const result = cli('votes', { depth: 'standard', findings: singlePass, verificationCapability: false });
    const notice = SKILL.match(/```\n(\s*REDUCED REVIEW:[\s\S]*?)```/)[1].trim();

    const written = cli('state-write', {
      prId: 'reduced-1',
      cwd,
      state: {
        headSha,
        verification: { verification: result.verification, reason: result.findings[0].reason, recoveryAction: result.recoveryAction },
        reducedReview: notice,
        ledger: result.findings.map((finding) => ({ ...candidate({ id: finding.id }), disposition: 'fix' })),
      },
    }, { cwd });
    expect(written.ok).toBe(true);

    const read = cli('state-read', { prId: 'reduced-1', cwd, headSha }, { cwd });
    expect(read.ok).toBe(true);
    expect(read.exists).toBe(true);
    expect(read.discarded).toBe(false);
    expect(read.state.reducedReview).toBe(notice);
    expect(read.state.verification).toMatchObject({ verification: 'not-performed', recoveryAction: 're-run-verification' });
  });

  test('a reduced review is never reported as a clean, verified one', () => {
    const result = cli('votes', { depth: 'standard', findings: singlePass, verificationCapability: false });

    expect(result.verification).not.toBe('performed');
    expect(result.presented).not.toHaveLength(0);
    for (const finding of result.findings) {
      expect([finding.id, finding.authorLabel]).not.toEqual([finding.id, 'required fix']);
    }

    const flat = SKILL.replace(/\s+/g, ' ');
    expect(flat).toContain('The notice is never omitted because the findings look clean');
    expect(flat).toContain('a reduced review is never reported as a verified one');
    expect(flat).toContain('whenever that word is not `performed`');
  });
});
