const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { readDevelopmentSkill, parseParameters } = require('./helpers/skill-workflow');

// implement-trd-tasks drives the engine (TRD-021): the skill is a loop over `ensemble implement next`.
// What it used to pin as prose now lives in verbs, each proved against a real repository by its own
// engine test, not by wording in the skill:
//   preflight, argument conflicts, --generate-only guards  engine-implement-args, -env, -resume tests
//   scaffold and labels                                     engine-implement-scaffold, -bead-health tests
//   delegation to beads-build, bead references              engine-implement-delegate test
//   quality gate, PR and PR backends                        engine-implement-gate, -pr tests
//   completion ordering, fail-closed closure                engine-implement-close test
// What stays pinned here is the command's own surface: its manifest, its arguments, and the
// reference-skill contracts the model still needs (workstream mode, foreman, kata).

const YAML_PATH = path.join(__dirname, '../commands/implement-trd-tasks.yaml');
const REF_PATH = path.join(__dirname, '../skills/implement-trd-tasks-reference/SKILL.md');
const manifest = yaml.load(fs.readFileSync(YAML_PATH, 'utf8'));
const skill = readDevelopmentSkill(manifest.skill);
const text = skill.prompt;
// The reference skill's companion files (reference/*.md) hold detail moved out of the budgeted SKILL.md.
const REF_DIR = path.join(path.dirname(REF_PATH), 'reference');
const ref = [REF_PATH, ...fs.readdirSync(REF_DIR).sort().map((f) => path.join(REF_DIR, f))]
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');
// The `## Expected Output` bullets of SKILL.md: `- **<name>**: <description>`.
const expectedOutputSection = skill.body.slice(skill.body.indexOf('\n## Expected Output\n'), skill.body.indexOf('\n## Expected Input\n'));
const doc = {
  metadata: manifest.metadata,
  parameters: parseParameters(skill.body),
  expectedOutput: {
    structure: [...expectedOutputSection.matchAll(/^- \*\*(.+?)\*\*:/gm)].map((m) => ({ name: m[1] })),
  },
};

