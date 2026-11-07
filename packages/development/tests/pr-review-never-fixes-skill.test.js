'use strict';

/**
 * The review never fixes (docs/plans/pr-review-speedup-plan.md section 3H items 2, 4 and 6;
 * kata sp4w, AC1).
 *
 * Structural assertions over the pr-review-cycle skill and its companions, in the style of
 * pr-review-cycle-skill.test.js: a skill has no runtime harness, so the contract is what a
 * maintainer or another skill reads. What the prose relies on from code (a resolution
 * closes a finding at the gate; the Fix on this PR option says the head moves) is checked
 * against the real modules, so the prose cannot drift from them unseen. The behavioural half
 * (a review run edits no file and pushes nothing) is pr-review-run-edits-nothing.test.js.
 */

const { readSkillMain, readSkillReference } = require('./helpers/pr-review-cycle-skill');
const { evaluateGate } = require('../lib/pr-review-gate');
const { recordOperatorResolution } = require('../lib/pr-review-ledger');
const { buildDispositionChoices } = require('../lib/pr-review-disposition');

const flatten = (s) => s.replace(/\s+/g, ' ');
const MAIN = readSkillMain();
const FLAT_MAIN = flatten(MAIN);
const TRIAGE = flatten(readSkillReference('triage-fix-reverify.md'));
const GATE_REF = flatten(readSkillReference('merge-gate.md'));
const INPUTS = flatten(readSkillReference('inputs.md'));
const REMOTE = flatten(readSkillReference('remote-phase.md'));

