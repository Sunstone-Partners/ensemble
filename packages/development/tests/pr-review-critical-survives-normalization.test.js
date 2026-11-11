'use strict';

/**
 * A legacy Critical stays Critical when the ledger reads it into the current taxonomy (kata 1jp6).
 *
 * REVIEW.md: "Older ledgers written as Critical, Major, Minor or Nitpick are read as Important (Critical, Major) and Nit
 * (Minor, Nitpick); nothing is lost and no blocking outcome changes." `normalizeFinding` rewrites `severity` to the canonical
 * word (`important`) and keeps the word as written in `originalSeverity`. Every rule the word Critical carries read `severity`
 * ALONE, so each lost the Critical the moment a ledger went through `partitionFindings`, `ledger recordRound`, `ledger resolve`,
 * `clear` or `carry reconcile`:
 *
 *   - the stopping rule never defers a Critical (`isActionable`);
 *   - a verifier vote never closes a Critical (`tallyVotes`: it is `disputed`, a person decides it);
 *   - the operator's list offers a Critical's Accept as a security finding's: its own reason, never batched
 *     (`buildDispositionChoices`), and the bead the recorder files says `security` (`planBeads`);
 *   - a Critical re-report outranks a recorded Major (`recordRound`, `dedupeFindings`).
 *
 * THE MERGE GATE. Before #253 the repro (a Critical, `blocking: false`, `deferred`, with a reason) was `mergeable: true`:
 * `partitionFindings` normalized it before the gate asked `isActionable`. Since #253 the gate takes no deferral of an
 * Important finding as an answer (`applyProvenance` strips `blocking`), which refuses the repro for that reason and masks the
 * hole; the cases here that are not marked FAILING FIRST pin that verdict (and the way an operator can still close a Critical)
 * so that relaxing the strip can never again let a Critical through. The cases marked FAILING FIRST failed on the code before
 * the fix.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { spawnSync } = require('child_process');

const cli = require('../lib/pr-review-cli');
const { evaluateGate, BLOCKER_CODES } = require('../lib/pr-review-gate');
const { tallyVotes } = require('../lib/pr-review-votes');
const { buildDispositionChoices } = require('../lib/pr-review-disposition');
const { planBeads, beadKeys } = require('../lib/pr-review-beads');
const {
  isActionable,
  isCritical,
  normalizeFinding,
  partitionFindings,
  dedupeFindings,
  mergeFindings,
  classFindings,
} = require('../lib/pr-review-ledger');

const CLI_PATH = path.join(__dirname, '..', 'lib', 'pr-review-cli.js');
const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const DECISION = { by: 'ldangelo', at: '2026-11-10T10:00:00Z', headSha: HEAD };

function finding(overrides = {}) {
  return {
    id: 'F',
    source: 'code-reviewer',
    locationOrLink: 'a.js:1',
    severity: 'critical',
    failureMode: 'unchecked input reaches the widget',
    disposition: 'fix',
    evidence: 'line 1 reads the payload without validating it',
    originalTextOrLink: 'https://example.invalid/pr/1#discussion_r1',
    ...overrides,
  };
}

/** A finding the triager deferred as non-blocking with a reason: the stopping rule's deferral, whatever the severity. */
const deferred = (severity, overrides = {}) => finding({ severity, blocking: false, disposition: 'deferred', reason: 'x', ...overrides });

/** What the repro in kata 1jp6 hands the gate: a Critical the triager deferred as non-blocking, with a reason. */
const deferredCritical = (overrides = {}) => deferred('critical', overrides);

const inProcess = (subcommand, payload) => JSON.parse(JSON.stringify(cli.HANDLERS[subcommand](JSON.parse(JSON.stringify(payload)))));