describe('implement-trd-tasks command surface', () => {
  test('argument_hint advertises the branch-intent flags callers use', () => {
    for (const flag of ['--branch=<name>', '--use-current-branch', '--plan', '--execute', '--foreman']) {
      expect(doc.metadata.argument_hint).toContain(flag);
    }
  });

  test('--workstream and --generate-only are advertised in argument_hint and parameters', () => {
    expect(doc.metadata.argument_hint).toContain('--workstream [--generate-only [--out <path>] [--allow-invalid]]');
    expect(doc.parameters.map((p) => p.name)).toEqual(expect.arrayContaining(['workstream', 'generate-only']));
  });

  test('expectedOutput lists the workstream TRD artifact', () => {
    expect(doc.expectedOutput.structure.map((o) => o.name)).toContain('Workstream TRD (--workstream --generate-only)');
  });

  test('generated-TRD contract and filename scheme live in the reference skill', () => {
    for (const k of ['Source TRD Manifest', 'normalized Master Task List', 'verbatim source task markdown', 'TRD-YYYY-<8hex>-workstream-<slug>.md']) {
      expect(ref).toContain(k);
    }
  });

  test('foreman parameter is a boolean defaulting to false', () => {
    const p = doc.parameters.find((x) => x.name === 'foreman');
    expect(p.type).toBe('boolean');
    expect(p.default).toBe(false);
    expect(text).toContain('FOREMAN_ARTIFACT_PATH');
  });

  test('the prompt stays thin', () => {
    expect(text).not.toContain('executionContract');
    expect(text.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(2500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runChoicesRead / runChoicesWrite — trd-cli.js unit tests
// ─────────────────────────────────────────────────────────────────────────────
const { runChoicesRead, runChoicesWrite } = require('../lib/trd-cli.js');
const os = require('os');

describe('runChoicesRead / runChoicesWrite', () => {
  const trdWithFrontmatter = [
    '---',
    'title: Test TRD',
    'ensemble_implement_trd_beads:',
    '  branch_name: feature/previous-branch',
    '  use_proposed: true',
    '  stacked_prs: false',
    '---',
    '',
    '# Test content',
    '',
  ].join('\n');

  const trdNoBlock = [
    '---',
    'title: Test TRD',
    '---',
    '',
    '# Test content',
    '',
  ].join('\n');

  test('read: returns empty choices when no ensemble_implement_trd_beads block exists', () => {
    const tmp = path.join(os.tmpdir(), `trd-no-block-${Date.now()}.md`);
    fs.writeFileSync(tmp, trdNoBlock);
    try {
      const result = runChoicesRead([tmp]);
      expect(result.ok).toBe(true);
      expect(result.choices.branch_name).toBe('');
      expect(result.choices.use_proposed).toBe(false);
      expect(result.choices.stacked_prs).toBe(false);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('read: parses existing block correctly', () => {
    const tmp = path.join(os.tmpdir(), `trd-with-block-${Date.now()}.md`);
    fs.writeFileSync(tmp, trdWithFrontmatter);
    try {
      const result = runChoicesRead([tmp]);
      expect(result.ok).toBe(true);
      expect(result.choices.branch_name).toBe('feature/previous-branch');
      expect(result.choices.use_proposed).toBe(true);
      expect(result.choices.stacked_prs).toBe(false);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('write: creates block when none exists', () => {
    const tmp = path.join(os.tmpdir(), `trd-write-new-${Date.now()}.md`);
    fs.writeFileSync(tmp, trdNoBlock);
    try {
      const result = runChoicesWrite([tmp, '--branch-name', 'feature/new-branch', '--use-proposed', '--stacked-prs']);
      expect(result.ok).toBe(true);
      const written = fs.readFileSync(tmp, 'utf8');
      expect(written).toMatch(/^ensemble_implement_trd_beads:/m);
      expect(written).toMatch(/^ {2}branch_name: feature\/new-branch$/m);
      expect(written).toMatch(/^ {2}use_proposed: true$/m);
      expect(written).toMatch(/^ {2}stacked_prs: true$/m);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('write: replaces existing block — top-level key (not indented), boolean flags truthy', () => {
    const tmp = path.join(os.tmpdir(), `trd-write-replace-${Date.now()}.md`);
    fs.writeFileSync(tmp, trdWithFrontmatter);
    try {
      runChoicesWrite([tmp, '--branch-name', 'feature/replaced', '--use-proposed']);
      const written = fs.readFileSync(tmp, 'utf8');
      // Top-level key check (not indented with 2 spaces)
      expect(written).toMatch(/^ensemble_implement_trd_beads:/m);
      // Previous values gone
      expect(written).not.toMatch(/^ {2}branch_name: feature\/previous-branch$/m);
      expect(written).toMatch(/^ {2}branch_name: feature\/replaced$/m);
      expect(written).toMatch(/^ {2}use_proposed: true$/m);
      expect(written).toMatch(/^ {2}stacked_prs: false$/m); // was false, not toggled
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('write + read: round-trip with space-separated --branch-name flag', () => {
    const tmp = path.join(os.tmpdir(), `trd-roundtrip-${Date.now()}.md`);
    fs.writeFileSync(tmp, trdNoBlock);
    try {
      const writeResult = runChoicesWrite([tmp, '--branch-name', 'feature/roundtrip', '--stacked-prs']);
      expect(writeResult.ok).toBe(true);
      const readResult = runChoicesRead([tmp]);
      expect(readResult.ok).toBe(true);
      expect(readResult.choices.branch_name).toBe('feature/roundtrip');
      expect(readResult.choices.use_proposed).toBe(false);
      expect(readResult.choices.stacked_prs).toBe(true);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('read: branch_name outside the ensemble_implement_trd_beads block is NOT parsed (block is authoritative)', () => {
    // TRD has branch_name both inside AND outside the choices block
    const text = [
      '---',
      'title: Test TRD',
      'ensemble_implement_trd_beads:',
      '  branch_name: feature/saved-choice',
      '  use_proposed: true',
      '  stacked_prs: false',
      'owner: alice',
      'branch_name: feature/outside-block',
      '---',
      '',
      '# Test content',
      '',
    ].join('\n');
    const tmp = path.join(os.tmpdir(), `trd-outside-block-${Date.now()}.md`);
    fs.writeFileSync(tmp, text);
    try {
      const result = runChoicesRead([tmp]);
      expect(result.ok).toBe(true);
      // Must read from inside the block, NOT from the top-level branch_name
      expect(result.choices.branch_name).toBe('feature/saved-choice');
      expect(result.choices.use_proposed).toBe(true);
      expect(result.choices.stacked_prs).toBe(false);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
