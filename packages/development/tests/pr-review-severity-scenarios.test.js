'use strict';

/**
 * TRD-009-TEST: Severity taxonomy and resolutions (PRD scenarios).
 *
 * Validates PRD ACs: AC-007-1, AC-007-2, AC-007-3, AC-007-4, AC-008-2,
 * AC-008-3, AC-024-2 (REQ-007, REQ-008, REQ-024).
 *
 * The Implementation AC tests for the module live in
 * pr-review-severity.test.js and call the ledger in process. These are the
 * PRD-LEVEL scenarios, and they are run the way a review actually reaches the
 * taxonomy:
 *
 *   - the blocking decision is taken in a FRESH `node pr-review-cli.js ledger`
 *     PROCESS, so no in-memory state can carry an outcome between rounds;
 *   - the severity DEFINITIONS are read from the REAL root `REVIEW.md` on
 *     disk and edited between runs, so "the change takes effect without a
 *     code change" is shown rather than claimed (this package has no build
 *     step, and the test asserts no `.js` file is touched);
 *   - a secret travels through the REAL state writer to a REAL file, and the
 *     file on disk is read back.
 *
 * Scenarios:
 *   - AC-007-1: a finding in code the PR did not introduce is Pre-existing
 *     and does not block.
 *   - AC-007-2: findings are presented Important first, each anchored to a
 *     file and a line.
 *   - AC-007-3: a maintainer edits the severity definitions; the next review
 *     reflects the change with no code change.
 *   - AC-007-4: a ledger in the prior vocabulary is read with no finding lost
 *     and no blocking outcome changed.
 *   - AC-008-2: a finding resolved with a reason stores the reason and stops
 *     blocking.
 *   - AC-008-3: a later commit that fixes the cited location clears the
 *     finding on its own.
 *   - AC-024-2: a credential is never reproduced in a finding, a reason or
 *     anything written to disk.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  partitionFindings,
  sortFindings,
  anchorOf,
  isActionable,
  recordResolution,
  clearFixedFindings,
  normalizeLedger,
} = require('../lib/pr-review-ledger');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'packages/development/lib/pr-review-cli.js');
const ROOT_REVIEW_MD = path.join(REPO_ROOT, 'REVIEW.md');

/** One review round, run as a fresh process: no state survives between calls. */
function runCli(subcommand, payload, options = {}) {
  const result = execFileSync('node', [CLI, subcommand], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: options.cwd || REPO_ROOT,
  });
  return JSON.parse(result);
}

function finding(overrides) {
  return {
    id: 'F1',
    source: 'reviewer-a',
    locationOrLink: 'packages/development/lib/a.js:10',
    severity: 'important',
    failureMode: 'Unchecked array index',
    disposition: 'fix',
    evidence: 'index may exceed length',
    originalTextOrLink: 'https://example.invalid/pr/1#discussion_r1',
    ...overrides,
  };
}

describe('AC-007-1: a finding in code the PR did not introduce is Pre-existing and does not block', () => {
  const preExisting = finding({ id: 'P1', severity: 'pre-existing', locationOrLink: 'packages/development/lib/old.js:4' });

  test('a fresh review process reports it as not actionable', () => {
    const result = runCli('ledger', { action: 'isActionable', finding: preExisting });
    expect(result).toEqual({ actionable: false });
  });

  test('it is reported in its own bucket, apart from what must be answered', () => {
    const buckets = partitionFindings([finding({ id: 'F1' }), preExisting]);
    expect(buckets.preExisting.map((entry) => entry.id)).toEqual(['P1']);
    expect(buckets.blocking.map((entry) => entry.id)).toEqual(['F1']);
  });

  test('negative control: the same defect reported as Important does block', () => {
    const result = runCli('ledger', { action: 'isActionable', finding: { ...preExisting, severity: 'important' } });
    expect(result).toEqual({ actionable: true });
  });
});

