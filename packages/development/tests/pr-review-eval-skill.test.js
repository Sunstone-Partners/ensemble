'use strict';

/**
 * TRD-033: structure and contract of
 * packages/development/skills/pr-review-eval/SKILL.md and its case template.
 *
 * A procedure skill is prose, so its Implementation AC is checked the way a
 * maintainer reads it: by parsing the markdown, and by running the template
 * and the documented commands through the real modules. The PRD scenarios for
 * REQ-020 belong to TRD-033-TEST; this file covers only what TRD-033 owns:
 *
 *   - ADD walks the maintainer through the case record and the code-owner
 *     confirmation and writes `<evalCasesDir>/<id>.json`;
 *   - RUN runs the reviewer on each case, calls `eval-score` and
 *     `eval-compare` and reports regressions, with recurrence left to the
 *     host repository (Rule 4).
 */

const fs = require('fs');
const path = require('path');

const { validateCase, scoreEval, DEFAULT_EVAL_CASES_DIR } = require('../lib/pr-review-eval');
const { HANDLERS } = require('../lib/pr-review-cli');

const SKILL_DIR = path.join(__dirname, '..', 'skills', 'pr-review-eval');
const SKILL_PATH = path.join(SKILL_DIR, 'SKILL.md');
const TEMPLATE_PATH = path.join(SKILL_DIR, 'case-template.json');

describe('pr-review-eval SKILL.md', () => {
  const text = fs.readFileSync(SKILL_PATH, 'utf8');
  const flat = text.replace(/\s+/g, ' ');

  const sectionIndex = (label) => {
    const at = text.indexOf(label);
    expect([label, at > -1]).toEqual([label, true]);
    return at;
  };

  test('has frontmatter with the skill name and a when-to-use description', () => {
    const match = text.match(/^---\n([\s\S]*?)\n---\n/);
    expect(match).not.toBeNull();
    const frontmatter = match[1];
    expect(frontmatter).toContain('name: pr-review-eval');
    expect(frontmatter).toMatch(/description: .+/);
    expect(frontmatter).toContain('do not use');
  });

  test('AC-020-1: ADD records the change, the bug and where the bug lived', () => {
    const add = text.slice(sectionIndex('### Step A1 — Gather the case record'), sectionIndex('### Step A2'));
    for (const field of ['`id`', '`change`', '`bug`', '`location.path`', '`location.startLine`', '`confirmedBy`']) {
      expect([field, add.includes(field)]).toEqual([field, true]);
    }
    // The location is the bug's, as of the escaping change -- not the fix's.
    expect(add.replace(/\s+/g, ' ')).toContain('from the **escaping change**, not from the fix');
  });

  test('AC-020-1: the code-owner confirmation is checked against CODEOWNERS, not asserted', () => {
    const step = text.slice(sectionIndex('### Step A2'), sectionIndex('### Step A3'));
    const flatStep = step.replace(/\s+/g, ' ');
    expect(flatStep).toContain('$PR_REVIEW_CLI" paths');
    expect(flatStep).toContain('.paths[0].owners');
    // Each refusal the module can produce is named, so the skill and the
    // library cannot disagree about why a case was rejected.
    for (const reason of ['no-code-owner', 'confirmed-by-not-owner']) {
      expect([reason, flatStep.includes(reason)]).toEqual([reason, true]);
    }
    expect(flatStep).toContain('Never record a confirmation the owner did not give');
  });

  test('AC-020-1: the case is pinned to the rules file and hash it was confirmed against', () => {
    const step = text.slice(sectionIndex('### Step A3'), sectionIndex('### Step A4'));
    const flatStep = step.replace(/\s+/g, ' ');
    expect(flatStep).toContain('git hash-object');
    expect(flatStep).toContain('eval-stale');
    expect(flatStep).toContain('never record a hash you did not compute');
  });

  test('ADD writes <evalCasesDir>/<id>.json and names the refusals for writing it elsewhere', () => {
    const step = text.slice(sectionIndex('### Step A4'), sectionIndex('### Step A5'));
    expect(step).toContain('`<evalCasesDir>/<id>.json`');
    for (const reason of ['case-outside-eval-dir', 'case-filename-mismatch']) {
      expect([reason, step.includes(reason)]).toEqual([reason, true]);
    }
    expect(step).toContain('case-template.json');
  });

  test('evalCasesDir comes from the policy, with the library default when it cannot be read', () => {
    expect(flat).toContain('$PR_REVIEW_CLI" policy');
    expect(flat).toContain('.policy.evalCasesDir');
    expect(flat).toContain(DEFAULT_EVAL_CASES_DIR);
    expect(flat).toContain('a missing policy never means "put the case anywhere"');
  });

  test('a refused case writes no file at all', () => {
    expect(flat).toContain('**no file is written**');
    expect(flat).toContain('An unconfirmed case is not a case');
  });

  test('AC-020-2: RUN reviews each case fresh-context, without the case record', () => {
    const step = text.slice(sectionIndex('### Step R2'), sectionIndex('### Step R3'));
    const flatStep = step.replace(/\s+/g, ' ');
    expect(flatStep).toContain('fresh-context dispatch `pr-review-cycle` uses');
    expect(flatStep).toContain('never the incident report, the case record or this conversation');
    expect(flatStep).toContain('A reviewer told where the bug is proves nothing');
    expect(flatStep).toContain('findingsByCase');
  });

  test('AC-020-2: RUN scores, compares and reports regressions by name', () => {
    const step = text.slice(sectionIndex('### Step R3'), sectionIndex('### Step R4'));
    const flatStep = step.replace(/\s+/g, ' ');
    for (const subcommand of ['eval-score', 'eval-compare', 'eval-stale']) {
      expect([subcommand, flatStep.includes(subcommand)]).toEqual([subcommand, true]);
      expect([subcommand, Object.prototype.hasOwnProperty.call(HANDLERS, subcommand)]).toEqual([subcommand, true]);
    }
    expect(flatStep).toContain('`regression: true` with the `flipped` cases named');
    // "We could not compare" is never reported as "nothing got worse".
    expect(flatStep).toContain('never `regression: false`');
  });

  test('a regression is reported, never tuned away: the eval can still fail', () => {
    const step = text.slice(sectionIndex('### Step R3'), sectionIndex('### Step R4'));
    const flatStep = step.replace(/\s+/g, ' ');
    expect(flatStep).toContain('does not re-run the eval to get a better number');
    expect(flatStep).toContain('does not edit a case to match what the reviewer found');
  });

  test('a case that could not be reviewed is never counted as found or as missed', () => {
    const step = text.slice(sectionIndex('### Step R2'), sectionIndex('### Step R3'));
    expect(step.replace(/\s+/g, ' ')).toContain('do not invent a review');
    expect(flat).toContain('never counted as a case the reviewer missed, and never as one it found');
  });

  test('Rule 4: recurrence is left to the host repository -- no schedule is added here', () => {
    const step = text.slice(sectionIndex('### Step R4'), sectionIndex('## Reachability'));
    const flatStep = step.replace(/\s+/g, ' ');
    expect(flatStep).toContain('Do not add a schedule, a cron entry, a watcher');
    expect(flatStep).toContain('(Rule 4)');
    expect(flatStep).toContain('invokes this skill by name');
  });

  test('Rule 6: every capability is reached through the CLI, and no YAML caller names it', () => {
    const reach = text.slice(sectionIndex('## Reachability'));
    expect(reach).toContain('no YAML caller references the CLI');
    expect(reach).toContain('docs/guides/pr-review-metrics.md');
  });

  test('every pr-review-cli subcommand the skill names is a registered handler', () => {
    const named = new Set();
    for (const match of text.matchAll(/pr-review-cli(?:\.js)? ([a-z][a-z-]*)/g)) named.add(match[1]);
    expect(named.size).toBeGreaterThan(0);
    for (const name of named) {
      expect([name, Object.prototype.hasOwnProperty.call(HANDLERS, name)]).toEqual([name, true]);
    }
  });
});

