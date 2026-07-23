'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parsePRD } = require('../lib/prd-parser');
const { hashAc } = require('../lib/feature-gen');
const {
  renderSpec,
  buildArtifacts,
  writeArtifacts,
} = require('../lib/playwright-gen');

const SAMPLE = fs.readFileSync(
  path.join(__dirname, 'fixtures/PRD-sample.md'),
  'utf8'
);
const prd = parsePRD(SAMPLE);

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pw-test-'));
}

describe('renderSpec', () => {
  const req = prd.reqs[0];
  const text = renderSpec(prd, req);

  test('emits a describe block named for the requirement', () => {
    expect(text).toContain("test.describe('REQ-001: User Authentication'");
    expect(text).toContain("import { test } from '@playwright/test';");
  });

  test('emits a tagged, hashed test per AC with Given/When/Then as test.step calls', () => {
    expect(text).toContain('@AC-001-1');
    expect(text).toMatch(/@hash:[0-9a-f]{12}/);
    expect(text).toContain("test('AC-001-1'");
    expect(text).toContain("test.step('Given a user with valid credentials'");
    expect(text).toContain("test.step('When they submit the login form'");
    expect(text).toContain("test.step('Then they are authenticated and see the dashboard'");
  });

  test('every generated test starts as test.fixme', () => {
    const matches = text.match(/test\.fixme\(true,/g) || [];
    expect(matches.length).toBe(req.acs.length);
  });

  test('marks needs-clarification ACs without dropping them, and skips test.step', () => {
    const reqText = renderSpec(prd, prd.reqs[1]);
    expect(reqText).toContain('@needs-clarification');
    expect(reqText).toContain('NEEDS CLARIFICATION');
    expect(reqText).toContain('AC-002-2');
    // free-form AC keeps no Given/When/Then steps
    const acBlock = reqText.slice(reqText.indexOf("'AC-002-2'"));
    expect(acBlock.slice(0, acBlock.indexOf('});'))).not.toContain('test.step(');
  });
});

describe('buildArtifacts + manifest', () => {
  const artifacts = buildArtifacts(prd, 'PRD-sample');

  test('produces one spec file per requirement plus a manifest', () => {
    const names = artifacts.files.map((f) => f.relPath).sort();
    expect(names).toEqual(['REQ-001.spec.ts', 'REQ-002.spec.ts']);
    expect(artifacts.manifest.prd.document_id).toBe('PRD-2026-a1b2c3d4');
    expect(artifacts.manifest.prd.label).toBe('prd-sample-feature');
  });

  test('manifest maps every AC to req, hash, file and clarification flag', () => {
    const m = artifacts.manifest.acs;
    expect(Object.keys(m).sort()).toEqual([
      'AC-001-1',
      'AC-001-2',
      'AC-002-1',
      'AC-002-2',
      'AC-002-3',
    ]);
    expect(m['AC-001-1'].req).toBe('REQ-001');
    expect(m['AC-001-1'].spec_file).toBe('REQ-001.spec.ts');
    expect(m['AC-001-1'].hash).toMatch(/^[0-9a-f]{12}$/);
    expect(m['AC-002-2'].needs_clarification).toBe(true);
  });

  test('AC hash matches feature-gen.hashAc — same fingerprint across generators', () => {
    const ac = prd.reqs[0].acs[0];
    expect(buildArtifacts(prd, 'PRD-sample').manifest.acs[ac.id].hash).toBe(hashAc(ac));
  });
});

describe('writeArtifacts', () => {
  test('writes spec files + manifest to disk', () => {
    const dir = mkTmp();
    const res = writeArtifacts(prd, 'PRD-sample', dir);
    expect(fs.existsSync(path.join(res.outDir, 'REQ-001.spec.ts'))).toBe(true);
    expect(fs.existsSync(path.join(res.outDir, '.playwright-trace.json'))).toBe(true);
  });

  test('is idempotent — re-running yields byte-identical output', () => {
    const dir = mkTmp();
    writeArtifacts(prd, 'PRD-sample', dir);
    const first = fs.readFileSync(path.join(dir, 'PRD-sample', 'REQ-001.spec.ts'), 'utf8');
    const firstManifest = fs.readFileSync(
      path.join(dir, 'PRD-sample', '.playwright-trace.json'),
      'utf8'
    );
    writeArtifacts(prd, 'PRD-sample', dir);
    const second = fs.readFileSync(path.join(dir, 'PRD-sample', 'REQ-001.spec.ts'), 'utf8');
    const secondManifest = fs.readFileSync(
      path.join(dir, 'PRD-sample', '.playwright-trace.json'),
      'utf8'
    );
    expect(second).toBe(first);
    expect(secondManifest).toBe(firstManifest);
  });

  test('dry run writes nothing', () => {
    const dir = mkTmp();
    const res = writeArtifacts(prd, 'PRD-sample', dir, { dryRun: true });
    expect(fs.existsSync(res.outDir)).toBe(false);
    expect(res.planned.length).toBeGreaterThan(0);
  });

  test('write-once: preserves a hand-edited spec file on regenerate', () => {
    const dir = mkTmp();
    writeArtifacts(prd, 'PRD-sample', dir);
    const specPath = path.join(dir, 'PRD-sample', 'REQ-001.spec.ts');
    fs.writeFileSync(specPath, '// filled in test-first, do not clobber\n');

    const res = writeArtifacts(prd, 'PRD-sample', dir);

    expect(fs.readFileSync(specPath, 'utf8')).toBe('// filled in test-first, do not clobber\n');
    expect(res.skipped).toContain(specPath);
    expect(res.written).not.toContain(specPath);
  });

  test('write-once still refreshes the manifest even when spec files are preserved', () => {
    const dir = mkTmp();
    writeArtifacts(prd, 'PRD-sample', dir);
    const manifestPath = path.join(dir, 'PRD-sample', '.playwright-trace.json');
    const specPath = path.join(dir, 'PRD-sample', 'REQ-001.spec.ts');
    fs.writeFileSync(specPath, '// hand-filled\n');

    const res = writeArtifacts(prd, 'PRD-sample', dir);

    expect(res.written).toContain(manifestPath);
  });

  test('--force overwrites a preserved spec file with fresh generated content', () => {
    const dir = mkTmp();
    writeArtifacts(prd, 'PRD-sample', dir);
    const specPath = path.join(dir, 'PRD-sample', 'REQ-001.spec.ts');
    const generated = fs.readFileSync(specPath, 'utf8');
    fs.writeFileSync(specPath, '// hand-filled, should be discarded by --force\n');

    const res = writeArtifacts(prd, 'PRD-sample', dir, { force: true });

    expect(fs.readFileSync(specPath, 'utf8')).toBe(generated);
    expect(res.written).toContain(specPath);
    expect(res.skipped).not.toContain(specPath);
  });
});

describe('drift.js interop', () => {
  test('a manifest built here is a valid input to diffDrift (shape-compatible)', () => {
    const { diffDrift } = require('../lib/drift');
    const manifest = buildArtifacts(prd, 'PRD-sample').manifest;
    const result = diffDrift(prd, manifest);
    expect(result.inSync).toBe(true);
  });
});
