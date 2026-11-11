'use strict';

/**
 * TRD-033-TEST: the eval skill adds and runs cases (PRD scenarios).
 *
 * Validates PRD ACs: AC-020-1, AC-020-2 (REQ-020).
 *
 * TRD Reference: docs/TRD/TRD-2026-70e784f2-code-review-process.md#trd-033-test
 * PRD Reference: docs/PRD/PRD-2026-70e784f2-code-review-process.md#req-020
 *
 * The Implementation AC tests for the skill's prose live in
 * pr-review-eval-skill.test.js, and the module-level PRD scenarios in
 * pr-review-eval-scenarios.test.js. These are the PROCEDURE-LEVEL scenarios:
 * the steps the pr-review-eval skill documents, carried out as the skill
 * documents them --
 *
 *   - the case starts from the SHIPPED `case-template.json`, not an invented
 *     object, so a template that drifts from the scorer fails here;
 *   - the code-owner confirmation is resolved by the REAL
 *     `pr-review-cli.js paths` process from CODEOWNERS text, as Step A2 says,
 *     never asserted by the test;
 *   - the case is written to a REAL `<evalCasesDir>/<id>.json` file and read
 *     back from disk, and `rulesHash` is computed by REAL `git hash-object`
 *     over the rules file on disk;
 *   - every score, comparison and staleness answer comes from a FRESH
 *     `node pr-review-cli.js <subcommand>` process, chained in the skill's own
 *     order (A5 -> R3.1 -> R3.2 -> R3.3).
 *
 * Scenarios:
 *   - AC-020-1: a PR that caused an incident is added to the eval set with the
 *     change, the bug and where the bug lived, confirmed by the code owner of
 *     the affected area; and the case is re-reviewed whenever that area's
 *     review rules change.
 *   - AC-020-2: when the eval set is run, each case is scored for whether the
 *     reviewer found the bug, and the result is reported.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(__dirname, '..', 'lib', 'pr-review-cli.js');
const SKILL_DIR = path.join(__dirname, '..', 'skills', 'pr-review-eval');
const TEMPLATE = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'case-template.json'), 'utf8'));

const { validateCase } = require('../lib/pr-review-eval');

/** One CLI call, in its own process, exactly as the skill invokes it. */
function cli(subcommand, payload) {
  const run = spawnSync('node', [CLI, subcommand], { input: JSON.stringify(payload), encoding: 'utf8', cwd: REPO_ROOT });
  expect([subcommand, run.status, run.stderr]).toEqual([subcommand, 0, '']);
  return JSON.parse(run.stdout);
}

/** The eval cases directory of a throwaway checkout. */
function evalDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-eval-'));
  const dir = path.join(root, 'docs', 'review-eval', 'cases');
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir, relative: 'docs/review-eval/cases' };
}

/** The ownership of the area the escaped bug lived in, as a repository declares it. */
const CODEOWNERS = [
  '# Default owners',
  '* @acme/maintainers',
  '',
  '# The payments area has named owners who can confirm a case about it.',
  '/packages/payments/ @dana @ren',
  '',
  '# An area owned only by a team: no login this repository can check.',
  '/packages/platform/ @acme/platform',
].join('\n');

const BASE_SHA = 'a'.repeat(40);

/** Step A1's record, started from the SHIPPED template and filled field by field. */
function caseFromTemplate(overrides = {}) {
  const record = JSON.parse(JSON.stringify(TEMPLATE));
  Object.assign(record, {
    id: '2026-10-refund-double-charge',
    change: 'https://github.com/acme/app/pull/1234',
    bug: 'The retry path re-submitted the charge before the idempotency key was written, so a refund could charge twice.',
    confirmedBy: 'dana',
    rulesFile: 'REVIEW.md',
  });
  record.location = { path: 'packages/payments/lib/refund.js', startLine: 118, endLine: 131 };
  return { ...record, ...overrides };
}

