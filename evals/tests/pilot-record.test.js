'use strict';

/**
 * TRD-028-TEST (Claude half): the committed baselines support an expand decision for each pilot skill, and the guide's pilot
 * record states wall-clock time and cost against the 60 minute target and the cap. The Pi half is open until Pi is run.
 */

const fs = require('fs');
const path = require('path');
const results = require('../lib/results');
const { loadEvalDefs } = require('../lib/eval-def');

const REPO_ROOT = path.resolve(__dirname, '../..');
const PILOTS = ['ensemble-create-prd', 'ensemble-refine-prd', 'ensemble-create-trd', 'pr-merge-trace'];
const GUIDE = () => fs.readFileSync(path.join(REPO_ROOT, 'docs/guides/skills-eval.md'), 'utf8');

describe('TRD-028-TEST: pilot results record (Claude)', () => {
  test.each(PILOTS)('%s: a committed Claude baseline shows uplift and reliability, on one reported model', (skill) => {
    const file = path.join(REPO_ROOT, 'evals/baselines/claude', `${skill}.json`);
    expect(fs.existsSync(file)).toBe(true);
    const b = results.readBaseline(file); // strict: contradictory numbers, a symlink or a wrong path throw
    expect(b.runtime).toBe('claude');
    expect(b.model).not.toBe(results.UNKNOWN_MODEL);
    expect(b.repeats).toBe(5);
    expect(typeof b.uplift).toBe('number');
    expect(typeof b.reliable).toBe('boolean');
    expect(b.withSkill.runs).toBe(5);
    expect(b.baseline.runs).toBe(5);
  });

  test('all four pilots were measured on the same model, so their numbers are comparable', () => {
    const models = PILOTS.map((s) => results.readBaseline(path.join(REPO_ROOT, 'evals/baselines/claude', `${s}.json`)).model);
    expect(new Set(models).size).toBe(1);
  });

  test('the committed baselines belong to evals that still load, with their hashes current', () => {
    const defs = loadEvalDefs().evals;
    for (const s of PILOTS) expect(defs.find((e) => e.id === s)).toBeDefined();
  });

  test('timing recorded against the target: the guide states wall-clock time and cost, each compared to 60 minutes and the cap', () => {
    const g = GUIDE();
    const i = g.indexOf('### Pilot record (TRD-028, Claude half)');
    expect(i).toBeGreaterThan(-1);
    const record = g.slice(i);
    expect(record).toMatch(/Wall-clock time for the pilot runs was \d+ minutes/);
    expect(record).toMatch(/60-minute target/);
    expect(record).toMatch(/\$\d+\.\d\d/);
    expect(record).toMatch(/\$50 cap/);
    expect(record).toMatch(/\*\*Pi has not been run\*\*/);
  });
});
