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

  test('classifies companion artifact domains with no-op guards', () => {
    const text = fs.readFileSync(path.join(__dirname, '../commands/create-trd.yaml'), 'utf8');
    const domainStart = text.indexOf('title: Domain Analysis');
    const nextStepStart = text.indexOf('title: Capability Reuse Check');
    expect(domainStart).toBeGreaterThan(-1);
    expect(nextStepStart).toBeGreaterThan(domainStart);
    const scoped = text.slice(domainStart, nextStepStart);

    expect(scoped).toContain('COMPANION_DOMAINS');
    expect(scoped).toContain('add `data-model` when requirements mention persistence changes');
    expect(scoped).toContain('entities, schemas, database tables, migrations, backfills');
    expect(scoped).toContain('Do NOT add `data-model` for incidental data mentions');
    expect(scoped).toContain('read-only display data');
    expect(scoped).toContain('Add `research` when requirements require comparative technology decisions');
    expect(scoped).toContain('vendor/tool selection');
    expect(scoped).toContain('Do NOT add `research` for routine brownfield architecture description');
  });

  test('derives deterministic companion artifact paths without placeholders', () => {
    const text = fs.readFileSync(path.join(__dirname, '../commands/create-trd.yaml'), 'utf8');
    const generationStart = text.indexOf('title: TRD Document Generation');
    const traceabilityStart = text.indexOf('title: Acceptance Criteria Traceability');
    expect(generationStart).toBeGreaterThan(-1);
    expect(traceabilityStart).toBeGreaterThan(generationStart);
    const scoped = text.slice(generationStart, traceabilityStart);

    expect(scoped).toContain('reuse the same TRD_MICRO_UUID and slug');
    expect(scoped).toContain('append only `-research.md` and/or `-data-model.md` suffixes');
    expect(scoped).toContain('TRD-2026-d63594c0-standalone-trd-artifacts-research.md');
    expect(scoped).toContain('TRD-2026-d63594c0-standalone-trd-artifacts-data-model.md');
    expect(scoped).toContain('Stable rerun rule');
    expect(scoped).toContain('do not create stale placeholder artifacts');
  });

  test('requires standalone data-model companion template and traceability fields', () => {
    const text = fs.readFileSync(path.join(__dirname, '../commands/create-trd.yaml'), 'utf8');
    expect(text).toContain('If `data-model` is detected');
    expect(text).toContain('generated-artifact note');
    expect(text).toContain('source TRD id');
    expect(text).toContain('source PRD id');
    expect(text).toContain('relative TRD back-link');
    expect(text).toContain('relevant REQ/AC refs');
    for (const section of [
      'Overview',
      'Entities',
      'Relationships',
      'Data Ownership',
      'Migration/Backfill Notes',
      'Validation Rules',
      'Privacy/Security Notes',
      'Open Questions',
    ]) {
      expect(text).toContain(section);
    }
    expect(text).toContain('[NEEDS CLARIFICATION: specify the missing data-model detail and source REQ/AC]');
  });

  test('requires standalone research companion template and separation from TRD architecture', () => {
    const text = fs.readFileSync(path.join(__dirname, '../commands/create-trd.yaml'), 'utf8');
    expect(text).toContain('If `research` is detected');
    for (const section of [
      'Decision Context',
      'Options Considered',
      'Evaluation Criteria',
      'Recommendation',
      'Tradeoffs/Risks',
      'Rejected Alternatives',
      'Open Questions',
    ]) {
      expect(text).toContain(section);
    }
    expect(text).toContain('links back to the TRD Architecture Decision');
    expect(text).toContain('must not replace, fork, or contradict');
    expect(text).toContain('[NEEDS CLARIFICATION: specify the missing research/detail and source REQ/AC]');
  });

  test('requires conditional companion links and Foreman reporting', () => {
    const text = fs.readFileSync(path.join(__dirname, '../commands/create-trd.yaml'), 'utf8');
    expect(text).toContain('## Companion Artifacts');
    expect(text).toContain('relative links only to files actually generated');
    expect(text).toContain('No companion artifacts generated.');
    expect(text).toContain('Companion artifacts generated:');
    expect(text).toContain('phase report written to that exact path must list the TRD path and every generated companion artifact path');
    expect(text).toContain('Preserve the existing FOREMAN_ARTIFACT_PATH write contract exactly');
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
