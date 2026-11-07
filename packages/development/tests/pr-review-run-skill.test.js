'use strict';

/**
 * Light-mode runner (kata znd1), consumer-visible contract in the prose: SKILL.md names the
 * CLI, both subcommands, every status the model must handle and the NEEDS_FULL_MODE fallback
 * to the narrated procedure, and points at the reference that holds the detail.
 */

const fs = require('fs');
const path = require('path');
const { readSkillMain, readSkillReference, SKILL_DIR } = require('./helpers/pr-review-cycle-skill');

const STATUSES = ['DISPATCH', 'PENDING', 'DONE', 'ADJUDICATE', 'NEEDS_FULL_MODE', 'RUN_INVALIDATED', 'RUN_FAILED'];

describe('pr-review-cycle light-mode runner prose', () => {
  const main = readSkillMain();

  test('SKILL.md names the CLI, both subcommands and the reference', () => {
    expect(main).toContain('review-run-cli.js');
    expect(main).toMatch(/`prepare`/);
    expect(main).toMatch(/`collect`/);
    expect(main).toContain('reference/review-run.md');
    expect(fs.existsSync(path.join(SKILL_DIR, 'reference', 'review-run.md'))).toBe(true);
  });

  test('the reference tells the model what to do and what never to do', () => {
    const ref = readSkillReference('review-run.md').replace(/\s+/g, ' ');
    expect(ref).toMatch(/start exactly the agents in `agents\[\]`/);
    expect(ref).toMatch(/`prompt` UNEDITED/);
    expect(ref).toContain('maxConcurrentAgents');
    expect(ref).toContain('deadlineAtIso');
    expect(ref).toMatch(/composes no brief, computes no vote, sets no status/);
    expect(ref).toMatch(/Decide ONLY the items in `adjudicate\[\]`/);
  });

  test('SKILL.md falls back to the narrated Steps 1-10 on NEEDS_FULL_MODE', () => {
    expect(main).toMatch(/`NEEDS_FULL_MODE`[^.]*narrated Steps 1-10/);
    expect(main).toContain('### Step 1 -- Resolve scope');
    expect(main).toContain('### Step 10');
  });

  test('the reference handles every status and the fallback', () => {
    const ref = readSkillReference('review-run.md');
    for (const s of STATUSES) expect(ref).toContain('`' + s + '`');
    expect(ref).toMatch(/NEEDS_FULL_MODE[\s\S]*narrated Steps 1-10/);
    expect(ref).toMatch(/cannot start model agents/);
    expect(ref).toMatch(/cannot stop an agent/);
    expect(ref).toContain('adjudications');
  });
});
