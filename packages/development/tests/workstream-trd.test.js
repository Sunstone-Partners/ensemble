'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCreateWorkstreamTrd } = require('../lib/trd-cli');
const { nextWorkstreamPath } = require('../lib/workstream-trd');
const { parseTRD } = require('../lib/trd-parser');

function trd(title, n, ac) {
  return `---\ndesign_readiness_score: 4.5\nstatus: Draft\n---\n# ${title}\n\nSummary.\n\nBased on PRD: docs/PRD/PRD-2026-00${n}.md\n\n## Master Task List\n\n### PR 1: Feature\n\n**Shippable State:** Done.\n\n- [ ] **TRD-001**: Implement thing [satisfies REQ-001]\n  - Validates PRD ACs: ${ac}\n  - Actions:\n    1. Build it\n    2. Preserve nuanced source detail\n  - Implementation Notes:\n    - Use the existing service boundary\n    - Do not flatten this note away\n`;
}

describe('create-workstream-trd', () => {
  test('writes a single executable workstream TRD with provenance and AC validation tasks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workstream-trd-'));
    const a = path.join(dir, 'TRD-2026-001-alpha.md');
    const b = path.join(dir, 'TRD-2026-002-beta.md');
    const out = path.join(dir, 'workstream.md');
    fs.writeFileSync(a, trd('Alpha', 1, 'AC-001-1'));
    fs.writeFileSync(b, trd('Beta', 2, 'AC-002-1'));
    const result = runCreateWorkstreamTrd([a, b, '--out', out]);
    expect(result.ok).toBe(true);
    expect(result.path).toBe(out);
    const md = fs.readFileSync(out, 'utf8');
    expect(md).toContain('## Source TRD Manifest');
    expect(md).toContain('Source TRD: ' + a);
    expect(md).toContain('Source AC: AC-001-1');
    expect(md).toContain('**TRD-S01-001**');
    expect(md).toContain('**TRD-S01-AC-001-1-IMPL**');
    expect(md).toContain('**TRD-S01-AC-001-1-TEST**');
    expect(md).toContain('**TRD-S01-AC-001-1**');
    expect(md).toContain('Implement AC-001-1 from');
    expect(md).toContain('Add executable tests for AC-001-1');
    expect(md).toContain('Validate AC-001-1 implementation and tests');
    expect(md).toContain('Validation AC:');
    expect(md).toContain('ac-validation:AC-001-1');
    expect(md).toContain('Source Task Markdown (verbatim):');
    expect(md).toContain('>     2. Preserve nuanced source detail');
    expect(md).toContain('>     - Do not flatten this note away');
    expect(md).toContain('/ensemble:implement-trd-beads');

    const parsed = parseTRD(md);
    expect(Object.keys(parsed.tasksById)).toEqual(expect.arrayContaining([
      'TRD-S01-001',
      'TRD-S01-AC-001-1-IMPL',
      'TRD-S01-AC-001-1-TEST',
      'TRD-S01-AC-001-1',
    ]));
    expect(parsed.warnings).not.toContain('Duplicate task id: TRD-001');
  });

  test('default workstream path uses micro UUID instead of sequence number', () => {
    const out = nextWorkstreamPath('docs/TRD/workstreams', 2026, 'alpha-beta', 'a1b2c3d4');
    expect(out).toBe('docs/TRD/workstreams/TRD-2026-a1b2c3d4-workstream-alpha-beta.md');
    expect(out).not.toMatch(/TRD-2026-\d{3}-workstream/);
  });
});