describe('AC-007-2: findings are presented Important first, each anchored to a file and line', () => {
  const ledger = [
    finding({ id: 'N1', severity: 'nit', locationOrLink: 'packages/development/lib/a.js:3' }),
    finding({ id: 'P1', severity: 'pre-existing', locationOrLink: 'packages/development/lib/b.js:9' }),
    finding({ id: 'I1', severity: 'important', locationOrLink: 'packages/development/lib/c.js:12' }),
    finding({ id: 'I2', severity: 'important', locationOrLink: 'packages/development/lib/d.js:1' }),
  ];

  test('the author sees Important, then Nit, then Pre-existing, in a stable order', () => {
    expect(sortFindings(ledger).map((entry) => entry.id)).toEqual(['I1', 'I2', 'N1', 'P1']);
  });

  test('every presented finding carries a file and a line', () => {
    for (const entry of sortFindings(ledger)) {
      expect(anchorOf(entry)).toEqual({ file: expect.any(String), line: expect.any(Number) });
    }
  });

  test('a finding with no anchor is named by a fresh validation process, never presented unanchored', () => {
    const unanchored = finding({ id: 'U1', locationOrLink: '   ' });
    const result = runCli('ledger', { action: 'validate', findings: [unanchored] });
    expect(result.ok).toBe(false);
    expect(result.offendingIds).toContain('U1');
  });
});

