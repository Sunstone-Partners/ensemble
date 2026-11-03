'use strict';

/**
 * TRD-010-TEST: Repeat suppression and class findings (PRD scenarios).
 *
 * Validates PRD ACs: AC-010-2 (REQ-010), AC-011-1 and AC-011-2 (REQ-011).
 *
 * The Implementation AC tests for `recordRound`, `classFindings` and
 * `fingerprintFinding` live in pr-review-repeats.test.js and call the library
 * in process. These are the PRD-LEVEL scenarios: what the AUTHOR of a PR
 * experiences over several rounds, run through fresh
 * `node pr-review-cli.js ledger` processes with the ledger carried between
 * rounds exactly as the review-state report carries it -- so nothing an
 * in-memory object remembers can make a round look quiet.
 *
 * Scenarios:
 *   - AC-010-2: a defect already recorded for this PR is never posted to the
 *     author a second time, however many rounds report it and wherever the
 *     line has moved to.
 *   - AC-011-1: a repeatable class is presented as ONE finding that names the
 *     class and lists every instance found, so the batch fix covers all of
 *     them.
 *   - AC-011-2: after the author fixes one instance, a remaining instance
 *     found in the next round is reported against that existing class
 *     finding, not opened as a new one.
 */

const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'packages/development/lib/pr-review-cli.js');

/** One ledger call in its own process. */
function runLedger(payload) {
  const out = execFileSync('node', [CLI, 'ledger'], { input: JSON.stringify(payload), encoding: 'utf8', cwd: REPO_ROOT });
  return JSON.parse(out);
}

/** One review round as the skill runs it: dedupe this round's findings, then record them. */
function round(carried, findings, roundNumber) {
  const deduped = runLedger({ action: 'dedupe', findings });
  return runLedger({ action: 'recordRound', ledger: carried, incoming: deduped.findings, round: roundNumber });
}

function finding(overrides) {
  return {
    id: 'F1',
    source: 'reviewer-a',
    locationOrLink: 'packages/development/lib/a.js:10',
    severity: 'important',
    failureMode: 'unchecked array index',
    disposition: 'fix',
    evidence: 'the index can exceed the array length when the list is empty',
    originalTextOrLink: 'packages/development/lib/a.js:10',
    ...overrides,
  };
}

/** What the author is actually asked to answer this round. */
const presentedIds = (result) => result.presented.map((entry) => entry.id);

describe('Scenario AC-010-2: a defect already recorded is not posted to the author again', () => {
  test('three rounds report the same defect and the author sees it exactly once', () => {
    const first = round([], [finding({ id: 'R1-1' })], 1);
    expect(presentedIds(first)).toEqual(['R1-1']);

    const second = round(first.findings, [finding({ id: 'R2-1' })], 2);
    expect(presentedIds(second)).toEqual([]);
    expect(second.repeats).toEqual([
      { id: 'R2-1', repeatOf: 'R1-1', fingerprint: expect.any(String), reason: 'already-recorded' },
    ]);

    const third = round(second.findings, [finding({ id: 'R3-1' })], 3);
    expect(presentedIds(third)).toEqual([]);
    expect(third.repeats.map((repeat) => repeat.repeatOf)).toEqual(['R1-1']);
  });

  test('the file shifted, so the line moved -- it is still the same defect, not a new one', () => {
    const first = round([], [finding({ id: 'R1-1', locationOrLink: 'packages/development/lib/a.js:10' })], 1);
    const second = round(first.findings, [finding({ id: 'R2-1', locationOrLink: 'packages/development/lib/a.js:87' })], 2);

    expect(presentedIds(second)).toEqual([]);
    expect(second.repeats[0].repeatOf).toBe('R1-1');
  });

  test('the same defect written in a different voice is the same defect', () => {
    const first = round([], [finding({ id: 'R1-1', failureMode: 'Unchecked array index' })], 1);
    const second = round(first.findings, [finding({ id: 'R2-1', failureMode: '  unchecked   ARRAY index.  ' })], 2);

    expect(presentedIds(second)).toEqual([]);
  });

  test('suppressed is not dropped: the record keeps the first finding and the rounds it recurred in', () => {
    const first = round([], [finding({ id: 'R1-1' })], 1);
    const second = round(first.findings, [finding({ id: 'R2-1' })], 2);
    const third = round(second.findings, [finding({ id: 'R3-1' })], 3);

    expect(third.findings).toHaveLength(1);
    const kept = third.findings[0];
    expect(kept.id).toBe('R1-1');
    expect(kept.repeatedInRounds).toEqual([2, 3]);
    expect(kept.evidence).toBe('the index can exceed the array length when the list is empty');
  });

  test('negative control: a genuinely new defect in the same file IS posted', () => {
    const first = round([], [finding({ id: 'R1-1' })], 1);
    const second = round(
      first.findings,
      [finding({ id: 'R2-1', failureMode: 'missing await on a write', locationOrLink: 'packages/development/lib/a.js:41' })],
      2
    );

    expect(presentedIds(second)).toEqual(['R2-1']);
    expect(second.repeats).toEqual([]);
  });

  test('a defect the grader cannot fingerprint is presented, not quietly suppressed', () => {
    const first = round([], [finding({ id: 'R1-1' })], 1);
    const unfingerprintable = finding({ id: 'R2-1', locationOrLink: 'https://example.com/pr/1#discussion', failureMode: '   ' });
    const second = round(first.findings, [unfingerprintable], 2);

    expect(presentedIds(second)).toEqual(['R2-1']);
  });
});

