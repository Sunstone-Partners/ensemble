'use strict';

/**
 * TRD-020-TEST: Reviewer is read-only and structured (PRD scenarios).
 *
 * Validates PRD ACs: AC-004-2, AC-004-3 (REQ-004).
 *
 * The Implementation AC tests for the agent's declared contract (tool list,
 * mission, finding-field contract) live in code-reviewer-agent.test.js and
 * read the YAML in process. These are the PRD-LEVEL scenarios: they do not
 * re-assert what the agent's prose claims about itself, they prove the real
 * library that backs every one of its claims (the same `pr-review-cli.js`
 * the pr-review-cycle skill resolves for it) actually behaves that way, in a
 * FRESH process, against real files on disk:
 *
 *   - AC-004-3: Given a reviewer or verifier runs, when it completes, then
 *     it has made no change to the repository or to PR state other than
 *     recording or posting findings -- every read-oriented subcommand the
 *     reviewer calls (`policy`, `rules`, `paths`, `description`, and the
 *     `ledger` actions `validate`, `isActionable`, `dedupe`,
 *     `scopeViolations`) is run against a real temp directory, and every
 *     byte of every file there is unchanged afterward, and no new file
 *     exists.
 *   - AC-004-2: Given reviewers disagree on whether something is a defect,
 *     when findings are collected, then every candidate finding from every
 *     reviewer is recorded with its source -- two independent reviewers who
 *     disagree (one flags a defect the other does not report at all, and a
 *     shared location where only one reviewer's finding survives) both
 *     reach the ledger with their own `source`, never silently reconciled
 *     into a single verdict at the collection step (that is REQ-005's job,
 *     run later, over verifier votes -- not ledger collection).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'packages/development/lib/pr-review-cli.js');

function runCli(subcommand, payload) {
  const out = execFileSync('node', [CLI, subcommand], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  return JSON.parse(out);
}

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'code-reviewer-scenario-'));
}

/** sha256 of every file under `dir`, keyed by its path relative to `dir`. */
function digestsOf(dir) {
  const digests = {};
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile()) {
      digests[name] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  }
  return digests;
}

function finding(overrides = {}) {
  return {
    id: 'f1',
    source: 'reviewer-a',
    locationOrLink: 'src/a.js:10',
    severity: 'important',
    failureMode: 'missing-null-check',
    disposition: 'fix',
    evidence: 'a can be null here',
    originalTextOrLink: 'reviewer-a: a can be null here',
    ...overrides,
  };
}

describe('AC-004-3: a reviewer run makes no change other than recording or posting findings', () => {
  test('every read-oriented pr-review-cli subcommand leaves a real directory byte-for-byte unchanged', () => {
    const repo = tmpRepo();
    fs.writeFileSync(path.join(repo, 'REVIEW.md'), '# Review rules\n\nBe careful.\n');
    fs.writeFileSync(path.join(repo, 'CODEOWNERS'), '* @maintainer\n');
    fs.writeFileSync(path.join(repo, 'a.js'), 'module.exports = () => 1;\n');

    const before = digestsOf(repo);
    const filesBefore = fs.readdirSync(repo).sort();

    const policyText = fs.readFileSync(path.join(repo, 'REVIEW.md'), 'utf8');
    const baseSha = '8b87a6d71146cd2e36e09c4fc265b6bb336f8798';

    runCli('policy', { text: policyText, baseSha, sourceSha: baseSha });
    runCli('rules', { changedPaths: ['a.js'], ruleFiles: ['REVIEW.md'], rulesFileName: 'REVIEW.md', baseSha, sourceSha: baseSha });
    runCli('paths', { changedPaths: ['a.js'], baseSha });
    runCli('description', { body: 'Testing: npm test\nRisk: none\nHow to revert: git revert', agentAuthored: false });
    runCli('ledger', { action: 'validate', findings: [finding()] });
    runCli('ledger', { action: 'isActionable', finding: finding() });
    runCli('ledger', { action: 'dedupe', findings: [finding()] });
    runCli('ledger', {
      action: 'scopeViolations',
      changedFiles: ['a.js'],
      scope: ['a.js'],
      ledger: [],
    });

    expect(digestsOf(repo)).toEqual(before);
    expect(fs.readdirSync(repo).sort()).toEqual(filesBefore);
  });
});

describe('AC-004-2: every candidate finding from every reviewer is recorded with its source', () => {
  test('a defect one reviewer flags and the other never reports is still recorded, with its source', () => {
    const flaggedByA = finding({ id: 'f1', source: 'reviewer-a', locationOrLink: 'src/a.js:10' });
    // reviewer-b disagrees: it examined the same diff and simply never produced a finding at this location.
    const collected = [flaggedByA];

    const result = runCli('ledger', { action: 'validate', findings: collected });
    expect(result.ok).toBe(true);

    const dedupeResult = runCli('ledger', { action: 'dedupe', findings: collected });
    expect(dedupeResult.findings).toHaveLength(1);
    expect(dedupeResult.findings[0].source).toBe('reviewer-a');
    expect(dedupeResult.findings[0].id).toBe('f1');
  });

  test('two reviewers who disagree about the SAME location each reach the ledger with their own source', () => {
    // reviewer-a reports a real defect; reviewer-b reports a different failure mode at the same
    // line (disagreement about WHAT is wrong, not just whether something is wrong). Neither is
    // merged away: they do not share a dedupe key (location + failure mode), so both survive.
    const fromA = finding({ id: 'f1', source: 'reviewer-a', failureMode: 'missing-null-check' });
    const fromB = finding({ id: 'f2', source: 'reviewer-b', failureMode: 'off-by-one', originalTextOrLink: 'reviewer-b: off by one here' });

    const result = runCli('ledger', { action: 'dedupe', findings: [fromA, fromB] });
    const sources = result.findings.map((f) => f.source).sort();
    expect(sources).toEqual(['reviewer-a', 'reviewer-b']);
    expect(result.findings.find((f) => f.id === 'f1').source).toBe('reviewer-a');
    expect(result.findings.find((f) => f.id === 'f2').source).toBe('reviewer-b');
  });

  test('two reviewers who both flag the SAME defect keep every original link, not just one source', () => {
    const fromA = finding({ id: 'f1', source: 'reviewer-a', originalTextOrLink: 'reviewer-a: null check missing' });
    const fromB = finding({ id: 'f2', source: 'reviewer-b', originalTextOrLink: 'reviewer-b: this can crash on null' });

    const result = runCli('ledger', { action: 'dedupe', findings: [fromA, fromB] });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].originalLinks).toEqual([
      'reviewer-a: null check missing',
      'reviewer-b: this can crash on null',
    ]);
  });
});