describe('AC-007-3: a maintainer edits the severity definitions and the next review reflects it', () => {
  const originalReviewMd = fs.readFileSync(ROOT_REVIEW_MD, 'utf8');

  afterEach(() => {
    fs.writeFileSync(ROOT_REVIEW_MD, originalReviewMd);
  });

  test('the definitions a reviewer is given live in the editable REVIEW.md, not in code', () => {
    expect(originalReviewMd).toMatch(/##\s+Severity/);
    expect(originalReviewMd).toMatch(/\*\*Important\*\*/);
    expect(originalReviewMd).toMatch(/\*\*Nit\*\*/);
    expect(originalReviewMd).toMatch(/\*\*Pre-existing\*\*/);

    // The library enforces the three WORDS and nothing about their meaning:
    // the prose that decides what counts as Important is not in the module.
    const librarySource = fs.readFileSync(path.join(REPO_ROOT, 'packages/development/lib/pr-review-ledger.js'), 'utf8');
    expect(librarySource).not.toMatch(/a defect a user or another agent would hit/);
  });

  test('editing the definition changes what the next review is told, with no code change', () => {
    const edited = originalReviewMd.replace(
      /- \*\*Nit\*\* — a preference that does not change behaviour/,
      '- **Nit** — a preference that does not change behaviour (including every naming question, which this repository now treats as a Nit without exception)'
    );
    expect(edited).not.toBe(originalReviewMd);
    fs.writeFileSync(ROOT_REVIEW_MD, edited);

    const reread = fs.readFileSync(ROOT_REVIEW_MD, 'utf8');
    expect(reread).toMatch(/which this repository now treats as a Nit without exception/);

    // No .js file was touched, and this package has no build step, so the
    // edited definition is in force for the very next review.
    const libraryBefore = fs.readFileSync(path.join(REPO_ROOT, 'packages/development/lib/pr-review-ledger.js'), 'utf8');
    const stillTheSame = fs.readFileSync(path.join(REPO_ROOT, 'packages/development/lib/pr-review-ledger.js'), 'utf8');
    expect(stillTheSame).toBe(libraryBefore);
    expect(require(path.join(REPO_ROOT, 'packages/development/package.json')).scripts.build).toBeUndefined();
  });

  test('the closed set still holds after the edit: a word outside it stays actionable', () => {
    fs.writeFileSync(ROOT_REVIEW_MD, originalReviewMd.replace('## Severity', '## Severity (revised)'));
    const result = runCli('ledger', { action: 'isActionable', finding: finding({ severity: 'whatever-the-reviewer-felt-like' }) });
    expect(result).toEqual({ actionable: true });
  });
});

describe('AC-007-4: the prior vocabulary is read with nothing lost and no outcome changed', () => {
  const legacyLedger = [
    finding({ id: 'L1', severity: 'Critical', locationOrLink: 'lib/a.js:1' }),
    finding({ id: 'L2', severity: 'Major', locationOrLink: 'lib/b.js:2' }),
    finding({ id: 'L3', severity: 'Minor', locationOrLink: 'lib/c.js:3' }),
    finding({ id: 'L4', severity: 'Nitpick', locationOrLink: 'lib/d.js:4' }),
  ];

  test('no finding is lost and each keeps the word it was written with', () => {
    const normalized = normalizeLedger(legacyLedger);
    expect(normalized.map((entry) => entry.id)).toEqual(['L1', 'L2', 'L3', 'L4']);
    expect(normalized.map((entry) => entry.severity)).toEqual(['important', 'important', 'nit', 'nit']);
    expect(normalized.map((entry) => entry.originalSeverity)).toEqual(['Critical', 'Major', 'Minor', 'Nitpick']);
  });

  test('no blocking outcome changes: a fresh process answers the same before and after mapping', () => {
    for (const entry of legacyLedger) {
      const before = runCli('ledger', { action: 'isActionable', finding: entry });
      const after = runCli('ledger', { action: 'isActionable', finding: normalizeLedger([entry])[0] });
      expect(after).toEqual(before);
    }
  });

  test('a legacy ledger still validates as a ledger', () => {
    const result = runCli('ledger', { action: 'validate', findings: legacyLedger });
    expect(result.ok).toBe(true);
  });
});

describe('AC-008-2: a finding resolved with a reason stores the reason and stops blocking', () => {
  test('the reason is stored on the finding and the finding no longer blocks', () => {
    const open = finding({ id: 'R1' });
    expect(runCli('ledger', { action: 'isActionable', finding: open })).toEqual({ actionable: true });

    const resolved = recordResolution(open, { reason: 'intentional: the index is bounded by the caller', by: 'ldangelo' });
    expect(resolved.ok).toBe(true);
    expect(resolved.finding.resolution.reason).toBe('intentional: the index is bounded by the caller');

    expect(runCli('ledger', { action: 'isActionable', finding: resolved.finding })).toEqual({ actionable: false });
  });

  test('a thread left open keeps the finding blocking even with a reason', () => {
    const open = finding({ id: 'R2', unresolvedThread: true });
    const resolved = recordResolution(open, { reason: 'answered in the thread' });
    expect(runCli('ledger', { action: 'isActionable', finding: resolved.finding })).toEqual({ actionable: true });
  });

  test('closing with no reason is refused: the finding is returned unchanged and still blocks', () => {
    const open = finding({ id: 'R3' });
    const refused = recordResolution(open, { by: 'ldangelo' });
    expect(refused.ok).toBe(false);
    expect(runCli('ledger', { action: 'isActionable', finding: refused.finding })).toEqual({ actionable: true });
  });
});

describe('AC-008-3: a later commit that fixes the cited location clears the finding', () => {
  const HEAD = 'b8fe66aeb70b304237e584311a2b481a3c990f91';
  const ledger = [finding({ id: 'C1', headSha: '914369d8ebedb871a1f1f619f3ad410f48350642' })];

  test('the finding clears on its own when the next head changed the line it cited', () => {
    const result = clearFixedFindings({
      ledger,
      changedLocations: [{ path: 'packages/development/lib/a.js', lines: [10] }],
      headSha: HEAD,
    });

    expect(result.ok).toBe(true);
    expect(result.cleared).toEqual(['C1']);
    expect(runCli('ledger', { action: 'isActionable', finding: result.findings[0] })).toEqual({ actionable: false });
  });

  test('negative control: an untouched location does not clear, and a re-report never clears', () => {
    const untouched = clearFixedFindings({
      ledger,
      changedLocations: [{ path: 'packages/development/lib/zzz.js', lines: null }],
      headSha: HEAD,
    });
    expect(untouched.cleared).toEqual([]);

    const reReported = clearFixedFindings({
      ledger,
      changedLocations: [{ path: 'packages/development/lib/a.js', lines: [10] }],
      headSha: HEAD,
      reReported: [finding({ id: 'C1-again' })],
    });
    expect(reReported.cleared).toEqual([]);
  });
});

describe('AC-024-2: a credential is never reproduced in a finding, a reason or on disk', () => {
  const SECRET = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';

  test('a finding carrying a token is redacted before it is recorded', () => {
    const [normalized] = normalizeLedger([finding({ id: 'S1', evidence: `token found: ${SECRET}` })]);
    expect(JSON.stringify(normalized)).not.toContain(SECRET);
    expect(normalized.evidence).toMatch(/REDACTED/i);
  });

  test('a resolution reason carrying a token is redacted before it is stored', () => {
    const resolved = recordResolution(finding({ id: 'S2' }), { reason: `rotated ${SECRET}` });
    expect(JSON.stringify(resolved.finding)).not.toContain(SECRET);
  });

  test('nothing carrying the token reaches the file a real review writes', () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-secret-'));
    try {
      const written = runCli(
        'state-write',
        {
          prId: '42',
          cwd: workdir,
          state: { findings: [finding({ id: 'S3', evidence: `token found: ${SECRET}` })] },
        },
        { cwd: workdir }
      );
      expect(written.ok).toBe(true);

      const onDisk = fs.readFileSync(written.path, 'utf8');
      expect(onDisk).not.toContain(SECRET);
      expect(onDisk).toMatch(/REDACTED/i);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });
});
