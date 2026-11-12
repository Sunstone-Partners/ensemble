'use strict';

/**
 * `ledger dedupe` merges findings that are very probably one defect, and only those.
 *
 * Independent reviewers rarely cite a defect with the same line range or the same words
 * (`delegation-contract.js:293-302` against `:294-302`), so the verbatim location-and-failure-mode key merged
 * nothing on two real runs and the orchestrator merged by hand. Merging by location alone is wrong too: two
 * distinct defects can sit on one line, and a wrong merge drops a finding.
 *
 * The data below is real: the candidates collected by two end-to-end runs of the review cycle (PR 205, two
 * reviewers; PR 207, two reviewers and two further probes), exactly as each reviewer reported them. What a
 * finding is compared on depends on the whole round, so each round is kept whole.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const { dedupeFindings, isActionable, recordRound } = require('../lib/pr-review-ledger');
const FIXTURE = require('./fixtures/pr-review-reviewer-candidates.json');

const CLI = path.join(__dirname, '..', 'lib', 'pr-review-cli.js');
const PR205 = FIXTURE.pr205;
const PR207 = FIXTURE.pr207;

const clone = (value) => JSON.parse(JSON.stringify(value));
const find = (round, id) => round.find((finding) => finding.id === id);

/** The input round with one finding replaced by `change` applied to a copy of it. */
function withChange(round, id, change) {
  return round.map((finding) => (finding.id === id ? { ...clone(finding), ...change } : finding));
}

/** Lists of ids with each list, and the lists, in a fixed order. */
const groups = (lists) => lists.map((ids) => [...ids].sort()).sort();

/** The ids each merged entry stands for. */
function mergedGroups(result) {
  return groups(result.filter((entry) => entry.mergedFrom).map((entry) => entry.mergedFrom.map((member) => member.id)));
}

/** Whether one entry of the result stands for both findings. */
function together(result, a, b) {
  return result.some((entry) => {
    const ids = entry.mergedFrom ? entry.mergedFrom.map((member) => member.id) : [entry.id];
    return ids.includes(a) && ids.includes(b);
  });
}

describe('the round PR 205 collected (14 candidates from two reviewers)', () => {
  const result = dedupeFindings(PR205);

  test('merges the three pairs the two reviewers wrote up twice, and nothing else', () => {
    expect(mergedGroups(result)).toEqual(groups([
      ['S1a', 'S1b'], // validateRunResponse accepts a stale screenshot: lines 293-302 against 294-302
      ['S3a', 'S3b'], // an E2E namespace other than the default: the same line, little wording in common
      ['S5a', 'S5b'], // hasEvidenceCapture's scan of the block form: lines 63-68 against 66
    ]));
    expect(result).toHaveLength(11);
  });

  test('keeps two distinct defects on one line apart', () => {
    // SAFE_PATH_RE at evidence-capture.js:31: one reviewer says it rejects a non-ASCII path, the other that
    // it lets a backslash-quote escape. Same file, same line, both Nit, one regex named in both.
    expect(find(PR205, 'S6a').locationOrLink).toBe(find(PR205, 'S9b').locationOrLink);
    expect(together(result, 'S6a', 'S9b')).toBe(false);
    expect(result.map((entry) => entry.id)).toEqual(expect.arrayContaining(['S6a', 'S9b']));
  });

  test('drops nothing: every candidate is an entry or a member of one, and every original link is kept', () => {
    const represented = result.flatMap((entry) => (entry.mergedFrom ? entry.mergedFrom.map((member) => member.id) : [entry.id]));
    expect(represented.sort()).toEqual(PR205.map((finding) => finding.id).sort());

    const links = result.flatMap((entry) => entry.originalLinks || [entry.originalTextOrLink]);
    expect(links.sort()).toEqual(PR205.map((finding) => finding.originalTextOrLink).sort());
  });

  test('a merged entry is the most severe member, actionable, under the first member\'s fix id', () => {
    // S3b (Important) comes before S3a (Nit); S3a deferred must not let the merged entry hide S3b.
    for (const round of [
      withChange(PR205, 'S3a', { disposition: 'deferred', reason: 'style only' }),
      [...withChange(PR205, 'S3a', { disposition: 'deferred', reason: 'style only' })].reverse(),
    ]) {
      const entry = dedupeFindings(round).find((candidate) => candidate.mergedFrom && candidate.mergedFrom.some((m) => m.id === 'S3a'));
      expect(entry.severity).toBe('important');
      expect(isActionable(entry)).toBe(true);
      expect(entry.disposition).not.toBe('deferred');
      expect(entry.originalLinks.sort()).toEqual(['agent://E2ePlanA', 'agent://E2ePlanB']);
      expect(entry.fixId).toBe(entry.mergedFrom[0].id);
    }
  });

  test('lists the members of a merged entry with their sources and the lines each cited', () => {
    const entry = result.find((candidate) => candidate.mergedFrom && candidate.mergedFrom.some((member) => member.id === 'S1a'));
    expect(entry.mergedFrom).toEqual([
      { id: 'S1a', source: 'E2ePlanA', locationOrLink: 'packages/e2e-testing/lib/delegation-contract.js:293-302' },
      { id: 'S1b', source: 'E2ePlanB', locationOrLink: 'packages/e2e-testing/lib/delegation-contract.js:294-302' },
    ]);
  });
});