describe('Scenario AC-011-1: a class is presented as one finding naming the class and every instance', () => {
  const instance = (id, file, line, source = 'reviewer-a') =>
    finding({
      id,
      source,
      locationOrLink: `${file}:${line}`,
      originalTextOrLink: `${file}:${line}`,
      failureMode: `unvalidated external input at ${file}`,
      class: 'unvalidated external input',
    });

  test('two reviewers find three instances and the author is shown one class finding, not three findings', () => {
    const result = round(
      [],
      [
        instance('A1', 'packages/development/lib/a.js', 11, 'reviewer-a'),
        instance('B1', 'packages/development/lib/b.js', 22, 'reviewer-b'),
        instance('C1', 'packages/development/lib/c.js', 33, 'reviewer-b'),
      ],
      1
    );

    expect(result.presented).toHaveLength(1);
    const record = result.presented[0];
    expect(record.kind).toBe('class');
    expect(record.class).toBe('unvalidated external input');
    expect(record.failureMode).toContain('3 instances');
  });

  test('the class finding lists every instance with its file and line, so a batch fix can cover all of them', () => {
    const result = round(
      [],
      [
        instance('A1', 'packages/development/lib/a.js', 11),
        instance('B1', 'packages/development/lib/b.js', 22),
        instance('C1', 'packages/development/lib/c.js', 33),
      ],
      1
    );

    const record = result.presented[0];
    expect(record.instances.map((entry) => [entry.file, entry.line])).toEqual([
      ['packages/development/lib/a.js', 11],
      ['packages/development/lib/b.js', 22],
      ['packages/development/lib/c.js', 33],
    ]);
    expect(record.instances.every((entry) => entry.open)).toBe(true);
    expect(record.openInstanceCount).toBe(3);
  });

  test('the class finding names which reviewer found what, so the author can go back to the source', () => {
    const result = round(
      [],
      [instance('A1', 'packages/development/lib/a.js', 11, 'reviewer-a'), instance('B1', 'packages/development/lib/b.js', 22, 'reviewer-b')],
      1
    );

    expect(result.presented[0].source).toBe('reviewer-a, reviewer-b');
    expect(result.presented[0].instances.map((entry) => entry.source)).toEqual(['reviewer-a', 'reviewer-b']);
  });

  test('negative control: findings that fit no class are presented one by one, as before', () => {
    const result = round(
      [],
      [
        finding({ id: 'P1', locationOrLink: 'packages/development/lib/a.js:11', failureMode: 'unchecked array index' }),
        finding({ id: 'P2', locationOrLink: 'packages/development/lib/b.js:22', failureMode: 'missing await on a write' }),
      ],
      1
    );

    expect(presentedIds(result)).toEqual(['P1', 'P2']);
    expect(result.classes).toEqual([]);
  });
});

