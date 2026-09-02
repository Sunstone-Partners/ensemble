'use strict';

const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, '../commands/create-trd.yaml');
const generatedPath = path.join(__dirname, '../commands/ensemble/create-trd.md');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function contractSection(text) {
  const outputStart = text.indexOf('Output Management');
  expect(outputStart).toBeGreaterThan(-1);
  const start = text.lastIndexOf('Constitution Gate Contract', outputStart);
  expect(start).toBeGreaterThan(-1);
  return text.slice(start, outputStart);
}

function unguardedConstitutionBypassLines(section) {
  const bypassWords = /(proceed anyway|override|skip|auto-proceed|default-proceed)/i;
  const constitutionScope = /(constitution|article)/i;
  const explicitDeny = /(Do not offer|excluded|cannot bypass|non-bypassable|only for non-constitution|preserved only)/i;
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => constitutionScope.test(line) && bypassWords.test(line) && !explicitDeny.test(line));
}

describe('create-trd command document ids', () => {
  test('reuses source PRD micro UUID instead of allocating a new sequence', () => {
    const text = read(sourcePath);
    expect(text).toContain('Derive the TRD document micro UUID from the source PRD');
    expect(text).toContain('PRD-YYYY-<micro_uuid>');
    expect(text).toContain('TRD_MICRO_UUID');
    expect(text).toContain('docs/TRD/TRD-YYYY-<TRD_MICRO_UUID>-<slug>.md');
    expect(text).toContain('Do NOT scan for highest TRD sequence number');
    expect(text).not.toContain('TRD-YYYY-NNN-<slug>.md');
  });

  test('requires the checkbox prefix in Master Task List Generation, unconditionally and outside MCP Enhancement', () => {
    const text = read(sourcePath);
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
    const text = read(sourcePath);
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
    const text = read(sourcePath);
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

describe('create-trd constitution gate contract', () => {
  test.each([
    ['source YAML', sourcePath],
    ['generated command markdown', generatedPath],
  ])('%s pins source precedence, config errors, and non-bypassable semantics', (_label, filePath) => {
    const text = read(filePath);
    const contract = contractSection(text);

    expect(contract).toContain('docs/standards/constitution.md');
    expect(contract).toContain('.specify/memory/constitution.md');
    expect(contract).toContain('strict precedence');
    expect(contract).toContain('normalized contents differ');
    expect(contract).toContain('CONSTITUTION_CONFIG_ERROR');
    expect(contract).toContain('Every enforceable constitution check MUST map to at least one source article id');
    expect(contract).toContain('unmapped article check is a gate configuration failure');
    expect(contract).toContain('Constitution violations are non-bypassable in every mode, including --foreman');
    expect(contract).toContain('Do not offer any proceed anyway, override, skip, soft-confirmation, default-proceed, or Foreman auto-proceed path');
    expect(unguardedConstitutionBypassLines(contract)).toEqual([]);
  });

  test.each([
    ['source YAML', sourcePath],
    ['generated command markdown', generatedPath],
  ])('%s requires article-specific violation formatting', (_label, filePath) => {
    const contract = contractSection(read(filePath));

    expect(contract).toContain('article id');
    expect(contract).toContain('article title when available');
    expect(contract).toContain('failing draft section');
    expect(contract).toContain('specific finding');
    expect(contract).toContain('remediation hint');
    expect(contract).toContain('list every failing article id');
    expect(contract).toContain('never collapse them to a generic constitution failure');
  });

  test.each([
    ['source YAML', sourcePath],
    ['generated command markdown', generatedPath],
  ])('%s hard-blocks TRD save and implementation next steps on violation', (_label, filePath) => {
    const contract = contractSection(read(filePath));

    expect(contract).toContain('before creating docs/TRD/');
    expect(contract).toContain('writing any repo-local TRD artifact');
    expect(contract).toContain('printing /ensemble:configure-team or /ensemble:implement-trd-beads next steps');
    expect(contract).toContain('do not write docs/TRD/TRD-YYYY-<TRD_MICRO_UUID>-<slug>.md');
    expect(contract).toContain('do not print /ensemble:configure-team or /ensemble:implement-trd-beads next-step output');
  });

  test.each([
    ['source YAML', sourcePath],
    ['generated command markdown', generatedPath],
  ])('%s records Foreman failure reports separately from successful artifacts', (_label, filePath) => {
    const contract = contractSection(read(filePath));

    expect(contract).toContain('FOREMAN_ARTIFACT_PATH');
    expect(contract).toContain('write a failure phase report to that exact path');
    expect(contract).toContain('creating parent directories as needed');
    expect(contract).toContain('must not claim a saved repo-local TRD artifact');
  });

  test.each([
    ['source YAML', sourcePath],
    ['generated command markdown', generatedPath],
  ])('%s preserves non-constitution CONCERNS auto-proceed only after constitution pass', (_label, filePath) => {
    const text = read(filePath);
    const contract = contractSection(text);

    expect(text).toContain('CONCERNS-band');
    expect(contract).toContain('preserved only for non-constitution concerns and only when constitution compliance passes');
    expect(contract).toContain('constitution violations are excluded from CONCERNS auto-proceed');
  });

  test.each([
    ['source YAML', sourcePath],
    ['generated command markdown', generatedPath],
  ])('%s adds the saved-document success audit status', (_label, filePath) => {
    const text = read(filePath);

    expect(text).toContain('Constitution compliance: passed');
    expect(text).toContain('only after constitution compliance passes');
  });
});