describe('the round PR 207 collected (40 candidates from four reviewers)', () => {
  const result = dedupeFindings(PR207);

  test('merges what the reviewers wrote up more than once', () => {
    expect(mergedGroups(result)).toEqual(groups([
      [
        // detectE2eFrameworkInDir throws on a missing directory: four reviewers, lines 32-47 in four spans
        'A/detect-in-dir-throws-instead-of-null',
        'B/detect-in-dir-throws-instead-of-null',
        'PA/detect-in-dir-throws-on-bad-path',
        'PB/detect-helper-throws-instead-of-null',
      ],
      [
        // testCategory interpolated unvalidated into the Trait attribute: lines 155, 152-156, 150-156
        'A/testCategory-interpolated-unvalidated-into-trait',
        'B/testcategory-interpolated-without-validation',
        'PA/testCategory-unvalidated-in-new-trait-attribute',
      ],
      [
        // appendTestMethod writes into the first class of the file: line 418 against 378-425
        'A/append-lands-in-collection-definition-class',
        'PA/append-targets-first-class-xunit-collection-definition',
      ],
      [
        // a new xUnit file needs a collection and a fixture type nothing supplies: line 217 against 217-224 (and ...)
        'A/xunit-first-test-in-a-project-unauthorable',
        'PA/xunit-collection-fixtureType-have-no-producer',
      ],
      [
        // "nunit" when detection returns null defeats per-file inference
        'A/nunit-default-defeats-per-file-inference',
        'PB/null-coerced-to-nunit-defeats-inference',
      ],
      [
        // two loosened assertions: lines 52,106 against 52
        'A/evidence-test-assertion-weakened',
        'B/evidence-test-assertion-loosened',
      ],
      [
        // prose trimmed to fit the word budget: lines 105-110, 105 and 279, 103 and 276
        'B/unexplained-prose-deletions-are-budget-driven',
        'PA/unrelated-prose-trims-to-fit-prompt-ratchet',
        'PB/budget-driven-collateral-trims',
      ],
    ]));
    expect(result).toHaveLength(29);
  });

  test('keeps defects apart that share a file, nearby lines and a subject', () => {
    const apart = [
      // yaml:226, both about what the Land step does when spec-writer refuses: a missing recovery branch against
      // collection and fixtureType that nothing supplies
      ['A/no-recovery-for-spec-writer-refusal', 'B/xunit-first-test-has-no-landing-path'],
      ['A/no-recovery-for-spec-writer-refusal', 'PB/no-source-for-collection-and-fixtureType'],
      // the NUnit [TestCategory] spelling is MSTest's (spec-writer.js:156) against a testCategory that is
      // interpolated unvalidated into the Trait attribute (lines 150-156)
      ['PB/nunit-attribute-is-mstest-spelling', 'A/testCategory-interpolated-unvalidated-into-trait'],
      ['PB/nunit-attribute-is-mstest-spelling', 'PA/testCategory-unvalidated-in-new-trait-attribute'],
      // what detectE2eFrameworkInDir reads (csproj attributes, lines 16-46) against what it does with a bad path
      ['PA/detect-silently-defaults-nunit', 'A/detect-in-dir-throws-instead-of-null'],
      ['PA/detect-silently-defaults-nunit', 'PB/detect-helper-throws-instead-of-null'],
    ];
    for (const [a, b] of apart) expect([a, b, together(result, a, b)]).toEqual([a, b, false]);
  });

  test('drops nothing, and lists the entries in the order their first finding was reported', () => {
    const represented = result.flatMap((entry) => (entry.mergedFrom ? entry.mergedFrom.map((member) => member.id) : [entry.id]));
    expect(represented.sort()).toEqual(PR207.map((finding) => finding.id).sort());

    const firstReported = result.map((entry) =>
      PR207.findIndex((finding) => finding.id === (entry.mergedFrom ? entry.mergedFrom[0].id : entry.id))
    );
    expect(firstReported).toEqual([...firstReported].sort((x, y) => x - y));
  });

  test.each([
    ['reversed', (round) => [...round].reverse()],
    ['rotated by 13', (round) => [...round.slice(13), ...round.slice(0, 13)]],
    ['the reviewers\' lists interleaved', (round) => [...round].sort((x, y) => (x.id.split('/')[1] < y.id.split('/')[1] ? -1 : 1))],
  ])('merges the same findings whichever way the round is ordered: %s', (_label, reorder) => {
    expect(mergedGroups(dedupeFindings(reorder(PR207)))).toEqual(mergedGroups(result));
    expect(mergedGroups(dedupeFindings(reorder(PR205)))).toEqual(mergedGroups(dedupeFindings(PR205)));
  });
});

