'use strict';

const fs = require('fs');
const path = require('path');

describe('create-trd command document ids', () => {
  test('reuses source PRD micro UUID instead of allocating a new sequence', () => {
    const text = fs.readFileSync(path.join(__dirname, '../commands/create-trd.yaml'), 'utf8');
    expect(text).toContain('Derive the TRD document micro UUID from the source PRD');
    expect(text).toContain('PRD-YYYY-<micro_uuid>');
    expect(text).toContain('TRD_MICRO_UUID');
    expect(text).toContain('docs/TRD/TRD-YYYY-<TRD_MICRO_UUID>-<slug>.md');
    expect(text).toContain('Do NOT scan for highest TRD sequence number');
    expect(text).not.toContain('TRD-YYYY-NNN-<slug>.md');
  });

  test('requires the checkbox prefix in Master Task List Generation, unconditionally and outside MCP Enhancement', () => {
    const text = fs.readFileSync(path.join(__dirname, '../commands/create-trd.yaml'), 'utf8');
    const distinguishing = 'Every task line MUST begin with a GitHub checkbox';
    expect(text).toContain(distinguishing);

    // Scoped to the Master Task List Generation step's own action list.
    const masterTaskListStart = text.indexOf('title: Master Task List Generation');
    const testTaskGenStart = text.indexOf('title: Test Task Generation');
    expect(masterTaskListStart).toBeGreaterThan(-1);
    expect(testTaskGenStart).toBeGreaterThan(masterTaskListStart);
    expect(text.slice(masterTaskListStart, testTaskGenStart)).toContain(distinguishing);

    // Not merely present inside the optional, MCP-gated phase.
    const mcpPhaseStart = text.indexOf('name: MCP Enhancement (Optional)');
    expect(mcpPhaseStart).toBeGreaterThan(-1);
    const nextPhaseStart = text.indexOf('- name:', mcpPhaseStart + 1);
    expect(nextPhaseStart).toBeGreaterThan(mcpPhaseStart);
    expect(text.slice(mcpPhaseStart, nextPhaseStart)).not.toContain(distinguishing);
  });

  test('requires the identical checkbox prefix in Test Task Generation for TRD-NNN-TEST lines', () => {
    const text = fs.readFileSync(path.join(__dirname, '../commands/create-trd.yaml'), 'utf8');
    const distinguishing =
      'Every TRD-NNN-TEST line MUST begin with the same checkbox-prefix requirement as implementation tasks';
    expect(text).toContain(distinguishing);

    // Scoped to the Test Task Generation step's own action list.
    const testTaskGenStart = text.indexOf('title: Test Task Generation');
    const nextStepStart = text.indexOf('title: Dependency Mapping and PR Boundary Design');
    expect(testTaskGenStart).toBeGreaterThan(-1);
    expect(nextStepStart).toBeGreaterThan(testTaskGenStart);
    expect(text.slice(testTaskGenStart, nextStepStart)).toContain(distinguishing);
  });

  test('Task Coverage Analysis self-checks the draft Master Task List via trd-cli.js parse', () => {
    const text = fs.readFileSync(path.join(__dirname, '../commands/create-trd.yaml'), 'utf8');
    const trdCliResolution =
      'Resolve TRD_CLI per the tool-path-resolution skill (packages/development/skills/tool-path-resolution/SKILL.md) for packages/development/lib/trd-cli.js';
    // YAML double-quoted scalar escapes embedded quotes as \" in the raw
    // source text — match the literal bytes on disk, not the unescaped value.
    const parseInvocation = 'node \\"$TRD_CLI\\" parse';

    // Scoped to the Task Coverage Analysis step's own action list.
    const taskCoverageStart = text.indexOf('title: Task Coverage Analysis');
    const nextStepStart = text.indexOf('title: Dependency and Estimate Review');
    expect(taskCoverageStart).toBeGreaterThan(-1);
    expect(nextStepStart).toBeGreaterThan(taskCoverageStart);
    const scoped = text.slice(taskCoverageStart, nextStepStart);
    expect(scoped).toContain(trdCliResolution);
    expect(scoped).toContain(parseInvocation);
  });
});
