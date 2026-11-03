'use strict';

/**
 * TRD-009: Severity taxonomy and resolution records in the ledger.
 *
 * Validates PRD ACs: AC-007-1, AC-007-2, AC-007-3, AC-007-4, AC-008-2,
 * AC-008-3, AC-024-2 (REQ-007, REQ-008, REQ-024).
 *
 * These are the Implementation AC tests for the taxonomy half of
 * `pr-review-ledger.js`. The PRD-scenario tests live in TRD-009-TEST.
 *
 * What is pinned here:
 *   1. a finding in code the PR did not introduce carries the `pre-existing`
 *      tag, is never actionable and is reported in its own bucket (AC-007-1);
 *   2. presented findings sort Important first and each one is anchored to a
 *      file and a line; the library enforces only the closed set
 *      Important / Nit / Pre-existing, the words' MEANING staying editable
 *      prose (AC-007-2, AC-007-3);
 *   3. a ledger written in the prior vocabulary (Critical, Major, Minor,
 *      Nitpick) reads as the new taxonomy with NO finding lost and NO
 *      blocking outcome changed; an unrecognised severity stays actionable
 *      (AC-007-4, fail-closed);
 *   4. a finding closed with a reason stores that reason and stops blocking,
 *      and a later head whose changes touch the cited location clears the
 *      finding on re-review (AC-008-2, AC-008-3);
 *   5. credential-shaped text in a finding or a resolution reason is redacted
 *      with the existing state redaction before it is recorded (AC-024-2).
 *
 * Every grader here is proved able to FAIL: each positive case is paired with
 * a negative control, so a rule that silently stopped grading would be caught.
 */

const {
  validateLedger,
  auditTaxonomy,
  isActionable,
  dedupeFindings,
  normalizeSeverity,
  normalizeFinding,
  normalizeLedger,
  anchorOf,
  sortFindings,
  partitionFindings,
  recordResolution,
  clearFixedFindings,
  SEVERITIES,
  LEGACY_SEVERITY_MAP,
} = require('../lib/pr-review-ledger');