describe('what a merge needs: S1a and S1b, two reviewers on one defect, in the PR 205 round', () => {
  const FILE = 'packages/e2e-testing/lib/delegation-contract.js';

  /** The round with S1b changed; whether S1a and S1b still share an entry. */
  const merges = (change, id = 'S1b') => together(dedupeFindings(withChange(PR205, id, change)), 'S1a', 'S1b');

  test('they merge as reported (the control for every case below)', () => {
    expect(merges({})).toBe(true);
  });

  test.each([
    ['the same file, lines that touch', { locationOrLink: `${FILE}:303-310` }, true],
    ['the same file, lines two apart', { locationOrLink: `${FILE}:304-310` }, true],
    ['the same file, lines three apart', { locationOrLink: `${FILE}:305-310` }, false],
    ['another file, the same lines', { locationOrLink: `packages/e2e-testing/lib/evidence-capture.js:294-302` }, false],
    ['a list of lines, one inside the other\'s range', { locationOrLink: `${FILE}:20,296` }, true],
    ['a second anchor in the same string', { locationOrLink: `packages/e2e-testing/lib/evidence-capture.js:9 and ${FILE}:294-302` }, true],
    ['prose after the anchor', { locationOrLink: `${FILE}:294-302 (and the caller in the command)` }, true],
    ['a link instead of a file and line', { locationOrLink: 'https://github.com/Sunstone-Partners/ensemble/pull/205#discussion_r1' }, false],
    ['a file with no line', { locationOrLink: FILE }, false],
    ['a second anchor in another file at the same lines', { locationOrLink: `packages/e2e-testing/lib/evidence-capture.js:294-302 and ${FILE}:900` }, false],
  ])('location: %s', (_label, change, expected) => {
    expect(merges(change)).toBe(expected);
  });

  test('two findings that cite the same link are not on "the same file and line"', () => {
    // A link names a host and a port, which a reader of `host:8443` could take for a file and a line.
    const link = 'https://ci.example.com:8443/artifacts/run-1.log';
    const round = withChange(withChange(PR205, 'S1a', { locationOrLink: link }), 'S1b', { locationOrLink: link });
    expect(together(dedupeFindings(round), 'S1a', 'S1b')).toBe(false);
  });

  test.each([
    ['the same source as the other finding', { source: 'E2ePlanA' }],
    ['an open thread', { unresolvedThread: true }],
    ['an uncertain flag', { uncertain: true }],
    ['another class of bug', { class: 'stale-evidence' }],
    ['another security relevance', { securityRelevant: true }],
    ['a Pre-existing severity', { severity: 'pre-existing' }],
    ['a preExisting flag', { preExisting: true }],
    ['a description of another defect', { failureMode: find(PR205, 'S11b').failureMode, evidence: find(PR205, 'S11b').evidence }],
    ['a far shorter description: too little text to compare', { failureMode: 'accepts a stale screenshot', evidence: 'existsSync only' }],
    [
      'a description many times longer, which only mentions S1a\'s words among those of every other finding in the round',
      {
        failureMode: [find(PR205, 'S1b'), ...PR205.filter((finding) => !['S1a', 'S1b'].includes(finding.id))].map((finding) => finding.failureMode).join(' '),
      },
    ],
  ])('is refused with %s', (_label, change) => {
    expect(merges(change)).toBe(false);
  });

  test('two descriptions too short to tell one defect from another stay apart, even when they are identical', () => {
    const short = { failureMode: 'accepts a stale screenshot', evidence: 'existsSync only' };
    const round = withChange(withChange(PR205, 'S1a', short), 'S1b', short);
    expect(together(dedupeFindings(round), 'S1a', 'S1b')).toBe(false);
  });

  test('is not decided by the severity two reviewers gave it', () => {
    expect(merges({ severity: 'nit' })).toBe(true);
    expect(merges({ severity: 'critical' })).toBe(true);
  });

  test('an entry never holds two findings of one reviewer: one match cannot pull a reviewer\'s neighbour in', () => {
    // E2ePlanA's second finding, a few lines from S1a and worded the same way, resembles S1b as much as S1a does.
    const neighbour = { ...clone(find(PR205, 'S1a')), id: 'S1a-next', locationOrLink: `${FILE}:296-301` };
    const result = dedupeFindings([...PR205, neighbour]);
    expect(mergedGroups(result)).toEqual(expect.arrayContaining([['S1a', 'S1b']]));
    expect(together(result, 'S1a', 'S1a-next')).toBe(false);
    expect(together(result, 'S1b', 'S1a-next')).toBe(false);
    expect(result.map((entry) => entry.id)).toContain('S1a-next');
  });

  test('a finding joins the reviewer finding it resembles most, not the one listed first', () => {
    // E2ePlanA's S1a and a later finding of E2ePlanA's both resemble S1b; S1b can join only one of them.
    const closer = {
      ...clone(find(PR205, 'S1b')),
      id: 'S1a-closer',
      source: 'E2ePlanA',
      locationOrLink: `${FILE}:295-302`,
      evidence: `${find(PR205, 'S1b').evidence} Again.`,
    };
    const result = dedupeFindings([...PR205, closer]);
    expect(together(result, 'S1b', 'S1a-closer')).toBe(true);
    expect(together(result, 'S1a', 'S1b')).toBe(false);
  });

  test.each([
    ['an open thread', { unresolvedThread: true }],
    ['another security relevance', { securityRelevant: true }],
  ])('an entry that already holds identical findings differing in %s is never joined to another', (_label, change) => {
    // S1a and its twin share a location and a failure mode, so they always share an entry; the twin differs from
    // S1a in what must not be lost, so that entry is not joined to S1b even though S1a alone would be.
    const twin = { ...clone(find(PR205, 'S1a')), id: 'S1a-twin', source: 'E2ePlanA', originalTextOrLink: 'agent://E2ePlanA#again', ...change };
    const result = dedupeFindings([find(PR205, 'S1a'), twin, ...PR205.filter((finding) => finding.id !== 'S1a')]);
    const entry = result.find((candidate) => (candidate.originalLinks || []).includes('agent://E2ePlanA#again'));
    expect(entry.originalLinks).toEqual(['agent://E2ePlanA', 'agent://E2ePlanA#again']);
    expect(entry.mergedFrom).toBeUndefined();
    expect(together(result, 'S1a', 'S1b')).toBe(false);
  });

  test('a round of two findings is too small to tell the PR\'s own vocabulary from a defect: they stay apart', () => {
    expect(mergedGroups(dedupeFindings([find(PR205, 'S1a'), find(PR205, 'S1b')]))).toEqual([]);
  });

  test('identical findings still share an entry, whoever reported them and however small the round', () => {
    const twin = { ...clone(find(PR205, 'S1a')), id: 'S1a-twin', source: 'E2ePlanA', originalTextOrLink: 'agent://E2ePlanA#again' };
    const result = dedupeFindings([find(PR205, 'S1a'), twin]);
    expect(result).toHaveLength(1);
    expect(result[0].originalLinks).toEqual(['agent://E2ePlanA', 'agent://E2ePlanA#again']);
    expect(result[0].mergedFrom).toBeUndefined();
  });
});

