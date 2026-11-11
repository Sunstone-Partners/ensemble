'use strict';

/**
 * TRD-010: Cross-round repeat suppression and class-of-bug records
 * (`pr-review-ledger.js`).
 *
 * Validates PRD ACs: AC-010-2, AC-011-1, AC-011-2 (REQ-010, REQ-011).
 *
 * These are the Implementation AC tests. The PRD-scenario tests live in
 * TRD-010-TEST.
 *
 * What is pinned here:
 *   1. a finding whose fingerprint (path, normalized failure mode, class) is
 *      already recorded for this PR is classified as a repeat by
 *      `recordRound`, is NOT added to the presented set, and the FIRST record
 *      is the one that is kept (AC-010-2);
 *   2. findings that share a class are presented as ONE class finding that
 *      names the class and lists every instance location (AC-011-1);
 *   3. an instance found in a later round, after the author fixed another
 *      instance of the same class, is attached to the EXISTING class finding
 *      and is not opened as a new finding (AC-011-2).
 *
 * Fail closed throughout: a request `recordRound` cannot read is refused
 * rather than read as "nothing new this round", and a finding that cannot be
 * fingerprinted (no path, no failure mode) is PRESENTED rather than silently
 * suppressed -- suppression is a drop, and a drop is never the safe default.
 */

const {
  recordRound,
  fingerprintFinding,
  classFindings,
  isActionable,
} = require('../lib/pr-review-ledger');

/** A complete finding: every required ledger field present. */
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

describe('TRD-010 AC-010-2: a fingerprint already recorded is a repeat, not a new finding', () => {
  test('the same defect in a later round is classified as a repeat and is not presented', () => {
    const first = recordRound({ ledger: [], incoming: [finding({ id: 'F1' })], round: 1 });
    expect(first.ok).toBe(true);
    expect(first.presented.map((entry) => entry.id)).toEqual(['F1']);
    expect(first.repeats).toEqual([]);

    const second = recordRound({
      ledger: first.findings,
      incoming: [finding({ id: 'F9', source: 'reviewer-b' })],
      round: 2,
    });

    expect(second.ok).toBe(true);
    expect(second.presented).toEqual([]);
    expect(second.repeats).toHaveLength(1);
    expect(second.repeats[0]).toMatchObject({ id: 'F9', repeatOf: 'F1', reason: 'already-recorded' });
  });

  test('the FIRST record is kept: the repeat never replaces it and never joins the ledger', () => {
    const first = recordRound({ ledger: [], incoming: [finding({ id: 'F1', evidence: 'original evidence' })], round: 1 });
    const second = recordRound({
      ledger: first.findings,
      incoming: [finding({ id: 'F9', source: 'reviewer-b', evidence: 'rewritten evidence' })],
      round: 2,
    });

    expect(second.findings).toHaveLength(1);
    expect(second.findings[0].id).toBe('F1');
    expect(second.findings[0].source).toBe('reviewer-a');
    expect(second.findings[0].evidence).toBe('original evidence');
    // The repeat is recorded ON the kept finding, so the round history is not lost either.
    expect(second.findings[0].repeatedInRounds).toEqual([2]);
  });

  test('the fingerprint is path + normalized failure mode + class, so a shifted line is still the same defect', () => {
    const first = recordRound({ ledger: [], incoming: [finding({ id: 'F1' })], round: 1 });
    const moved = finding({
      id: 'F2',
      locationOrLink: 'packages/development/lib/a.js:41',
      failureMode: '  unchecked   ARRAY index.  ',
    });

    const second = recordRound({ ledger: first.findings, incoming: [moved], round: 2 });
    expect(second.presented).toEqual([]);
    expect(second.repeats[0]).toMatchObject({ id: 'F2', repeatOf: 'F1' });
  });

  test('negative control: a different file or a different failure mode is a new finding, not a repeat', () => {
    const first = recordRound({ ledger: [], incoming: [finding({ id: 'F1' })], round: 1 });

    const otherFile = recordRound({
      ledger: first.findings,
      incoming: [finding({ id: 'F2', locationOrLink: 'packages/development/lib/b.js:10' })],
      round: 2,
    });
    expect(otherFile.repeats).toEqual([]);
    expect(otherFile.presented.map((entry) => entry.id)).toEqual(['F2']);

    const otherMode = recordRound({
      ledger: first.findings,
      incoming: [finding({ id: 'F3', failureMode: 'Missing null check' })],
      round: 2,
    });
    expect(otherMode.repeats).toEqual([]);
    expect(otherMode.presented.map((entry) => entry.id)).toEqual(['F3']);
  });

  test('two reports of the same defect inside ONE round collapse to one presented finding', () => {
    const result = recordRound({
      ledger: [],
      incoming: [finding({ id: 'F1' }), finding({ id: 'F2', source: 'reviewer-b' })],
      round: 1,
    });

    expect(result.presented.map((entry) => entry.id)).toEqual(['F1']);
    expect(result.repeats[0]).toMatchObject({ id: 'F2', repeatOf: 'F1' });
  });

  test('fail closed: a finding that cannot be fingerprinted is PRESENTED, never suppressed', () => {
    const unanchored = finding({ id: 'F1', locationOrLink: 'https://example.invalid/pr/1', file: undefined });
    expect(fingerprintFinding(unanchored)).toBeNull();

    const first = recordRound({ ledger: [], incoming: [unanchored], round: 1 });
    const second = recordRound({ ledger: first.findings, incoming: [{ ...unanchored, id: 'F2' }], round: 2 });

    expect(second.repeats).toEqual([]);
    expect(second.presented.map((entry) => entry.id)).toEqual(['F2']);
  });

  test('fail closed: a request it cannot read is refused, never read as "nothing new this round"', () => {
    for (const bad of [null, undefined, [], 'round', 7, { incoming: [finding({})] }]) {
      expect(recordRound(bad)).toMatchObject({ ok: false });
    }
    expect(recordRound({ ledger: {}, incoming: [], round: 1 })).toMatchObject({ ok: false });
    expect(recordRound({ ledger: [], incoming: [null], round: 1 })).toMatchObject({ ok: false });
    expect(recordRound({ ledger: [], incoming: [], round: 0 })).toMatchObject({ ok: false });
    expect(recordRound({ ledger: [], incoming: [], round: 1.5 })).toMatchObject({ ok: false });
  });

  test('a repeat is never silently dropped from the record: the ledger still carries it through the kept finding', () => {
    const first = recordRound({ ledger: [], incoming: [finding({ id: 'F1' })], round: 1 });
    const second = recordRound({ ledger: first.findings, incoming: [finding({ id: 'F9' })], round: 2 });
    const third = recordRound({ ledger: second.findings, incoming: [finding({ id: 'F10' })], round: 3 });

    expect(third.findings[0].repeatedInRounds).toEqual([2, 3]);
    expect(isActionable(third.findings[0])).toBe(true);
  });
});