/** `### Step <label> --` sections of SKILL.md's Algorithm, keyed by label ("1b", "5", "10"). */
function algorithmSteps() {
  const algorithm = MAIN.slice(MAIN.indexOf('## Algorithm'), MAIN.indexOf('## Safety rules'));
  const steps = {};
  const parts = algorithm.split(/^### Step /m).slice(1);
  for (const part of parts) {
    const label = part.slice(0, part.indexOf(' ')).trim();
    steps[label] = part;
  }
  return steps;
}

const STEPS = algorithmSteps();
const section = (title) => {
  const start = MAIN.indexOf(`## ${title}`);
  expect(start).toBeGreaterThan(-1);
  return flatten(MAIN.slice(start, MAIN.indexOf('\n---', start)));
};

describe('the review path has no fix or push step', () => {
  test('only Step 5 delegates to pr-review-remediation, and it says it is not part of any review run', () => {
    for (const [label, text] of Object.entries(STEPS)) {
      if (label === '5') continue;
      expect([label, text.includes('pr-review-remediation/SKILL.md')]).toEqual([label, false]);
    }
    expect(Object.keys(STEPS)).toEqual(expect.arrayContaining(['1', '4', '5', '6', '7', '8', '9', '10']));
    expect(flatten(STEPS['5'])).toContain('**Not part of any review run:** a fix run (`FIX_SELECTION`) or a pre-publication snapshot only');
  });

  test('the algorithm lists Step 5 for no review mode on a PR', () => {
    const algorithm = flatten(MAIN.slice(MAIN.indexOf('## Algorithm'), MAIN.indexOf('### Step 1 --')));
    expect(algorithm).toMatch(/`MODE=local` runs Steps 1-4, the tests fact of Step 6 and Steps 8-9 \(Step 5 and Step 6's post-fix verification only for a pre-publication snapshot\)/);
    expect(algorithm).toContain('`MODE=remote` runs Steps 1, 1b and 7-9');
    expect(algorithm).toContain('`MODE=gate` runs Steps 1, 1b and 10 -- and only those');
    expect(algorithm).toContain('A run with `FIX_SELECTION` is a fix run: Steps 1 and 5');
  });

  test('a remote review records its findings and edits nothing: the old "fix as one batch before any push" rule is gone', () => {
    const step7 = flatten(STEPS['7']);
    expect(step7).toContain('Actionable remote findings are recorded, never fixed by this run');
    expect(step7).not.toMatch(/repeat Steps 4-6 as one batch/);
    expect(REMOTE).toContain('this run triages them (Step 4) and records them, and edits nothing: a review never fixes');
  });

  test('the merge gate fixes nothing and pushes nothing, and hands every answer to the operator', () => {
    const step10 = flatten(STEPS['10']);
    expect(step10).toContain('no reviewers, fixes or pushes');
    expect(step10).toContain("`gate` also returns the operator's decision list: show it before any merge question");
    expect(GATE_REF).toContain('Nothing here edits a file, commits or pushes.');
  });

  test('"The review never fixes" states the rule for every review mode before the algorithm starts', () => {
    const rule = section('The review never fixes');
    expect(MAIN.indexOf('## The review never fixes')).toBeLessThan(MAIN.indexOf('## Algorithm'));
    expect(rule).toContain('A review run (`MODE=local` of a PR, `remote`, `gate`) edits no file, commits nothing and pushes nothing');
    expect(rule).toContain('An agent never chooses for the operator');
  });

  test('a PR review run is never the pre-publication snapshot: a PR URL, a PR number or REVIEW_ONLY each ends the carve-out', () => {
    expect(section('The review never fixes')).toContain(
      'A pre-publication snapshot (`MODE=local`, no `PR_URL`/`PR_NUMBER`, not `REVIEW_ONLY`)'
    );
    expect(TRIAGE).toContain('`MODE=local`, no `PR_URL`, no `PR_NUMBER`, no `REVIEW_ONLY`');
    expect(INPUTS).toContain('Only a pre-publication snapshot (no `PR_URL`, no `PR_NUMBER`, no `REVIEW_ONLY`) also runs Step 5');
  });
});

describe('--foreman logs and never fixes', () => {
  test('the rule names no fix agent, no waiver and a gate that stays closed', () => {
    const rule = section('The review never fixes');
    expect(rule).toContain('`--foreman` logs and never fixes, waives no blocking finding and leaves the gate `mergeable:false`');
  });

  test('every place a Foreman run could be told otherwise carries the rule', () => {
    expect(INPUTS).toMatch(/`FOREMAN` \| boolean \|[^|]*never asks, fixes, `resolve`s or waives anything/);
    expect(INPUTS).toContain('an open one keeps the gate `mergeable:false` until a person decides');
    expect(REMOTE).toContain('never dismiss the finding to force completion, never fix it and never record a `resolve` for it');
    expect(GATE_REF).toMatch(/\*\*`--foreman`\*\*: the list is logged and nothing is recorded as decided: no `resolve`, no fix run, no waiver/);
    expect(TRIAGE).toContain('Refuse (`REVIEW_BLOCKED`, nothing edited) when `FOREMAN` is true');
  });
});

describe('the operator chooses, and a Fix on this PR answer is never a resolution', () => {
  test('the prose forbids recording Fix on this PR with ledger resolve in every place it is explained', () => {
    expect(section('The review never fixes')).toContain('a Fix on this PR answer never does');
    expect(TRIAGE).toContain('The selection is never recorded with `ledger` `resolve`');
    expect(GATE_REF).toContain('**Fix on this PR: never `ledger` `resolve`.**');
    expect(INPUTS).toContain('Never written with `ledger` `resolve`, which would close the finding at the gate without the fix.');
  });

  test('the premise is true: the gate reads any resolution with provenance as the finding closed, whatever its reason', () => {
    const head = 'a'.repeat(40);
    const important = {
      id: 'F-1',
      source: 'reviewer-1',
      locationOrLink: 'src/b.js:1',
      severity: 'important',
      failureMode: 'unchecked input',
      disposition: 'fix',
      evidence: 'line 1',
      originalTextOrLink: 'https://example.invalid/r/1',
    };
    const gateFor = (ledger) =>
      evaluateGate({
        headSha: head,
        ledger,
        approvals: { ok: true, headSha: head, satisfied: true, reason: 'required-approvals-present', tier: 'medium', humansRequired: 1, humansCounted: 1, approvedBy: ['h'], directedBy: null, ignored: [], refusals: [], reasons: [], warnings: [] },
        tier: { ok: true, tier: 'medium', effectiveTier: 'medium', humansRequired: 1, refusals: [], reasons: [], warnings: [] },
        description: { ok: true, missing: [], present: ['testing', 'risk', 'rollback'], empty: [], ready: true, warnings: [] },
        security: { status: 'clean', findings: [] },
      });

    expect(gateFor([important]).mergeable).toBe(false);
    const recorded = recordOperatorResolution(important, { reason: 'Fix on this PR', by: 'ldangelo', headSha: head, at: '2026-11-07T10:00:00Z' });
    expect(recorded.ok).toBe(true);
    // Recording the selection would have passed the gate with no fix: why the skill must not.
    expect(gateFor([recorded.finding]).mergeable).toBe(true);
  });

  test('the decision list the skill shows says the head moves and approvals reset, and lets a blocking finding be fixed or accepted only', () => {
    const head = 'a'.repeat(40);
    const finding = {
      id: 'F-1',
      source: 'reviewer-1',
      locationOrLink: 'src/b.js:1',
      severity: 'important',
      failureMode: 'unchecked input',
      disposition: 'fix',
      evidence: 'line 1',
      originalTextOrLink: 'https://example.invalid/r/1',
    };
    const list = buildDispositionChoices({ ledger: [finding], security: { status: 'clean', findings: [] }, headSha: head });
    expect(list.ok).toBe(true);
    const entry = list.dispositionChoices.find((c) => c.id === 'F-1');
    expect(entry.choices.map((c) => c.id)).toEqual(['fix-here', 'accept']);
    const fixHere = entry.choices.find((c) => c.id === 'fix-here');
    expect(fixHere.note).toMatch(/head moves/);
    expect(fixHere.note).toMatch(/approvals reset/);
    expect(fixHere.default).toBe(true);
    expect(entry.choices.find((c) => c.id === 'accept').default).toBe(false);
  });

  test('the fix run is one agent and one push for the whole selection, then a delta re-review and the gate again', () => {
    expect(TRIAGE).toContain('One fix agent');
    expect(TRIAGE).toContain('**one push** for the whole selection');
    expect(TRIAGE).toContain('re-runs `MODE=local` on the new head (CLI `review-range`: a delta re-review) and `MODE=gate` again');
    expect(FLAT_MAIN).toContain('one fix agent, one push');
  });

  test('a fix run refuses an unreadable selection: empty, no login or time, unknown finding, or a head that moved', () => {
    for (const refusal of [
      'the selection is empty',
      'an entry lacks `by` or `at`',
      'names an `id` not in the ledger',
      'has a `headSha` other than `HEAD_SHA`',
    ]) {
      expect([refusal, TRIAGE.includes(refusal)]).toEqual([refusal, true]);
    }
  });
});