function finding(overrides = {}) {
  return {
    id: 'f1',
    source: 'code-reviewer',
    locationOrLink: 'src/foo.js:12',
    severity: 'major',
    failureMode: 'null-deref',
    disposition: 'fix',
    evidence: 'stack trace shows null',
    originalTextOrLink: 'https://github.com/org/repo/pull/1#comment-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-007-1: Pre-existing findings never block and are reported separately
// ---------------------------------------------------------------------------

describe('TRD-009 AC-007-1: a finding the PR did not introduce is Pre-existing', () => {
  test('a pre-existing finding is tagged, non-actionable and bucketed on its own', () => {
    const outside = finding({ id: 'p1', severity: 'Pre-existing', locationOrLink: 'src/legacy.js:4' });
    const normalized = normalizeFinding(outside);

    expect(normalized.severity).toBe('pre-existing');
    expect(normalized.preExisting).toBe(true);
    expect(isActionable(outside)).toBe(false);

    const parts = partitionFindings([finding({ id: 'a1' }), outside]);
    expect(parts.ok).toBe(true);
    expect(parts.preExisting.map((f) => f.id)).toEqual(['p1']);
    expect(parts.important.map((f) => f.id)).toEqual(['a1']);
    expect(parts.blocking.map((f) => f.id)).toEqual(['a1']);
  });

  test('negative control: the same finding without the tag does block', () => {
    const inside = finding({ id: 'p1', severity: 'major', locationOrLink: 'src/legacy.js:4' });
    expect(isActionable(inside)).toBe(true);
    expect(partitionFindings([inside]).preExisting).toEqual([]);
    expect(partitionFindings([inside]).blocking.map((f) => f.id)).toEqual(['p1']);
  });

  test('a pre-existing finding never swallows an Important duplicate', () => {
    const key = { locationOrLink: 'src/foo.js:12', failureMode: 'null-deref' };
    const stale = finding({ ...key, id: 'p1', severity: 'pre-existing', originalTextOrLink: 'link-pre' });
    const important = finding({ ...key, id: 'a1', severity: 'important', originalTextOrLink: 'link-imp' });

    expect(dedupeFindings([stale, important])[0].severity).toBe('important');
    expect(dedupeFindings([important, stale])[0].severity).toBe('important');
    expect(isActionable(dedupeFindings([stale, important])[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-007-2 / AC-007-3: presentation order, anchors, closed set
// ---------------------------------------------------------------------------

describe('TRD-009 AC-007-2: Important first, each anchored to file and line', () => {
  const nit = finding({ id: 'n1', severity: 'nit', locationOrLink: 'src/a.js:3', disposition: 'deferred', reason: 'style' });
  const important = finding({ id: 'i1', severity: 'important', locationOrLink: 'src/z.js:99' });
  const pre = finding({ id: 'p1', severity: 'pre-existing', locationOrLink: 'src/b.js:1' });

  test('sortFindings puts Important before Nit before Pre-existing', () => {
    expect(sortFindings([nit, pre, important]).map((f) => f.id)).toEqual(['i1', 'n1', 'p1']);
  });

  test('sorting is stable inside one severity, so equal findings keep reviewer order', () => {
    const first = finding({ id: 'i1', severity: 'important', locationOrLink: 'src/z.js:99' });
    const second = finding({ id: 'i2', severity: 'important', locationOrLink: 'src/a.js:1' });
    expect(sortFindings([first, second]).map((f) => f.id)).toEqual(['i1', 'i2']);
    expect(sortFindings([second, first]).map((f) => f.id)).toEqual(['i2', 'i1']);
  });

  test('anchorOf reads the file and line a finding is anchored to', () => {
    expect(anchorOf(important)).toEqual({ file: 'src/z.js', line: 99 });
  });

  test('negative control: a finding with no file:line anchor has no anchor', () => {
    expect(anchorOf(finding({ locationOrLink: 'https://example.invalid/pull/1' }))).toBeNull();
    const audit = auditTaxonomy([finding({ id: 'u1', locationOrLink: 'https://example.invalid/pull/1' })]);
    expect(audit.unanchoredIds).toEqual(['u1']);
    expect(audit.ok).toBe(false);
    expect(auditTaxonomy([finding({ id: 'a1' })]).unanchoredIds).toEqual([]);
  });

  test('the library enforces exactly the three severity words', () => {
    expect(SEVERITIES).toEqual(['important', 'nit', 'pre-existing']);
    expect(Object.isFrozen(SEVERITIES)).toBe(true);
    expect(normalizeSeverity('Important')).toBe('important');
    expect(normalizeSeverity('NIT')).toBe('nit');
    expect(normalizeSeverity('blocker')).toBeNull();
    expect(normalizeSeverity(undefined)).toBeNull();
    expect(normalizeSeverity(3)).toBeNull();
  });

  test('fail closed: a padded severity word is not recognised, as the ledger has always held', () => {
    expect(normalizeSeverity(' nit')).toBeNull();
    expect(normalizeSeverity('important ')).toBeNull();
    expect(isActionable(finding({ severity: ' pre-existing' }))).toBe(true);
  });

  test('validateLedger keeps the result shape its callers already read', () => {
    expect(validateLedger([])).toEqual({ ok: true, offendingIds: [] });
  });
});

// ---------------------------------------------------------------------------
// AC-007-4: legacy vocabulary maps with no loss and no outcome change
// ---------------------------------------------------------------------------

describe('TRD-009 AC-007-4: the prior vocabulary maps onto the new taxonomy', () => {
  test.each([
    ['critical', 'important'],
    ['Critical', 'important'],
    ['major', 'important'],
    ['minor', 'nit'],
    ['nitpick', 'nit'],
  ])('%s reads as %s', (legacy, canonical) => {
    expect(normalizeSeverity(legacy)).toBe(canonical);
    expect(LEGACY_SEVERITY_MAP[legacy.toLowerCase()]).toBe(canonical);
  });

  test('no finding is lost and no blocking outcome changes', () => {
    const legacyLedger = [
      finding({ id: 'c1', severity: 'critical' }),
      finding({ id: 'm1', severity: 'major', locationOrLink: 'src/a.js:1' }),
      finding({ id: 'n1', severity: 'minor', locationOrLink: 'src/b.js:2', disposition: 'deferred', reason: 'cosmetic' }),
      finding({ id: 'n2', severity: 'nitpick', locationOrLink: 'src/c.js:3', disposition: 'deferred', reason: 'nit' }),
      finding({ id: 'n3', severity: 'minor', locationOrLink: 'src/d.js:4', disposition: 'fix' }),
      finding({ id: 'x1', severity: 'showstopper', locationOrLink: 'src/e.js:5' }),
    ];

    const normalized = normalizeLedger(legacyLedger);
    expect(normalized.map((f) => f.id)).toEqual(['c1', 'm1', 'n1', 'n2', 'n3', 'x1']);
    for (let index = 0; index < legacyLedger.length; index += 1) {
      expect(isActionable(normalized[index])).toBe(isActionable(legacyLedger[index]));
    }
    expect(normalized.map((f) => isActionable(f))).toEqual([true, true, false, false, true, true]);
  });

  test('the original word is kept on the finding, so nothing is rewritten silently', () => {
    const normalized = normalizeFinding(finding({ severity: 'Critical' }));
    expect(normalized.severity).toBe('important');
    expect(normalized.originalSeverity).toBe('Critical');
  });

  test('fail closed: an unrecognised severity keeps its word, is flagged and stays actionable', () => {
    const odd = finding({ id: 'x1', severity: 'showstopper' });
    const normalized = normalizeFinding(odd);
    expect(normalized.severity).toBe('showstopper');
    expect(normalized.severityRecognised).toBe(false);
    expect(isActionable(normalized)).toBe(true);
    expect(auditTaxonomy([odd]).unrecognisedSeverityIds).toEqual(['x1']);
    expect(partitionFindings([odd]).blocking.map((f) => f.id)).toEqual(['x1']);
  });

  test('negative control: a recognised severity is not flagged', () => {
    expect(auditTaxonomy([finding({ id: 'ok1', severity: 'critical' })]).unrecognisedSeverityIds).toEqual([]);
    expect(normalizeFinding(finding({ severity: 'nit' })).severityRecognised).toBe(true);
  });

  test('fail closed: normalizeLedger refuses anything that is not an array of findings', () => {
    expect(normalizeLedger(null)).toEqual({ ok: false, reason: 'findings must be an array' });
    expect(normalizeLedger('[]')).toEqual({ ok: false, reason: 'findings must be an array' });
    expect(normalizeLedger([null])).toEqual({ ok: false, reason: 'findings must contain only objects' });
    expect(sortFindings(undefined)).toEqual({ ok: false, reason: 'findings must be an array' });
    expect(partitionFindings(undefined).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-008-2 / AC-008-3: resolution records and self-clearing findings
// ---------------------------------------------------------------------------

describe('TRD-009 AC-008-2: a finding closed with a reason stops blocking', () => {
  test('the reason is stored on the finding and it no longer blocks', () => {
    const open = finding({ id: 'r1', severity: 'important' });
    const result = recordResolution(open, { reason: 'intentional: the caller guarantees non-null', by: 'maintainer' });

    expect(result.ok).toBe(true);
    expect(result.finding.resolution.reason).toBe('intentional: the caller guarantees non-null');
    expect(result.finding.resolution.by).toBe('maintainer');
    expect(result.finding.disposition).toBe('resolved');
    expect(isActionable(result.finding)).toBe(false);
    expect(validateLedger([result.finding]).ok).toBe(true);
  });

  test('negative control: a blank or missing reason is refused and the finding still blocks', () => {
    const open = finding({ id: 'r1', severity: 'important' });
    for (const bad of [{ reason: '   ' }, {}, null, 'closed']) {
      const result = recordResolution(open, bad);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('a resolution needs a text reason');
      expect(isActionable(open)).toBe(true);
    }
  });

  test('a resolution does not close a thread that is still open', () => {
    const disputed = finding({ id: 'r2', severity: 'important', unresolvedThread: true });
    const result = recordResolution(disputed, { reason: 'answered in thread' });
    expect(result.ok).toBe(true);
    expect(isActionable(result.finding)).toBe(true);
  });
});

describe('TRD-009 AC-008-3: a later head that fixes the cited location clears the finding', () => {
  const stale = finding({ id: 's1', severity: 'important', locationOrLink: 'src/foo.js:12', headSha: 'old' });

  test('the finding clears when the new head changed its cited line and no reviewer re-reported it', () => {
    const result = clearFixedFindings({
      ledger: [stale],
      changedLocations: [{ path: 'src/foo.js', lines: [10, 11, 12, 13] }],
      headSha: 'new',
      reReported: [],
    });

    expect(result.ok).toBe(true);
    expect(result.cleared).toEqual(['s1']);
    expect(result.findings[0].cleared).toBe(true);
    expect(result.findings[0].clearedBy).toBe('new');
    expect(isActionable(result.findings[0])).toBe(false);
  });

  test('negative control: an untouched location does not clear', () => {
    const result = clearFixedFindings({
      ledger: [stale],
      changedLocations: [{ path: 'src/other.js', lines: [1] }],
      headSha: 'new',
      reReported: [],
    });
    expect(result.cleared).toEqual([]);
    expect(result.findings[0].cleared).toBeUndefined();
    expect(isActionable(result.findings[0])).toBe(true);
  });

  test('negative control: a finding re-reported on the new head is not cleared', () => {
    const result = clearFixedFindings({
      ledger: [stale],
      changedLocations: ['src/foo.js'],
      headSha: 'new',
      reReported: [finding({ id: 's2', locationOrLink: 'src/foo.js:12', failureMode: 'null-deref', headSha: 'new' })],
    });
    expect(result.cleared).toEqual([]);
    expect(isActionable(result.findings[0])).toBe(true);
  });

  test('a finding already recorded on the new head is not cleared by its own head', () => {
    const current = finding({ id: 's3', severity: 'important', locationOrLink: 'src/foo.js:12', headSha: 'new' });
    const result = clearFixedFindings({
      ledger: [current],
      changedLocations: ['src/foo.js'],
      headSha: 'new',
      reReported: [],
    });
    expect(result.cleared).toEqual([]);
  });

  test('fail closed: a request it cannot read is refused, never read as "everything is fixed"', () => {
    expect(clearFixedFindings(null).ok).toBe(false);
    expect(clearFixedFindings({ ledger: 'x', changedLocations: [], headSha: 'new' }).ok).toBe(false);
    expect(clearFixedFindings({ ledger: [stale], changedLocations: null, headSha: 'new' }).ok).toBe(false);
    expect(clearFixedFindings({ ledger: [stale], changedLocations: [], headSha: '' }).ok).toBe(false);
    expect(clearFixedFindings({ ledger: [stale], changedLocations: [{ path: 'src/foo.js', lines: 'all' }], headSha: 'new' }).ok)
      .toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-024-2: no secret is reproduced in a finding, a reason or the ledger
// ---------------------------------------------------------------------------

describe('TRD-009 AC-024-2: credential-shaped text is redacted when recorded', () => {
  const TOKEN = `ghp_${'A1b2C3d4E5f6G7h8I9j0'}`;

  test('a finding carrying a token is redacted on normalization', () => {
    const leaky = finding({ id: 'k1', evidence: `the header was Authorization: ${TOKEN}` });
    const normalized = normalizeFinding(leaky);
    expect(normalized.evidence).not.toContain(TOKEN);
    expect(normalized.evidence).toContain('[REDACTED]');
  });

  test('a resolution reason carrying a token is redacted before it is stored', () => {
    const result = recordResolution(finding({ id: 'k2' }), { reason: `rotated ${TOKEN} already` });
    expect(result.ok).toBe(true);
    expect(result.finding.resolution.reason).not.toContain(TOKEN);
    expect(result.finding.resolution.reason).toContain('[REDACTED]');
  });

  test('normalizeLedger redacts every entry', () => {
    const normalized = normalizeLedger([finding({ id: 'k3', failureMode: `leaks ${TOKEN}` })]);
    expect(normalized[0].failureMode).not.toContain(TOKEN);
  });

  test('negative control: ordinary text is left exactly as written', () => {
    const plain = finding({ id: 'k4', evidence: 'the loop never terminates for empty input' });
    expect(normalizeFinding(plain).evidence).toBe('the loop never terminates for empty input');
  });
});