const viaProcess = (subcommand, payload) => {
  const run = spawnSync(process.execPath, [CLI_PATH, subcommand], { input: JSON.stringify(payload), encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`pr-review-cli ${subcommand} exited ${run.status}: ${run.stdout}${run.stderr}`);
  return JSON.parse(run.stdout);
};

const RUNNERS = [
  ['the in-process CLI handler', inProcess],
  ['the real `node pr-review-cli.js` process', viaProcess],
];

function gateInput(overrides = {}) {
  return {
    headSha: HEAD,
    ledger: [],
    approvals: { ok: true, satisfied: true, humansRequired: 1, humansCounted: 1, tier: 'medium', headSha: HEAD, approvedBy: ['human-a'] },
    tier: { ok: true, tier: 'medium', effectiveTier: 'medium', humansRequired: 1 },
    description: { ok: true, missing: [], present: ['testing', 'risk', 'rollback'], empty: [], ready: true, warnings: [] },
    security: { status: 'clean', findings: [] },
    coverage: { status: 'complete', gaps: [] },
    ...overrides,
  };
}

/** A ledger entry exactly as `ledger recordRound` writes it down (the form every later step reads). */
const recorded = (run, entry, round = 1, ledger = []) => run('ledger', { action: 'recordRound', ledger, incoming: [entry], round });

const blockersOf = (verdict, code = BLOCKER_CODES.OPEN_IMPORTANT_FINDING) => verdict.blockers.filter((entry) => entry.code === code);

// ---------------------------------------------------------------------------------------------------------------------
describe('reading a finding into the taxonomy changes no blocking outcome (REVIEW.md: nothing is lost)', () => {
  const WORDS = ['critical', 'Critical', 'CRITICAL', 'major', 'Major', 'minor', 'nitpick', 'important', 'Important', 'nit', 'pre-existing', 'spicy'];
  const SHAPES = [
    ['deferred non-blocking with a reason', { disposition: 'deferred', blocking: false, reason: 'opt-in component' }],
    ['deferred with a reason and no blocking flag', { disposition: 'deferred', reason: 'opt-in component' }],
    ['a bare resolution reason', { disposition: 'resolved', resolution: { reason: 'accepted' } }],
    ['an operator resolution', { disposition: 'resolved', resolution: { reason: 'accepted', ...DECISION } }],
    ['cleared by a later head', { disposition: 'fix', cleared: true }],
    ['an open thread on a deferral', { disposition: 'deferred', blocking: false, reason: 'x', unresolvedThread: true }],
    ['an uncertain flag on a deferral', { disposition: 'deferred', blocking: false, reason: 'x', uncertain: true }],
    ['still open', { disposition: 'fix' }],
  ];
  const CASES = WORDS.flatMap((severity) => SHAPES.map(([shape, extra]) => [severity, shape, { severity, ...extra }]));

  test.each(CASES)('%s, %s: isActionable answers the same before and after normalizeFinding (FAILING FIRST for a deferred Critical)', (_severity, _shape, extra) => {
    const written = finding(extra);

    expect(isActionable(normalizeFinding(written))).toBe(isActionable(written));
  });

  test.each(CASES)('%s, %s: the merge gate answers the same for the finding as written and as normalized', (_severity, _shape, extra) => {
    const written = finding(extra);
    const asked = (entry) => {
      const verdict = evaluateGate(gateInput({ ledger: [entry] }));
      return { mergeable: verdict.mergeable, codes: verdict.blockers.map((blocker) => blocker.code), open: verdict.findings.open };
    };

    expect(asked(normalizeFinding(written))).toEqual(asked(written));
  });

  test.each(['critical', 'Critical', 'CRITICAL'])('a deferred non-blocking %s is actionable after normalizeFinding: the stopping rule never defers it (FAILING FIRST)', (severity) => {
    const normalized = normalizeFinding(deferred(severity));

    expect(normalized.severity).toBe('important');
    expect(normalized.originalSeverity).toBe(severity);
    expect(isActionable(normalized)).toBe(true);
  });

  test('a deferred non-blocking Major still is not actionable, written or normalized: only a Critical is never deferrable', () => {
    const major = finding({ severity: 'major', blocking: false, disposition: 'deferred', reason: 'opt-in component' });

    expect(isActionable(major)).toBe(false);
    expect(isActionable(normalizeFinding(major))).toBe(false);
  });

  test('partitionFindings keeps a deferred Critical in `blocking`, and a deferred Major out of it (FAILING FIRST)', () => {
    const parts = partitionFindings([
      deferredCritical({ id: 'C', locationOrLink: 'a.js:1' }),
      deferred('major', { id: 'M', locationOrLink: 'a.js:2', reason: 'opt-in component' }),
    ]);

    expect(parts.ok).toBe(true);
    expect(parts.blocking.map((entry) => entry.id)).toEqual(['C']);
    expect(parts.important.map((entry) => entry.id).sort()).toEqual(['C', 'M']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.each(RUNNERS)('the ledger verbs keep a Critical Critical: %s', (_name, run) => {
  test('`ledger recordRound` writes a deferred Critical down as actionable, and `ledger isActionable` says so (FAILING FIRST)', () => {
    const round = recorded(run, deferredCritical());
    const entry = round.findings[0];

    expect(entry).toMatchObject({ id: 'F', severity: 'important', originalSeverity: 'critical' });
    expect(run('ledger', { action: 'isActionable', finding: entry })).toEqual({ actionable: true });
    expect(run('ledger', { action: 'isActionable', finding: deferredCritical() })).toEqual({ actionable: true });
  });

  test('a Critical re-report of a recorded, deferred Major is an escalation, and the record is no longer deferrable (FAILING FIRST)', () => {
    const major = deferred('major', { id: 'M', reason: 'opt-in component' });
    const first = recorded(run, major);
    expect(run('ledger', { action: 'isActionable', finding: first.findings[0] })).toEqual({ actionable: false });

    const second = recorded(run, finding({ id: 'C', source: 'security-reviewer', severity: 'critical', disposition: 'fix' }), 2, first.findings);

    expect(second.repeats).toEqual([expect.objectContaining({ id: 'C', repeatOf: 'M', reason: 'severity-escalated' })]);
    expect(second.presented.map((entry) => entry.id)).toEqual(['M']);
    const stored = second.findings.find((entry) => entry.id === 'M');
    expect(stored).toMatchObject({ severity: 'important', originalSeverity: 'critical', escalatedInRound: 2, escalatedFrom: 'important' });
    expect(run('ledger', { action: 'isActionable', finding: stored })).toEqual({ actionable: true });
  });

  test('a Critical re-report of a recorded Critical, and a Major re-report of one, stay repeats (nothing is escalated twice)', () => {
    const first = recorded(run, deferredCritical());

    const critical = recorded(run, finding({ id: 'C2', source: 'security-reviewer' }), 2, first.findings);
    const major = recorded(run, finding({ id: 'M2', source: 'security-reviewer', severity: 'major' }), 2, first.findings);

    expect(critical.repeats.map((repeat) => repeat.reason)).toEqual(['already-recorded']);
    expect(major.repeats.map((repeat) => repeat.reason)).toEqual(['already-recorded']);
    expect(major.findings.find((entry) => entry.id === 'F')).toMatchObject({ originalSeverity: 'critical' });
    expect(run('ledger', { action: 'isActionable', finding: major.findings[0] })).toEqual({ actionable: true });
  });

  test('a lower-severity first record is escalated by a Critical report and keeps what it was first recorded as in `escalatedFrom`', () => {
    const nit = recorded(run, finding({ id: 'N', severity: 'nit', disposition: 'deferred', reason: 'style' }));
    const second = recorded(run, finding({ id: 'C', source: 'security-reviewer', severity: 'critical' }), 2, nit.findings);

    expect(second.repeats.map((repeat) => repeat.reason)).toEqual(['severity-escalated']);
    expect(second.findings.find((entry) => entry.id === 'N')).toMatchObject({ severity: 'important', originalSeverity: 'critical', escalatedFrom: 'nit' });
  });
});

describe('dedupe and merge keep a Critical on top however the ledger was written', () => {
  const major = finding({ id: 'M', source: 'reviewer-a', severity: 'major', blocking: false, disposition: 'deferred', reason: 'opt-in component' });

  test.each([
    ['a Critical written as such', (entry) => entry],
    ['a Critical already read into the taxonomy', normalizeFinding],
  ])('%s: a deferred Major cannot hide it, whichever comes first (FAILING FIRST for the normalized one)', (_name, read) => {
    const critical = read(deferredCritical({ id: 'C', source: 'reviewer-b' }));

    for (const group of [[major, critical], [critical, major]]) {
      const [collapsed] = dedupeFindings(group);
      expect(isActionable(collapsed)).toBe(true);
    }
  });

  test('mergeFindings lets a Critical report replace a recorded Major for the same defect, and a Major report does not replace a recorded Critical', () => {
    const existingMajor = normalizeFinding(major);
    const existingCritical = normalizeFinding(deferredCritical({ id: 'C' }));
    const key = { locationOrLink: 'a.js:1', failureMode: 'unchecked input reaches the widget' };

    expect(mergeFindings([existingMajor], [finding({ id: 'C2', ...key, source: 'reviewer-b' })])[0].id).toBe('C2');
    expect(mergeFindings([existingCritical], [{ ...major, ...key }])[0].id).toBe('C');
  });

  test('a class finding is Important when any of its instances is a Critical, read or written', () => {
    const [classFinding] = classFindings([normalizeFinding(finding({ class: 'unvalidated-input' })), finding({ id: 'G', class: 'unvalidated-input', severity: 'nit' })]);

    expect(classFinding.severity).toBe('important');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.each(RUNNERS)('a verifier vote never closes a Critical, read or written: `votes` through %s', (_name, run) => {
  const rejected = [
    { verifier: 'v1', verdict: 'not-real' },
    { verifier: 'v2', verdict: 'not-real' },
    { verifier: 'v3', verdict: 'abstain' },
  ];
  const tally = (entry) => run('votes', { depth: 'standard', findings: [{ ...entry, kind: 'bug', votes: rejected }] }).findings[0];

  test('a Critical as written is disputed and presented: a person decides it', () => {
    expect(tally(finding())).toMatchObject({ outcome: 'disputed', reason: 'security-finding-not-verified', presented: true });
  });

  test('a Critical as `ledger recordRound` recorded it is disputed and presented too (FAILING FIRST)', () => {
    const entry = recorded(run, finding()).findings[0];

    expect(entry).toMatchObject({ severity: 'important', originalSeverity: 'critical' });
    expect(tally(entry)).toMatchObject({ outcome: 'disputed', reason: 'security-finding-not-verified', presented: true });
  });

  test('a Major, written or recorded, that the verifiers reject is still filtered: only a Critical goes to a person', () => {
    const entry = recorded(run, finding({ severity: 'major' })).findings[0];

    expect(tally(entry)).toMatchObject({ outcome: 'filtered', presented: false });
    expect(tally(finding({ severity: 'major' }))).toMatchObject({ outcome: 'filtered', presented: false });
  });

  test('tallyVotes itself agrees with the CLI', () => {
    const entry = normalizeFinding(finding());

    expect(tallyVotes({ depth: 'standard', findings: [{ ...entry, kind: 'bug', votes: rejected }] }).findings[0].outcome).toBe('disputed');
  });
});

describe('the vote tally reads Critical exactly as the ledger does (it mirrors `isCritical`, being a leaf that imports nothing)', () => {
  const WORDS = [undefined, null, '', 5, 'critical', 'Critical', ' CRITICAL ', 'major', 'important', 'minor', 'nit'];
  const CASES = WORDS.flatMap((severity) => WORDS.map((originalSeverity) => [severity, originalSeverity]));
  const rejected = [
    { verifier: 'v1', verdict: 'not-real' },
    { verifier: 'v2', verdict: 'not-real' },
    { verifier: 'v3', verdict: 'abstain' },
  ];

  test.each(CASES)('severity %p, originalSeverity %p: disputed if and only if isCritical', (severity, originalSeverity) => {
    const entry = { id: 'F', reviewer: 'reviewer-a', kind: 'bug', votes: rejected };
    if (severity !== undefined) entry.severity = severity;
    if (originalSeverity !== undefined) entry.originalSeverity = originalSeverity;

    const { outcome } = tallyVotes({ depth: 'standard', findings: [entry] }).findings[0];

    expect(outcome).toBe(isCritical(entry) ? 'disputed' : 'filtered');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('the operator\'s list and the recorder read a Critical as a security finding, read or written', () => {
  const askList = (entry) => buildDispositionChoices({ ledger: [entry], security: { status: 'clean', findings: [] }, headSha: HEAD }).dispositionChoices;
  const shape = (entries) =>
    entries.map((entry) => ({
      id: entry.id,
      group: entry.group,
      security: entry.security,
      requiresReason: entry.requiresReason,
      reasonPerFinding: entry.reasonPerFinding,
      accept: entry.choices.find((choice) => choice.id === 'accept').batchable,
    }));

  test('the decision list for a Critical as written: security, its own reason, Accept never batched', () => {
    expect(shape(askList(finding()))).toEqual([{ id: 'F', group: 'blocking', security: true, requiresReason: true, reasonPerFinding: true, accept: false }]);
  });

  test('the decision list for the same Critical already read into the taxonomy is the same list (FAILING FIRST)', () => {
    expect(shape(askList(normalizeFinding(finding())))).toEqual(shape(askList(finding())));
  });

  test('an Important finding is still not a security finding (nothing else changed)', () => {
    expect(shape(askList(finding({ severity: 'important' })))).toEqual([{ id: 'F', group: 'blocking', security: false, requiresReason: true, reasonPerFinding: undefined, accept: false }]);
    expect(shape(askList(normalizeFinding(finding({ severity: 'major' }))))[0].security).toBe(false);
  });

  const bead = (entry) => {
    const input = { repo: 'Acme/Widgets', prNumber: 7, headSha: HEAD, ledger: [entry] };
    const lookups = Object.fromEntries(beadKeys(input).keys.map((key) => [key, { ok: true, found: false }]));
    return planBeads(input, lookups).actions.find((action) => action.action === 'create').create;
  };

  test('the bead filed for a Critical says `security` whether or not the ledger was read into the taxonomy (FAILING FIRST)', () => {
    const written = bead(finding());

    expect(written.title).toContain('[important, security]');
    expect(bead(normalizeFinding(finding())).title).toBe(written.title);
    expect(bead(normalizeFinding(finding())).priority).toBe(written.priority);
  });

  test('the bead filed for an Important finding does not say security', () => {
    expect(bead(normalizeFinding(finding({ severity: 'major' }))).title).not.toContain('security');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('the merge gate refuses a deferred Critical, names it, and lets the operator close it (kata 1jp6)', () => {
  test('the repro of kata 1jp6, evaluateGate: not mergeable, one named blocker that says a Critical is never deferrable (FAILING FIRST for the wording)', () => {
    const verdict = evaluateGate(gateInput({ ledger: [deferredCritical()] }));

    expect(verdict.mergeable).toBe(false);
    expect(verdict.findings.open).toEqual(['F']);
    const [blocker, ...rest] = blockersOf(verdict);
    expect(rest).toEqual([]);
    expect(blocker).toMatchObject({ findingId: 'F', locationOrLink: 'a.js:1' });
    expect(blocker.message).toContain('F (a.js:1)');
    expect(blocker.message).toMatch(/deferral/);
    expect(blocker.deferralRejected).toMatch(/Critical is never deferrable/);
    expect(blocker.message).toContain(blocker.deferralRejected);
    expect(blocker.nextAction).toContain('ledger resolve');
    expect(verdict.blockers).toHaveLength(1);
  });

  describe('the Critical stays refused on the ledger rule alone: the gate as it was before #253, with no deferral stripped', () => {
    // #253 made `applyProvenance` strip `blocking` from every Important finding, which refuses the repro for a reason of the
    // gate's own. This compiles the REAL gate with that one line removed (an anchor that stops matching is an error, never a
    // silent pass; the way pr-review-vote-gate-scenarios compiles a mutant of the vote tally), so the refusal of a Critical is
    // shown to rest on `isActionable` and not on the line above it.
    const STRIP = "if (severity === 'important') reading = withoutDeferral(reading);";
    const GATE_PATH = path.join(__dirname, '..', 'lib', 'pr-review-gate.js');
    const gateWithoutStrip = () => {
      const source = fs.readFileSync(GATE_PATH, 'utf8');
      expect(source).toContain(STRIP);
      const mod = { exports: {} };
      const wrapper = vm.runInThisContext(`(function (exports, module, require, __filename, __dirname) {${source.replace(STRIP, '')}\n})`, { filename: `${GATE_PATH}#no-strip` });
      wrapper(mod.exports, mod, createRequire(GATE_PATH), GATE_PATH, path.dirname(GATE_PATH));
      return mod.exports.evaluateGate;
    };

    test.each(['critical', 'Critical'])('a deferred non-blocking %s: not mergeable, as written and as read into the taxonomy (FAILING FIRST: this was mergeable:true, the symptom of kata 1jp6)', (severity) => {
      const evaluate = gateWithoutStrip();

      for (const entry of [deferred(severity), normalizeFinding(deferred(severity))]) {
        const verdict = evaluate(gateInput({ ledger: [entry] }));

        expect(verdict.mergeable).toBe(false);
        expect(verdict.findings.open).toEqual(['F']);
        expect(verdict.blockers.map((blocker) => blocker.code)).toEqual([BLOCKER_CODES.OPEN_IMPORTANT_FINDING]);
      }
    });

    test('the same gate does take the deferral of a non-blocking Major, so the strip really is what is missing', () => {
      const evaluate = gateWithoutStrip();

      expect(evaluate(gateInput({ ledger: [deferred('major')] })).mergeable).toBe(true);
      expect(evaluate(gateInput({ ledger: [deferred('important')] })).mergeable).toBe(true);
    });
  });

  test.each(['critical', 'Critical', 'CRITICAL'])('%s is held the same way, and a Critical that is also an open thread still names it', (severity) => {
    for (const extra of [{}, { unresolvedThread: true }]) {
      const verdict = evaluateGate(gateInput({ ledger: [deferred(severity, extra)] }));

      expect(verdict.mergeable).toBe(false);
      expect(blockersOf(verdict)[0].deferralRejected).toMatch(/Critical is never deferrable/);
    }
  });

  test('the gate says the same about a Critical already read into the taxonomy', () => {
    const asked = (entry) => evaluateGate(gateInput({ ledger: [entry] }));

    expect(asked(normalizeFinding(deferredCritical()))).toEqual(asked(deferredCritical()));
  });

  test('an Important or Major finding deferred the same way is unchanged: refused as the review\'s own classification, never called a Critical', () => {
    for (const severity of ['important', 'major']) {
      const verdict = evaluateGate(gateInput({ ledger: [deferred(severity)] }));
      const [blocker] = blockersOf(verdict);

      expect(verdict.mergeable).toBe(false);
      expect(blocker.deferralRejected).toContain("the review's own classification");
      expect(blocker.deferralRejected).not.toMatch(/Critical/);
    }
  });

  test('a Nit deferred the same way still does not block', () => {
    const verdict = evaluateGate(gateInput({ ledger: [deferred('nit')] }));

    expect(verdict.mergeable).toBe(true);
    expect(verdict.findings.open).toEqual([]);
  });

  test('a deferred Critical in the security lane blocks as an open lane finding', () => {
    const verdict = evaluateGate(gateInput({ security: { status: 'findings', findings: [deferredCritical()] } }));

    expect(verdict.mergeable).toBe(false);
    expect(verdict.securityLane.open).toEqual(['F']);
  });

  describe('the operator can still accept a Critical, the one way the gate takes: a decision with a login, a time and this head', () => {
    const accepted = (decision) => ({ ...deferredCritical(), disposition: 'resolved', resolution: { reason: 'the caller validates it upstream', ...decision } });

    test('with every part: the Critical stops blocking (a Critical is accepted like an Important finding, with its own reason)', () => {
      const verdict = evaluateGate(gateInput({ ledger: [accepted(DECISION)] }));

      expect(verdict.mergeable).toBe(true);
      expect(verdict.findings.open).toEqual([]);
    });

    test.each([
      ['a bare reason', {}],
      ['no deciding login', { at: DECISION.at, headSha: HEAD }],
      ['no timestamp', { by: DECISION.by, headSha: HEAD }],
      ['an earlier head', { ...DECISION, headSha: OLD_HEAD }],
    ])('%s still blocks, and the blocker says the resolution does not count', (_name, decision) => {
      const verdict = evaluateGate(gateInput({ ledger: [accepted(decision)] }));

      expect(verdict.mergeable).toBe(false);
      expect(blockersOf(verdict)[0].resolutionRejected).toEqual(expect.any(String));
    });

    test.each(RUNNERS)('`ledger resolve` records the decision on a Critical and the gate takes it (%s)', (_name, run) => {
      const { finding: resolved } = run('ledger', { action: 'resolve', finding: deferredCritical(), resolution: { reason: 'the caller validates it upstream', ...DECISION } });

      expect(resolved).toMatchObject({ disposition: 'resolved', severity: 'important', originalSeverity: 'critical' });
      expect(run('ledger', { action: 'isActionable', finding: resolved })).toEqual({ actionable: false });
      expect(run('gate', gateInput({ ledger: [resolved] })).mergeable).toBe(true);
    });

    test.each(RUNNERS)('`ledger resolve` refuses a decision with no login, and the Critical stays blocked (%s)', (_name, run) => {
      expect(() => run('ledger', { action: 'resolve', finding: deferredCritical(), resolution: { reason: 'accepted', headSha: HEAD, at: DECISION.at } })).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.each(RUNNERS)('the real gate action over a ledger the CLI wrote: %s', (_name, run) => {
  test('the repro verbatim: not mergeable, named, and the same answer as the library', () => {
    const request = gateInput({ ledger: [deferredCritical()] });
    const answer = run('gate', request);

    expect(answer.mergeable).toBe(false);
    expect(answer.reasons).toEqual([BLOCKER_CODES.OPEN_IMPORTANT_FINDING]);
    expect(blockersOf(answer)[0]).toMatchObject({ findingId: 'F' });
    expect(blockersOf(answer)[0].deferralRejected).toMatch(/Critical is never deferrable/);
    expect(answer.blockers).toEqual(evaluateGate(request).blockers);
  });

  test('a deferred Critical from `ledger recordRound` (read into the taxonomy): not mergeable, and the operator list still offers it as security (FAILING FIRST)', () => {
    const { findings } = recorded(run, deferredCritical());
    const answer = run('gate', gateInput({ ledger: findings }));

    expect(answer.mergeable).toBe(false);
    expect(blockersOf(answer)[0].deferralRejected).toMatch(/Critical is never deferrable/);
    expect(answer.dispositionChoices).toHaveLength(1);
    expect(answer.dispositionChoices[0]).toMatchObject({ id: 'F', group: 'blocking', security: true, requiresReason: true, reasonPerFinding: true });
    expect(answer.dispositionChoices[0].choices.find((choice) => choice.id === 'accept')).toMatchObject({ batchable: false, requiresReason: true, default: false });
    expect(answer.dispositionChoices[0].choices.some((choice) => choice.id === 'follow-on')).toBe(false);
  });

  test('a Critical the operator accepted with a full decision, carried through `recordRound`, lets the gate pass and is still listed as a security acceptance (FAILING FIRST for the listing)', () => {
    const { finding: resolved } = run('ledger', { action: 'resolve', finding: deferredCritical(), resolution: { reason: 'the caller validates it upstream', ...DECISION } });
    const { findings } = recorded(run, resolved);
    const answer = run('gate', gateInput({ ledger: findings }));

    expect(answer.mergeable).toBe(true);
    expect(answer.dispositionChoices).toEqual([]);
    expect(answer.mergeConfirmation.acceptedBlocking).toEqual([expect.objectContaining({ id: 'F', security: true, by: 'ldangelo' })]);
  });

  test('an Important finding deferred the same way stays refused, and is not offered as security', () => {
    const answer = run('gate', gateInput({ ledger: [deferred('important')] }));

    expect(answer.mergeable).toBe(false);
    expect(answer.dispositionChoices[0]).toMatchObject({ id: 'F', security: false });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.each(RUNNERS)('the review status over the counts the skill derives from a ledger the CLI wrote: %s', (_name, run) => {
  const BASE = '8b87a6d71146cd2e36e09c4fc265b6bb336f8798';
  const REVIEWED = 'b8fe66aeb70b304237e584311a2b481a3c990f91';
  const statusOf = (findingCounts) =>
    run('status', {
      baseSha: BASE,
      headSha: REVIEWED,
      reviewedHeadSha: REVIEWED,
      prUrl: 'https://github.com/org/repo/pull/1',
      roundsUsed: 1,
      findingCounts,
      coverage: { status: 'complete', gaps: [] },
      tests: { exitCode: 0, skipped: false, command: 'npx jest tests/foo.test.js' },
      remotePhase: 'REMOTE_REVIEW_COMPLETE',
      access: { ok: true },
      reportPath: '.ensemble/pr-review/pr-1.json',
    });
  /** The counts `status` takes: one `ledger isActionable` per recorded finding, the rest of the deferred ones counted deferred. */
  const countsOf = (ledger) => {
    const actionable = ledger.filter((entry) => run('ledger', { action: 'isActionable', finding: entry }).actionable);
    const deferredEntries = ledger.filter((entry) => !actionable.includes(entry) && entry.disposition === 'deferred');
    return { total: ledger.length, actionable: actionable.length, deferred: deferredEntries.length };
  };

  test('a deferred non-blocking Critical is counted actionable, so the local review is not complete (FAILING FIRST: it was counted deferred, and the review read complete)', () => {
    const counts = countsOf(recorded(run, deferredCritical()).findings);

    expect(counts).toEqual({ total: 1, actionable: 1, deferred: 0 });
    const status = statusOf(counts);
    expect(status.localPhase).not.toBe('LOCAL_REVIEW_COMPLETE');
    expect(status.status).not.toBe('REVIEW_COMPLETE');
  });

  test('a deferred non-blocking Major is still counted deferred, and the local review may complete (unchanged)', () => {
    const counts = countsOf(recorded(run, deferred('major', { reason: 'opt-in component' })).findings);

    expect(counts).toEqual({ total: 1, actionable: 0, deferred: 1 });
    expect(statusOf(counts).localPhase).toBe('LOCAL_REVIEW_COMPLETE');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('the word Critical is read where it is defined, and only in the places that cannot import it', () => {
  const LIB = path.join(__dirname, '..', 'lib');

  // The ledger defines `isCritical`. `pr-review-votes.js` imports nothing (two harnesses load it alone) and mirrors it; the
  // agreement table above keeps the mirror honest. Every other review module asks `isCritical`.
  const ALLOWED = ['pr-review-ledger.js', 'pr-review-votes.js'];

  test('no other review module compares a severity with the literal `critical`: they ask `isCritical` (FAILING FIRST)', () => {
    const readers = fs
      .readdirSync(LIB)
      .filter((name) => /^(pr-review|review)-.*\.js$/.test(name) && !ALLOWED.includes(name))
      .filter((name) => /toLowerCase\(\)\s*===\s*'critical'/.test(fs.readFileSync(path.join(LIB, name), 'utf8')));

    expect(readers).toEqual([]);
  });
});
