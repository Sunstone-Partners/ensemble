'use strict';

/**
 * /ensemble:pr-merge presents the operator's dispositions before it asks to merge
 * (kata 6k8d; plan docs/plans/pr-review-speedup-plan.md section 3H, acceptance tests (d) and (e)).
 *
 * The command is prose a model follows, so the contract is its flow and what it relies on from
 * code. Flow: the disposition step sits between the review gate and the merge, the confirmation
 * question is reachable only after it, and the remediation-skip shortcut still passes through it.
 * Reliance: every gate field, blocker code and halted_reason the prose names is checked against
 * the real gate (a spawned `pr-review-cli.js gate`) and the procedure the prose delegates to
 * (`reference/merge-gate.md`), so a rename on either side fails here instead of drifting.
 * The live drive (rpc-ui) and the real dry-run are recorded on the PR, not pinned here.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const { BLOCKER_CODES } = require('../lib/pr-review-gate');
const { readSkillReference } = require('./helpers/pr-review-cycle-skill');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const CLI = path.join(__dirname, '..', 'lib', 'pr-review-cli.js');
const read = (...parts) => fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');

const COMMAND = yaml.load(read('packages', 'git', 'commands', 'pr-merge.yaml'));
const GATE_REF = flat(readSkillReference('merge-gate.md'));

/** Every action in workflow order, each with where it sits. */
function actionsInOrder() {
  const out = [];
  for (const phase of COMMAND.workflow.phases) {
    for (const step of phase.steps) {
      for (const action of step.actions || []) out.push({ phase: phase.name, step: step.title, text: action });
    }
  }
  return out;
}
const stepOf = (phaseName, title) =>
  COMMAND.workflow.phases.find((p) => p.name === phaseName).steps.find((s) => s.title === title);

const MERGE_QUESTION = 'Allow the host adapter to merge PR';

const HEAD = 'a'.repeat(40);
function gateInput(extra = {}) {
  return {
    headSha: HEAD,
    ledger: [],
    approvals: {
      ok: true, headSha: HEAD, satisfied: true, reason: 'required-approvals-present', tier: 'medium',
      humansRequired: 1, humansCounted: 1, approvedBy: ['human-a'], directedBy: null, ignored: [],
      refusals: [], reasons: [], warnings: [],
    },
    tier: { ok: true, tier: 'medium', effectiveTier: 'medium', humansRequired: 1, refusals: [], reasons: [], warnings: [] },
    description: { ok: true, missing: [], present: ['testing', 'risk', 'rollback'], empty: [], ready: true, warnings: [] },
    security: { status: 'clean', findings: [] },
    ...extra,
  };
}
function runGate(payload) {
  const run = spawnSync('node', [CLI, 'gate'], { input: JSON.stringify(payload), encoding: 'utf8' });
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout);
}
const importantFinding = (id = 'F-1') => ({
  id, source: 'code-reviewer', locationOrLink: 'packages/development/lib/widget.js:12', severity: 'important',
  failureMode: 'unchecked input', disposition: 'fix', evidence: 'line 12', originalTextOrLink: 'https://example.invalid/pr/1#r1',
});