describe('TRD-010 AC-011-1: findings sharing a class are presented as one class finding', () => {
  const instances = [
    finding({ id: 'F1', locationOrLink: 'lib/a.js:10', class: 'unvalidated-input', failureMode: 'input used without validation' }),
    finding({ id: 'F2', locationOrLink: 'lib/b.js:22', class: 'unvalidated-input', failureMode: 'input used without validation' }),
    finding({ id: 'F3', locationOrLink: 'lib/c.js:7', class: 'unvalidated-input', failureMode: 'input used without validation' }),
  ];

  test('one class finding names the class and lists every instance location', () => {
    const result = recordRound({ ledger: [], incoming: instances, round: 1 });

    expect(result.ok).toBe(true);
    expect(result.presented).toHaveLength(1);
    const [classFinding] = result.presented;
    expect(classFinding.kind).toBe('class');
    expect(classFinding.class).toBe('unvalidated-input');
    expect(classFinding.instanceCount).toBe(3);
    expect(classFinding.instances.map((entry) => entry.locationOrLink)).toEqual(['lib/a.js:10', 'lib/b.js:22', 'lib/c.js:7']);
    expect(classFinding.instances.map((entry) => entry.id)).toEqual(['F1', 'F2', 'F3']);
  });

  test('every instance stays in the ledger, each tied to its class finding -- nothing is lost to aggregation', () => {
    const result = recordRound({ ledger: [], incoming: instances, round: 1 });

    expect(result.findings.map((entry) => entry.id)).toEqual(['F1', 'F2', 'F3']);
    expect(result.findings.every((entry) => entry.classFindingId === 'class:unvalidated-input')).toBe(true);
  });

  test('the class finding takes the most serious severity of its instances', () => {
    const mixed = [
      finding({ id: 'F1', locationOrLink: 'lib/a.js:10', class: 'naming', severity: 'nit', failureMode: 'name is misleading' }),
      finding({ id: 'F2', locationOrLink: 'lib/b.js:22', class: 'naming', severity: 'important', failureMode: 'name is misleading' }),
    ];
    const result = recordRound({ ledger: [], incoming: mixed, round: 1 });

    expect(result.presented[0].severity).toBe('important');
    expect(isActionable(result.presented[0])).toBe(true);
  });

  test('the class finding carries every required ledger field, so it is a finding like any other', () => {
    const { presented } = recordRound({ ledger: [], incoming: instances, round: 1 });
    for (const field of ['id', 'source', 'locationOrLink', 'severity', 'failureMode', 'disposition', 'evidence', 'originalTextOrLink']) {
      expect(typeof presented[0][field]).toBe('string');
      expect(presented[0][field].trim()).not.toBe('');
    }
  });

  test('classFindings reads the class records straight off a ledger', () => {
    const { findings } = recordRound({ ledger: [], incoming: instances, round: 1 });
    const classes = classFindings(findings);

    expect(Array.isArray(classes)).toBe(true);
    expect(classes).toHaveLength(1);
    expect(classes[0].class).toBe('unvalidated-input');
    expect(classes[0].instances.map((entry) => entry.id)).toEqual(['F1', 'F2', 'F3']);
  });

  test('negative control: findings with no class are presented individually', () => {
    const result = recordRound({
      ledger: [],
      incoming: [
        finding({ id: 'F1', locationOrLink: 'lib/a.js:10', failureMode: 'off by one' }),
        finding({ id: 'F2', locationOrLink: 'lib/b.js:22', failureMode: 'missing await' }),
      ],
      round: 1,
    });

    expect(result.presented.map((entry) => entry.id)).toEqual(['F1', 'F2']);
    expect(result.presented.every((entry) => entry.kind !== 'class')).toBe(true);
  });

  test('fail closed: classFindings refuses a ledger it cannot read', () => {
    expect(classFindings(null)).toMatchObject({ ok: false });
    expect(classFindings('ledger')).toMatchObject({ ok: false });
    expect(classFindings([1])).toMatchObject({ ok: false });
  });
});

