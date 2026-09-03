'use strict';

const fs = require('fs');
const path = require('path');

const commandPath = path.join(__dirname, '../commands/analyze-complexity.yaml');
const featurePath = path.join(__dirname, '../commands/feature.yaml');

describe('analyze-complexity command source', () => {
  let text;

  beforeAll(() => {
    text = fs.readFileSync(commandPath, 'utf8');
  });

  test('requires score, rationale, and path output before downstream planning', () => {
    expect(text).toContain('Score: <score>/10');
    expect(text).toContain('Depth: <Simple|Medium|Complex>');
    expect(text).toContain('Path: <fix-issue OR create-prd -> create-trd OR create-prd -> refine-prd -> create-trd -> refine-trd>');
    expect(text).toContain('Rationale: <factor-level scope, dependencies, risk, teamSize evidence>');
    expect(text).toContain('before any downstream planning command begins');
  });

  test('halts on empty input before selecting a path', () => {
    expect(text).toContain('Work description is required before complexity analysis can select a planning path.');
    expect(text).toContain('HALT without selecting a path');
  });

  test('documents override flags and Foreman non-prompt behavior', () => {
    expect(text).toContain('--depth simple|medium|complex');
    expect(text).toContain('--no-auto-complexity');
    expect(text).toContain('--foreman');
    expect(text).toContain('per-invocation override');
    expect(text).toContain('takes precedence over global config');
    expect(text).toContain('Foreman mode is non-interactive; never ask_user or prompt');
  });

  test('requires exact Foreman artifact path report contract', () => {
    expect(text).toContain('FOREMAN_ARTIFACT_PATH is set and non-empty');
    expect(text).toContain('write the phase report to that exact path');
    expect(text).toContain('Never invent, alter, or relocate the path');
    expect(text).toContain('Never treat an unset FOREMAN_ARTIFACT_PATH as an error');
    expect(text).toContain('override state');
    expect(text).toContain('disable state');
    expect(text).toContain('uncertainty');
  });

  test('maps all score bands and includes Complex implementation block', () => {
    expect(text).toContain('Scores 1, 2, or 3 -> Simple -> fix-issue path.');
    expect(text).toContain('Scores 4, 5, or 6 -> Medium -> create-prd -> create-trd path.');
    expect(text).toContain('Scores 7, 8, 9, or 10 -> Complex -> create-prd -> refine-prd -> create-trd -> refine-trd path.');
    expect(text).toContain('Implementation remains blocked until the refined TRD receives explicit approval.');
  });
});

describe('adaptive feature entrypoint integration', () => {
  let text;

  beforeAll(() => {
    text = fs.readFileSync(featurePath, 'utf8');
  });

  test('runs adaptive classification before route selection', () => {
    expect(text).toContain('Adaptive Complexity Gate');
    expect(text).toContain('Analyze complexity before route selection');
    expect(text).toContain('Print score/rationale/path before planning begins');
    expect(text.indexOf('Adaptive Complexity Gate')).toBeLessThan(text.indexOf('Pipeline Execution'));
  });

  test('preserves explicit manual commands and only adaptive path requires classification', () => {
    expect(text).toContain('Direct invocations of /ensemble:fix-issue, /ensemble:create-prd, /ensemble:create-trd, and /ensemble:refine-trd remain unchanged');
    expect(text).toContain('only this adaptive entrypoint requires pre-planning classification');
  });

  test('documents Medium and Complex route handoff details', () => {
    expect(text).toContain('Medium: run create-prd then create-trd.');
    expect(text).toContain('Complex: run the full existing five-step pipeline.');
    expect(text).toContain('Implementation remains blocked until the refined TRD receives explicit approval.');
  });

  test('includes PRD regression fixture route semantics', () => {
    expect(text).toContain('Simple: print the recommended manual path `/ensemble:fix-issue <FEATURE_DESCRIPTION>`');
    expect(text).toContain('Scores 1-3 select the');
    expect(text).toContain('scores 7-10 run the');
  });
});