describe('Scenario AC-011-2: after one instance is fixed, a remaining one joins the existing class finding', () => {
  const instance = (id, file, line, overrides = {}) =>
    finding({
      id,
      locationOrLink: `${file}:${line}`,
      originalTextOrLink: `${file}:${line}`,
      failureMode: `unvalidated external input at ${file}`,
      class: 'unvalidated external input',
      ...overrides,
    });

  test('the remaining instance is attached to the class finding, and no new finding is opened', () => {
    // Round 1: the class is flagged with two instances.
    const first = round([], [instance('A1', 'packages/development/lib/a.js', 11), instance('B1', 'packages/development/lib/b.js', 22)], 1);
    expect(first.classes).toHaveLength(1);
    expect(first.classes[0].instanceCount).toBe(2);

    // The author fixes the first one; the report carries it forward as resolved.
    const carried = first.findings.map((entry) => (entry.id === 'A1' ? { ...entry, disposition: 'resolved', cleared: true } : entry));

    // Round 2 finds a third instance of the same class in another file.
    const second = round(carried, [instance('C1', 'packages/development/lib/c.js', 33)], 2);

    expect(second.attached).toEqual([
      { id: 'C1', class: 'unvalidated external input', classFindingId: 'class:unvalidated-external-input' },
    ]);
    expect(second.newFindings).toEqual([]);
    expect(second.classes).toHaveLength(1);
    expect(second.classes[0].id).toBe(first.classes[0].id);
  });

  test('the author sees the one class finding again, now listing the fixed instance as closed and the open ones', () => {
    const first = round([], [instance('A1', 'packages/development/lib/a.js', 11), instance('B1', 'packages/development/lib/b.js', 22)], 1);
    const carried = first.findings.map((entry) => (entry.id === 'A1' ? { ...entry, disposition: 'resolved', cleared: true } : entry));
    const second = round(carried, [instance('C1', 'packages/development/lib/c.js', 33)], 2);

    expect(second.presented).toHaveLength(1);
    const record = second.presented[0];
    expect(record.kind).toBe('class');
    expect(record.instances.map((entry) => [entry.id, entry.open])).toEqual([
      ['A1', false],
      ['B1', true],
      ['C1', true],
    ]);
    expect(record.instanceCount).toBe(3);
    expect(record.openInstanceCount).toBe(2);
  });

  test('fixing every instance closes the class finding instead of leaving it open forever', () => {
    const first = round([], [instance('A1', 'packages/development/lib/a.js', 11), instance('B1', 'packages/development/lib/b.js', 22)], 1);
    const allFixed = first.findings.map((entry) => ({ ...entry, disposition: 'resolved', cleared: true }));

    const second = round(allFixed, [instance('C1', 'packages/development/lib/c.js', 33, { disposition: 'resolved', cleared: true })], 2);
    expect(second.classes[0].openInstanceCount).toBe(0);
    expect(second.classes[0].disposition).toBe('resolved');
  });

  test('a DIFFERENT class found later opens its own finding: attachment is per class, not a catch-all', () => {
    const first = round([], [instance('A1', 'packages/development/lib/a.js', 11)], 1);
    const other = finding({
      id: 'X1',
      locationOrLink: 'packages/development/lib/x.js:9',
      originalTextOrLink: 'packages/development/lib/x.js:9',
      failureMode: 'unbounded retry at packages/development/lib/x.js',
      class: 'unbounded retry',
    });

    const second = round(first.findings, [other], 2);
    expect(second.attached).toEqual([]);
    expect(second.newFindings.map((entry) => entry.id)).toEqual(['X1']);
    expect(second.classes.map((record) => record.class).sort()).toEqual(['unbounded retry', 'unvalidated external input']);
  });

  test('a repeat of an instance already in the class is still a repeat, not a second attachment', () => {
    const first = round([], [instance('A1', 'packages/development/lib/a.js', 11)], 1);
    const second = round(first.findings, [instance('A2', 'packages/development/lib/a.js', 11)], 2);

    expect(second.repeats.map((repeat) => repeat.repeatOf)).toEqual(['A1']);
    expect(second.attached).toEqual([]);
    expect(second.presented).toEqual([]);
  });
});