describe('pr-review-eval case template', () => {
  const raw = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const template = JSON.parse(raw);

  test('is valid JSON with exactly the fields a case record carries', () => {
    expect(Object.keys(template).sort()).toEqual(
      ['bug', 'change', 'confirmedBy', 'id', 'location', 'rulesFile', 'rulesHash'].sort()
    );
    expect(Object.keys(template.location).sort()).toEqual(['endLine', 'path', 'startLine'].sort());
  });

  test('the empty template is NOT a valid case: every field must be filled in', () => {
    const result = validateCase({ case: template, codeowners: '* @owner' });
    expect(result.ok).toBe(false);
    const fields = result.errors.map((error) => error.field);
    for (const field of ['id', 'change', 'bug', 'confirmedBy', 'rulesFile', 'rulesHash', 'location']) {
      expect([field, fields.includes(field)]).toEqual([field, true]);
    }
  });

  test('filled in as the skill documents, it is a case the library accepts', () => {
    const filled = {
      ...template,
      id: '2026-10-auth-token-expiry',
      change: 'https://example.invalid/pull/1234',
      bug: 'Expiry compared in seconds against a millisecond timestamp.',
      location: { path: 'packages/development/lib/pr-review-approvals.js', startLine: 118, endLine: 131 },
      confirmedBy: 'ldangelo',
      rulesFile: 'REVIEW.md',
      rulesHash: '0'.repeat(40),
    };
    const result = validateCase({
      case: filled,
      codeowners: 'packages/development/lib/ @ldangelo',
      path: `${DEFAULT_EVAL_CASES_DIR}/2026-10-auth-token-expiry.json`,
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);

    // Step A5's verification, with the payload the documented jq builds:
    // findingsByCase keyed by the case's own id, with no findings recorded.
    const scored = scoreEval({ cases: [filled], findingsByCase: { [filled.id]: [] } });
    expect(scored.ok).toBe(true);
    expect(scored.cases[0].reason).toBe('no-important-finding-at-location');

    // And the distinction Step A5 tells the maintainer to act on: a key that
    // is not the case's id is `no-findings-recorded`, not a readable case.
    expect(scoreEval({ cases: [filled], findingsByCase: {} }).cases[0].reason).toBe('no-findings-recorded');
  });

  test('a case confirmed by someone who is not an owner of the path is refused', () => {
    const filled = {
      ...template,
      id: 'case-1',
      change: 'c0ffee',
      bug: 'A bug.',
      location: { path: 'packages/development/lib/pr-review-approvals.js', startLine: 1, endLine: 2 },
      confirmedBy: 'someone-else',
      rulesFile: 'REVIEW.md',
      rulesHash: '0'.repeat(40),
    };
    const result = validateCase({ case: filled, codeowners: 'packages/development/lib/ @ldangelo' });
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({ field: 'confirmedBy', reason: 'confirmed-by-not-owner' });
  });
});