describe('TRD-010 AC-011-2: a later instance attaches to the existing class finding', () => {
  const roundOne = recordRound({
    ledger: [],
    incoming: [
      finding({ id: 'F1', locationOrLink: 'lib/a.js:10', class: 'unvalidated-input', failureMode: 'input used without validation' }),
      finding({ id: 'F2', locationOrLink: 'lib/b.js:22', class: 'unvalidated-input', failureMode: 'input used without validation' }),
    ],
    round: 1,
  });

  test('a remaining instance found after one was fixed is attached, not opened as a new finding', () => {
    const second = recordRound({
      ledger: roundOne.findings,
      incoming: [
        finding({ id: 'F3', locationOrLink: 'lib/c.js:7', class: 'unvalidated-input', failureMode: 'input used without validation' }),
      ],
      round: 2,
    });

    expect(second.ok).toBe(true);
    expect(second.attached).toEqual([
      { id: 'F3', class: 'unvalidated-input', classFindingId: 'class:unvalidated-input' },
    ]);
    // Presented as the EXISTING class finding, carrying every instance -- not as a new finding.
    expect(second.presented).toHaveLength(1);
    expect(second.presented[0].id).toBe('class:unvalidated-input');
    expect(second.presented[0].instances.map((entry) => entry.id)).toEqual(['F1', 'F2', 'F3']);
    expect(second.newFindings.map((entry) => entry.id)).toEqual([]);
  });

  test('the attached instance is recorded in the ledger against the existing class finding', () => {
    const second = recordRound({
      ledger: roundOne.findings,
      incoming: [
        finding({ id: 'F3', locationOrLink: 'lib/c.js:7', class: 'unvalidated-input', failureMode: 'input used without validation' }),
      ],
      round: 2,
    });

    const attachedEntry = second.findings.find((entry) => entry.id === 'F3');
    expect(attachedEntry.classFindingId).toBe('class:unvalidated-input');
    expect(attachedEntry.attachedToExistingClass).toBe(true);
    expect(attachedEntry.firstSeenRound).toBe(2);
  });

  test('a fixed instance stays in the ledger and the class finding keeps listing the open ones', () => {
    const fixed = roundOne.findings.map((entry) =>
      entry.id === 'F1' ? { ...entry, disposition: 'resolved', cleared: true } : entry
    );
    const second = recordRound({
      ledger: fixed,
      incoming: [
        finding({ id: 'F3', locationOrLink: 'lib/c.js:7', class: 'unvalidated-input', failureMode: 'input used without validation' }),
      ],
      round: 2,
    });

    const classFinding = second.presented[0];
    expect(classFinding.instanceCount).toBe(3);
    expect(classFinding.openInstanceCount).toBe(2);
    expect(classFinding.instances.find((entry) => entry.id === 'F1').open).toBe(false);
  });

  test('a NEW class in a later round opens its own class finding', () => {
    const second = recordRound({
      ledger: roundOne.findings,
      incoming: [
        finding({ id: 'F4', locationOrLink: 'lib/d.js:3', class: 'missing-await', failureMode: 'promise not awaited' }),
      ],
      round: 2,
    });

    expect(second.attached).toEqual([]);
    expect(second.newFindings.map((entry) => entry.id)).toEqual(['F4']);
    expect(second.presented.map((entry) => entry.id)).toEqual(['class:missing-await']);
  });

  test('a repeat of an instance already recorded in the class is still a repeat', () => {
    const second = recordRound({
      ledger: roundOne.findings,
      incoming: [
        finding({ id: 'F99', locationOrLink: 'lib/a.js:10', class: 'unvalidated-input', failureMode: 'input used without validation' }),
      ],
      round: 2,
    });

    expect(second.repeats[0]).toMatchObject({ id: 'F99', repeatOf: 'F1' });
    expect(second.attached).toEqual([]);
    expect(second.presented).toEqual([]);
  });
});