describe('AC1: the merge-confirmation question is not asked until the operator answered the list', () => {
  test('Merge and Report runs gate, then disposition, then merge, then report', () => {
    const steps = COMMAND.workflow.phases.find((p) => p.name === 'Merge and Report').steps;
    expect(steps.map((s) => [s.order, s.title])).toEqual([
      [1, 'Review Merge Gate'],
      [2, 'Operator Disposition'],
      [3, 'Merge'],
      [4, 'Final Report'],
    ]);
  });

  test('the disposition questions come before the merge question and the merge question only exists in the Merge step', () => {
    const actions = actionsInOrder();
    const firstList = actions.findIndex((a) => a.step === 'Operator Disposition' && /multi-select/.test(a.text));
    const asks = actions.map((a, i) => (a.text.includes(MERGE_QUESTION) ? i : -1)).filter((i) => i >= 0);
    expect(firstList).toBeGreaterThan(-1);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toBeGreaterThan(firstList);
    expect(actions[asks[0]].step).toBe('Merge');
  });

  test('the merge question carries the summary of what is being accepted, and says it follows the disposition step', () => {
    const merge = stepOf('Merge and Report', 'Merge').actions.join(' ');
    expect(merge).toContain(`"<MERGE_SUMMARY> ${MERGE_QUESTION}`);
    const disposition = stepOf('Merge and Report', 'Operator Disposition').actions.join(' ');
    expect(disposition).toMatch(/MERGE_SUMMARY \(open beads, accepted blocking findings with reason and login\)/);
    expect(disposition).toMatch(/asked only after this step has finished on this head/);
  });

  test('a constraint forbids the question before the answer, and the ask tool is allowed (it maps to ask on pi)', () => {
    expect(COMMAND.constraints.some((c) => /NEVER ask the merge-confirmation question before the operator has answered/.test(c))).toBe(true);
    expect(COMMAND.metadata.allowed_tools).toContain('AskUserQuestion');
  });
});

describe('AC3: the remediation-skip shortcut still reaches the disposition step', () => {
  test('the skip action names the disposition step and the gate, and the disposition step runs on every path', () => {
    const skip = stepOf('PR Discovery', 'Baseline Findings Manifest').actions.find((a) => /skip to Merge and Report/.test(a));
    expect(skip).toMatch(/never skips the Review Merge Gate/);
    expect(skip).toMatch(/nor the Operator Disposition step/);
    const first = stepOf('Merge and Report', 'Operator Disposition').actions[0];
    expect(first).toMatch(/EVERY path to Merge, including the remediation-skip shortcut and a mergeable:true gate/);
  });
});

describe('AC2: --foreman records nothing as decided, runs no fix agent, and the gate keeps refusing', () => {
  test('the prose says so in the step, the constraints and the flag description', () => {
    const foreman = stepOf('Merge and Report', 'Operator Disposition').actions.find((a) => a.startsWith('--foreman'));
    expect(foreman).toMatch(/ask, resolve, fix, default and waive nothing/);
    expect(foreman).toMatch(/mergeable:false HALTs findings-need-operator/);
    expect(COMMAND.constraints.some((c) => /Under --foreman nothing is asked, decided, fixed or waived and the gate keeps refusing/.test(c))).toBe(true);
    expect(COMMAND.expectedInput.sections.find((s) => s.name === 'Foreman Mode').description).toMatch(/only logged \(never fixed or decided\)/);
  });

  test('what the prose relies on is true of the real gate: an undecided Important finding refuses, is listed, and offers no follow-on or default Accept', () => {
    const out = runGate(gateInput({ ledger: [importantFinding()] }));
    expect(out.mergeable).toBe(false);
    expect(out.blockers.map((b) => b.code)).toEqual(['open-important-finding']);
    const entry = out.dispositionChoices[0];
    expect(entry.group).toBe('blocking');
    expect(entry.choices.map((c) => c.id)).toEqual(['fix-here', 'accept']);
    expect(entry.default).toBe('fix-here');
    expect(entry.requiresReason).toBe(true);
    // Nothing was decided, so asking the gate again (what --foreman leaves behind) refuses again.
    expect(runGate(gateInput({ ledger: [importantFinding()] })).mergeable).toBe(false);
  });

  test('a Fix on this PR answer recorded as a resolution would pass the finding with no fix: the prose must not resolve it', () => {
    const closedByFixAnswer = {
      ...importantFinding(),
      disposition: 'resolved',
      resolution: { reason: 'fix on this PR', by: 'ldangelo', at: '2026-11-07T10:00:00Z', headSha: HEAD },
    };
    expect(runGate(gateInput({ ledger: [closedByFixAnswer] })).mergeable).toBe(true);
    const disposition = stepOf('Merge and Report', 'Operator Disposition').actions.join(' ');
    expect(disposition).toMatch(/Fix on this PR \(one fix run with FIX_SELECTION, never ledger resolve,/);
  });
});

describe('the prose names only what the real gate and its reference provide', () => {
  const yamlText = flat(read('packages', 'git', 'commands', 'pr-merge.yaml'));

  test('the review-finding blocker codes the command lists are exactly the gate\'s finding blockers', () => {
    const gateFindingCodes = Object.values(BLOCKER_CODES).filter((code) => /finding/.test(code)).sort();
    const named = [...yamlText.matchAll(/\b(open-[a-z-]+-finding|security-finding-open)\b/g)].map((m) => m[1]);
    expect([...new Set(named)].sort()).toEqual(gateFindingCodes);
  });

  test('a real gate returns every field the command and the reference say Operator Disposition reads', () => {
    const out = runGate(gateInput());
    for (const key of ['mergeable', 'blockers', 'dispositionChoices', 'dispositionGroups', 'mergeConfirmation']) {
      expect(out).toHaveProperty(key);
      expect(yamlText + GATE_REF).toContain(key);
    }
    expect(out.mergeConfirmation).toHaveProperty('summary');
    expect(out.mergeConfirmation).toHaveProperty('acceptedBlocking');
    expect(out.mergeConfirmation).toHaveProperty('openBeads');
  });

  test('a list the gate cannot build comes back with dispositionReason and no entries, which the command halts on', () => {
    const out = runGate(gateInput({ ledger: [{ severity: 'important' }] }));
    expect(out.mergeable).toBe(false);
    expect(typeof out.dispositionReason).toBe('string');
    expect(out.dispositionChoices).toEqual([]);
    expect(yamlText).toMatch(/dispositionReason set, or no dispositionChoices array\) HALTs disposition-unavailable/);
  });

  test('every halted_reason the command introduces is described in the procedure it delegates to', () => {
    const introduced = ['disposition-unavailable', 'disposition-incomplete', 'gate-blocked', 'findings-need-operator'];
    for (const reason of introduced) {
      expect([reason, yamlText.includes(reason)]).toEqual([reason, true]);
      expect([reason, GATE_REF.includes(reason)]).toEqual([reason, true]);
    }
  });

  test('the procedure the command points at exists under the name the command gives', () => {
    expect(GATE_REF).toContain('Driving the list from `/ensemble:pr-merge` (Operator Disposition)');
    expect(yamlText).toContain("'Driving the list from /ensemble:pr-merge' in reference/merge-gate.md of the pr-review-cycle skill");
  });
});