describe('across rounds a reworded finding is still a new one', () => {
  // dedupe joins what one round's reviewers wrote up twice. recordRound keeps its exact fingerprint (path, failure
  // mode, class): the same defect reported again later in other words is not guessed to be a repeat.
  const first = find(PR205, 'S1a');

  test('the other reviewer\'s wording of the same defect is not suppressed as a repeat', () => {
    const round = recordRound({ ledger: [first], incoming: [find(PR205, 'S1b')], round: 2 });
    expect(round.repeats).toEqual([]);
    expect(round.newFindings.map((finding) => finding.id)).toEqual(['S1b']);
  });

  test('the same failure mode on another line is a repeat, as it always was', () => {
    const moved = { ...clone(first), id: 'S1a-later', locationOrLink: 'packages/e2e-testing/lib/delegation-contract.js:310-319' };
    const round = recordRound({ ledger: [first], incoming: [moved], round: 2 });
    expect(round.repeats.map((repeat) => repeat.repeatOf)).toEqual(['S1a']);
  });
});

describe('through the CLI, as the skill runs it', () => {
  function dedupe(findings) {
    const run = spawnSync('node', [CLI, 'ledger'], { input: JSON.stringify({ action: 'dedupe', findings }), encoding: 'utf8' });
    expect(run.status).toBe(0);
    return JSON.parse(run.stdout).findings;
  }

  test('`ledger dedupe` on the PR 205 round answers 11 findings, not 14', () => {
    const answered = dedupe(PR205);
    expect(answered).toHaveLength(11);
    expect(mergedGroups(answered)).toEqual(mergedGroups(dedupeFindings(PR205)));
  });
});