describe('recordRound: regressions and escalations are not suppressed', () => {
  test('a repeat of a finding that was cleared as fixed is a regression: presented as new with a note', () => {
    const first = recordRound({ ledger: [], incoming: [finding({ id: 'F1' })], round: 1 });
    const cleared = first.findings.map((entry) => ({ ...entry, cleared: true }));
    const second = recordRound({ ledger: cleared, incoming: [finding({ id: 'F9' })], round: 2 });

    expect(second.repeats).toEqual([]);
    expect(second.presented.map((entry) => entry.id)).toEqual(['F9']);
    expect(second.newFindings[0].regressionOf).toBe('F1');
    expect(second.newFindings[0].note).toMatch(/regression/);
    // the next round meets the live record, not the cleared one
    const third = recordRound({ ledger: second.findings, incoming: [finding({ id: 'F10' })], round: 3 });
    expect(third.repeats.map((r) => r.repeatOf)).toEqual(['F9']);
    expect(third.presented).toEqual([]);
  });

  test('a repeat with higher severity is presented and upgrades the stored severity, keeping originalSeverity', () => {
    const first = recordRound({ ledger: [], incoming: [finding({ id: 'F1', severity: 'nit' })], round: 1 });
    const second = recordRound({ ledger: first.findings, incoming: [finding({ id: 'F9', severity: 'important' })], round: 2 });

    expect(second.presented.map((entry) => entry.id)).toEqual(['F1']);
    expect(second.repeats[0].reason).toBe('severity-escalated');
    const stored = second.findings.find((entry) => entry.id === 'F1');
    expect(stored.severity).toBe('important');
    expect(stored.originalSeverity).toBe('nit');
  });

  test('a repeat with the same or lower severity stays suppressed', () => {
    const first = recordRound({ ledger: [], incoming: [finding({ id: 'F1', severity: 'important' })], round: 1 });
    const same = recordRound({ ledger: first.findings, incoming: [finding({ id: 'F2', severity: 'important' })], round: 2 });
    const lower = recordRound({ ledger: first.findings, incoming: [finding({ id: 'F3', severity: 'nit' })], round: 2 });
    expect(same.presented).toEqual([]);
    expect(lower.presented).toEqual([]);
    expect(lower.findings.find((entry) => entry.id === 'F1').severity).toBe('important');
  });
});