describe('AC4: every shipped rendering carries the disposition step, in order, at the command version', () => {
  const surfaces = {
    claude: 'packages/git/commands/ensemble/pr-merge.md',
    'pi prompt': 'packages/pi/prompts/ensemble-pr-merge.md',
    'pi skill': 'packages/pi/skills/ensemble-pr-merge/SKILL.md',
    codex: 'packages/codex/.codex/skills/commands/ensemble-pr-merge/SKILL.md',
  };

  test.each(Object.entries(surfaces))('%s: the disposition step precedes the merge question', (_name, file) => {
    const text = flat(read(...file.split('/')));
    const disposition = text.indexOf('Operator Disposition');
    const question = text.indexOf(MERGE_QUESTION);
    expect(disposition).toBeGreaterThan(-1);
    expect(question).toBeGreaterThan(disposition);
  });

  test('the renderings that state a version carry the YAML version (a stale generation would not)', () => {
    for (const name of ['claude', 'pi prompt', 'pi skill']) {
      expect([name, read(...surfaces[name].split('/')).includes(COMMAND.metadata.version)]).toEqual([name, true]);
    }
  });

  test('the version was raised past the one before this change (2.3.0)', () => {
    const [major, minor] = COMMAND.metadata.version.split('.').map(Number);
    expect(major * 1000 + minor).toBeGreaterThanOrEqual(2 * 1000 + 4);
  });

  test('the pi renderings call the question tool ask, not AskUserQuestion', () => {
    for (const file of [surfaces['pi prompt'], surfaces['pi skill']]) {
      const text = read(...file.split('/'));
      expect(text).not.toContain('AskUserQuestion');
      expect(text).toMatch(/multi-select ask per group/);
    }
  });
});