/** A reviewer's candidate finding, as Step R2 records one per case id. */
function finding(overrides = {}) {
  return {
    id: 'F1',
    source: 'reviewer-a',
    severity: 'important',
    locationOrLink: 'packages/payments/lib/refund.js:124',
    failureMode: 'double charge on retry',
    disposition: 'fix',
    evidence: 'the retry re-submits before the idempotency key is persisted',
    originalTextOrLink: 'reviewer-a-note-1',
    ...overrides,
  };
}

/** Step A3: the rules file and the hash computed from it, by git, not by hand. */
function pinRules(root, rulesFile, text) {
  const target = path.join(root, rulesFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return execFileSync('git', ['hash-object', target], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

describe('Scenario AC-020-1: an escaped bug becomes an owner-confirmed case', () => {
  test('the shipped template is the shape a case is filled into -- every field, nothing extra', () => {
    expect(Object.keys(TEMPLATE).sort()).toEqual(
      ['bug', 'change', 'confirmedBy', 'id', 'location', 'rulesFile', 'rulesHash'].sort()
    );
    expect(Object.keys(TEMPLATE.location).sort()).toEqual(['endLine', 'path', 'startLine']);
    // It ships EMPTY: a template with a value in it would be recorded as a fact nobody stated.
    expect(TEMPLATE.id).toBe('');
    expect(TEMPLATE.location.startLine).toBeNull();
  });

  test('Step A2 resolves the owners of the bug\'s area from CODEOWNERS, through the real CLI', () => {
    const resolved = cli('paths', {
      changedPaths: ['packages/payments/lib/refund.js'],
      codeowners: CODEOWNERS,
      baseSha: BASE_SHA,
    });

    expect(resolved.ok).toBe(true);
    const owners = resolved.paths[0].owners.map((login) => login.replace(/^@/, '').toLowerCase());
    expect(owners).toContain('dana');
    expect(owners).toContain('ren');
  });

  test('the case records the change, the bug, where the bug lived, and the owner who confirmed it', () => {
    const { root, dir, relative } = evalDir();
    const rulesHash = pinRules(root, 'REVIEW.md', '# Review Rules\n\nCheck idempotency on every payment retry.\n');
    const record = { ...caseFromTemplate(), rulesHash };

    const validated = validateCase({
      case: record,
      codeowners: CODEOWNERS,
      path: `${relative}/${record.id}.json`,
      evalCasesDir: relative,
    });
    expect(validated.errors).toEqual([]);
    expect(validated.ok).toBe(true);

    // Step A4: one case, one file, named after its id.
    const file = path.join(dir, `${record.id}.json`);
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);

    const fromDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(fromDisk.change).toBe('https://github.com/acme/app/pull/1234');
    expect(fromDisk.bug).toContain('idempotency key');
    expect(fromDisk.location).toEqual({ path: 'packages/payments/lib/refund.js', startLine: 118, endLine: 131 });
    expect(fromDisk.confirmedBy).toBe('dana');
    expect(fromDisk.rulesHash).toMatch(/^[0-9a-f]{40}$/);

    // Step A5: the written record round-trips through the scorer the run uses.
    const verified = cli('eval-score', { cases: [fromDisk], findingsByCase: { [fromDisk.id]: [] } });
    expect(verified.ok).toBe(true);
    expect(verified.cases[0]).toMatchObject({ id: fromDisk.id, found: false, reason: 'no-important-finding-at-location' });
  });

  test('a confirmation from someone who does not own the area is refused, and nothing is written', () => {
    const { dir, relative } = evalDir();
    const record = { ...caseFromTemplate({ confirmedBy: 'someone-else' }), rulesHash: 'b'.repeat(40) };

    const validated = validateCase({
      case: record,
      codeowners: CODEOWNERS,
      path: `${relative}/${record.id}.json`,
      evalCasesDir: relative,
    });
    expect(validated.ok).toBe(false);
    expect(validated.errors.map((entry) => entry.reason)).toContain('confirmed-by-not-owner');
    expect(validated.owners.map((owner) => owner.replace(/^@/, ''))).toEqual(expect.arrayContaining(['dana', 'ren']));

    // The refusal is the end of the procedure: no case file exists.
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('an area owned only by a team names no login that can confirm, and an unowned area names none at all', () => {
    const teamOnly = validateCase({
      case: { ...caseFromTemplate({ confirmedBy: 'someone' }), location: { path: 'packages/platform/boot.js', startLine: 4, endLine: 6 }, rulesHash: 'c'.repeat(40) },
      codeowners: CODEOWNERS,
    });
    expect(teamOnly.ok).toBe(false);
    expect(teamOnly.errors.map((entry) => entry.reason)).toContain('confirmed-by-not-owner');

    const unowned = validateCase({
      case: { ...caseFromTemplate(), rulesHash: 'c'.repeat(40) },
      codeowners: '# nobody owns anything here\n',
    });
    expect(unowned.ok).toBe(false);
    expect(unowned.errors.map((entry) => entry.reason)).toContain('no-code-owner');
  });

  test('a case written outside the eval directory, or under the wrong name, is not a case', () => {
    const base = { ...caseFromTemplate(), rulesHash: 'd'.repeat(40) };

    const outside = validateCase({ case: base, codeowners: CODEOWNERS, path: `docs/notes/${base.id}.json`, evalCasesDir: 'docs/review-eval/cases' });
    expect(outside.errors.map((entry) => entry.reason)).toContain('case-outside-eval-dir');

    const misnamed = validateCase({ case: base, codeowners: CODEOWNERS, path: 'docs/review-eval/cases/other.json', evalCasesDir: 'docs/review-eval/cases' });
    expect(misnamed.errors.map((entry) => entry.reason)).toContain('case-filename-mismatch');
  });

  test('the case is re-reviewed whenever that area\'s review rules change', () => {
    const { root } = evalDir();
    const rulesHash = pinRules(root, 'REVIEW.md', '# Review Rules\n\nCheck idempotency on every payment retry.\n');
    const record = { ...caseFromTemplate(), rulesHash };

    // Rules unchanged: the owner has nothing to look at again.
    const unchanged = cli('eval-stale', { cases: [record], rulesHashes: { 'REVIEW.md': rulesHash } });
    expect(unchanged.ok).toBe(true);
    expect(unchanged.stale).toEqual([]);
    expect(unchanged.current).toEqual([record.id]);

    // A maintainer edits the rules the case was confirmed against...
    const movedHash = pinRules(root, 'REVIEW.md', '# Review Rules\n\nCheck idempotency on every payment retry.\nAnd every refund.\n');
    expect(movedHash).not.toBe(rulesHash);

    const moved = cli('eval-stale', { cases: [record], rulesHashes: { 'REVIEW.md': movedHash } });
    expect(moved.stale).toEqual([record.id]);
    expect(moved.reasons[record.id]).toBeDefined();

    // ...and a rules file nobody hashed is never read as "unchanged".
    const unknown = cli('eval-stale', { cases: [record], rulesHashes: {} });
    expect(unknown.stale).toEqual([record.id]);
  });
});

describe('Scenario AC-020-2: running the eval set scores each case and reports the result', () => {
  const { root } = evalDir();
  const rulesHash = pinRules(root, 'REVIEW.md', '# Review Rules\n\nCheck idempotency on every payment retry.\n');
  const caught = { ...caseFromTemplate(), rulesHash };
  const missed = {
    ...caseFromTemplate({ id: '2026-09-auth-token-expiry', confirmedBy: 'ren' }),
    location: { path: 'packages/payments/lib/token.js', startLine: 40, endLine: 52 },
    rulesHash,
  };
  const cases = [caught, missed];

  test('each case is scored for whether the reviewer found THAT bug, with the reason when it did not', () => {
    const run = cli('eval-score', {
      cases,
      findingsByCase: {
        [caught.id]: [finding()],
        [missed.id]: [finding({ id: 'F9', locationOrLink: 'packages/payments/lib/token.js:200' })],
      },
    });

    expect(run.ok).toBe(true);
    expect(run.cases.find((entry) => entry.id === caught.id)).toMatchObject({ found: true, matchedFindingId: 'F1', reason: 'important-finding-at-location' });
    expect(run.cases.find((entry) => entry.id === missed.id)).toMatchObject({ found: false, reason: 'no-important-finding-at-location' });
    expect(run.total).toEqual({ cases: 2, found: 1, score: 0.5 });
  });

  test('a finding that is not an Important one at the bug\'s location does not count as found', () => {
    const nit = cli('eval-score', { cases: [caught], findingsByCase: { [caught.id]: [finding({ severity: 'nit' })] } });
    expect(nit.cases[0].found).toBe(false);

    const unanchored = cli('eval-score', { cases: [caught], findingsByCase: { [caught.id]: [finding({ locationOrLink: 'somewhere in the refund flow' })] } });
    expect(unanchored.cases[0].found).toBe(false);

    const notRun = cli('eval-score', { cases: [caught], findingsByCase: {} });
    expect(notRun.cases[0]).toMatchObject({ found: false, reason: 'no-findings-recorded' });
    // A case nobody reviewed is never scored as found.
    expect(notRun.total.found).toBe(0);
  });

  test('with CODEOWNERS passed (as Step R3.1 does) a case no owner confirmed earns no credit; without it the check is off', () => {
    const forged = { ...caught, confirmedBy: 'someone-else' };
    const findingsByCase = { [caught.id]: [finding()] };

    const unchecked = cli('eval-score', { cases: [forged], findingsByCase });
    expect(unchecked.cases[0]).toMatchObject({ found: true });

    const checked = cli('eval-score', { cases: [forged, caught], findingsByCase, codeowners: CODEOWNERS });
    expect(checked.cases[0]).toMatchObject({ found: false, reason: 'case-unconfirmed' });
    expect(checked.cases[1]).toMatchObject({ found: true });

    const skill = fs.readFileSync(path.join(REPO_ROOT, 'packages/development/skills/pr-review-eval/SKILL.md'), 'utf8');
    const r31 = skill.slice(skill.indexOf('# R3.1'), skill.indexOf('# R3.2'));
    expect(r31).toContain('codeowners: $owners');
  });

  test('the run is compared with the previous one, and a reviewer that got worse is named', () => {
    const before = cli('eval-score', {
      cases,
      findingsByCase: { [caught.id]: [finding()], [missed.id]: [finding({ id: 'F2', locationOrLink: 'packages/payments/lib/token.js:44' })] },
    });
    expect(before.total).toEqual({ cases: 2, found: 2, score: 1 });

    const after = cli('eval-score', {
      cases,
      findingsByCase: { [caught.id]: [finding()], [missed.id]: [] },
    });

    const comparison = cli('eval-compare', { previous: before, current: after });
    expect(comparison.ok).toBe(true);
    expect(comparison.regression).toBe(true);
    expect(comparison.flipped.map((entry) => entry.id)).toEqual([missed.id]);

    // The other direction is not a regression, and is reported as a gain.
    const recovered = cli('eval-compare', { previous: after, current: before });
    expect(recovered.regression).toBe(false);
    expect(recovered.gained.map((entry) => entry.id)).toEqual([missed.id]);
  });

  test('with no previous run there is nothing to compare, which is never reported as no regression', () => {
    const current = cli('eval-score', { cases, findingsByCase: { [caught.id]: [finding()], [missed.id]: [] } });
    const comparison = cli('eval-compare', { previous: null, current });

    expect(comparison.ok).toBe(false);
    expect(comparison.reason).toBeDefined();
    // A refused comparison never announces a clean result.
    expect(comparison.regression).not.toBe(false);
  });

  test('the whole run reports a score, the flipped cases and the owner re-review list together', () => {
    const findingsByCase = { [caught.id]: [finding()], [missed.id]: [] };
    const score = cli('eval-score', { cases, findingsByCase });
    const stale = cli('eval-stale', { cases, rulesHashes: { 'REVIEW.md': 'e'.repeat(40) } });

    // What the skill reports as EVAL_RUN_COMPLETE: per-case, total, and stale ids.
    expect(score.cases).toHaveLength(2);
    expect(score.total.score).toBe(0.5);
    expect(stale.stale.sort()).toEqual([caught.id, missed.id].sort());
    for (const id of stale.stale) expect(typeof stale.reasons[id]).toBe('string');
  });
});
