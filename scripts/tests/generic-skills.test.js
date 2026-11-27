'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { generate, plan } = require('../generate-skills');
const { install } = require('../install-skills-project');
const { hash, writeFiles } = require('../lib/skill-bundle');
const { collectSizes } = require('../lib/prompt-budget');
const { collectSkillDirs } = require('../validate-skills');
const { MIRROR_PACKAGES } = require('../lib/mirror-packages');
const { checkMigrationParity } = require('../migrate-command-to-skill');

const REPO = path.resolve(__dirname, '../..');
const scratch = process.env.ENSEMBLE_TEST_SCRATCH || path.join(os.homedir(), '.omp', 'ensemble-skills-tests');
let work;
let bundle;

function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

function tinyBundle(root, contents) {
  const files = new Map(Object.entries(contents));
  writeFiles(root, files);
  write(root, 'manifest.json', JSON.stringify({ schema: 1, files: Object.fromEntries([...files].map(([rel, bytes]) => [rel, hash(bytes)])) }));
}

beforeAll(() => {
  fs.mkdirSync(scratch, { recursive: true });
  work = fs.mkdtempSync(path.join(scratch, 'run-'));
  bundle = path.join(work, 'bundle');
  generate({ output: bundle });
}, 30000);

test('direct source generation preserves workflow semantics, dispatch, skill-backed resources, and reproducibility', () => {
  expect(generate({ output: bundle, check: true }).changed).toBe(0);
  const catalog = JSON.parse(fs.readFileSync(path.join(bundle, 'ensemble/manifest.json')));
  expect(catalog.commands['create-prd']).toBe('ensemble-create-prd');
  expect(catalog.commands['create-trd']).toBe('ensemble-create-trd');
  expect(fs.readFileSync(path.join(bundle, 'ensemble/packages/product/skills/ensemble-create-prd/references/phase-1-structured-elicitation.md'), 'utf8')).toBeDefined();
  expect(catalog.roles['code-reviewer']).toBeDefined();
  const contract = fs.readFileSync(path.join(bundle, 'ensemble/CONTRACT.md'), 'utf8');
  expect(contract).toContain('serial self-review cannot');
  expect(contract).toContain('Required unavailable operations HALT');
  expect(contract).toContain('fallback explicitly authored');
});

test('renderer uses YAML, not generated Claude Markdown, and rejects missing dispatch/collisions', () => {
  const root = path.join(work, 'fixture');
  write(root, 'package.json', '{"version":"1.0.0"}');
  write(root, 'packages/product/commands/one.yaml', 'metadata:\n  name: ensemble:one\n  description: Source description\n  capabilities:\n    required: [tracker.list]\nmission:\n  summary: Source mission\nworkflow:\n  phases:\n    - order: 1\n      name: Source phase\n      steps:\n        - order: 1\n          title: Source step\n          actions: [Source action]\nexpectedOutput:\n  format: Source output\n');
  write(root, 'packages/product/commands/one.md', 'WRONG GENERATED BODY');
  fs.appendFileSync(path.join(root, 'packages/product/commands/one.yaml'), '\nconstraints:\n  - Never bypass independent review\ncustomHandoff:\n  owner: Separate evaluator\n  refusal: Halt when evaluator unavailable\n');
  write(root, 'packages/product/commands/backed.yaml', 'metadata:\n  name: ensemble:backed\n  description: Backed\nskill: backed\n');
  write(root, 'packages/product/skills/backed/SKILL.md', '---\nname: backed\ndescription: Backed source\n---\nRead references/nested/example.md and scripts/run.sh.');
  write(root, 'packages/product/skills/backed/references/nested/example.md', 'Nested reference');
  write(root, 'packages/product/skills/backed/scripts/run.sh', '#!/bin/sh\necho standalone-script\n');
  fs.chmodSync(path.join(root, 'packages/product/skills/backed/scripts/run.sh'), 0o755);
  write(root, 'packages/product/commands/menu.yaml', 'metadata:\n  name: ensemble:menu\n  description: Menu\ndispatch:\n  subcommands:\n    - keyword: one\n      ref: one\n');
  const files = plan({ root, vendor: false });
  const body = files.get('skills/ensemble-one/SKILL.md').toString();
  for (const text of ['Source mission', 'Source phase', 'Source step', 'Source action', 'Source output', 'tracker.list', 'Never bypass independent review', 'Separate evaluator', 'Halt when evaluator unavailable']) expect(body).toContain(text);
  expect(body).not.toContain('WRONG GENERATED BODY');
  expect(files.get('ensemble/packages/product/skills/backed/references/nested/example.md').toString()).toBe('Nested reference');
  expect(files.get('ensemble/packages/product/skills/backed/scripts/run.sh').fileMode).toBe(0o755);
  const out = path.join(work, 'fixture-bundle');
  generate({ root, output: out, vendor: false });
  expect(checkMigrationParity(path.join(root, 'packages/product/commands/one.yaml'), path.join(out, 'skills/ensemble-one'), {
    oldYamlText: fs.readFileSync(path.join(root, 'packages/product/commands/one.yaml'), 'utf8'),
  })).toMatchObject({ ok: true, missing: [] });
  const target = path.join(work, 'fixture-project');
  install(out, target);
  expect(spawnSync(path.join(target, '.agents/ensemble/packages/product/skills/backed/scripts/run.sh'), [], { encoding: 'utf8' }).stdout).toBe('standalone-script\n');
  expect(files.get('skills/ensemble-menu/SKILL.md').toString()).toContain('../ensemble-one/SKILL.md');
  write(root, 'packages/product/commands/menu.yaml', 'metadata:\n  name: ensemble:menu\n  description: Menu\ndispatch:\n  subcommands:\n    - keyword: missing\n      ref: missing\n');
  expect(() => plan({ root, vendor: false })).toThrow('Unknown dispatcher reference');
  fs.unlinkSync(path.join(root, 'packages/product/commands/menu.yaml'));
  write(root, 'packages/other/skills/backed/SKILL.md', '---\nname: backed\ndescription: Collision\n---\nOther source');
  expect(() => plan({ root, vendor: false })).toThrow('Duplicate source skill');
});

test('install is idempotent, keeps unrelated files and runtime configuration, and preflights every conflict', () => {
  const source = path.join(work, 'small');
  const target = path.join(work, 'target');
  tinyBundle(source, { 'skills/a/SKILL.md': 'old', 'ensemble/tool.js': 'old tool' });
  write(target, 'AGENTS.md', 'owner agents');
  write(target, '.codex/config.toml', 'owner config');
  write(target, '.agents/skills/other/SKILL.md', 'owner skill');
  expect(install(source, target, { dryRun: true }).written).toBe(2);
  expect(fs.existsSync(path.join(target, '.agents/ensemble/installed.json'))).toBe(false);
  expect(install(source, target).written).toBe(2);
  expect(install(source, target)).toMatchObject({ written: 0, removed: 0 });
  write(target, '.agents/skills/a/SKILL.md', 'local edit');
  tinyBundle(source, { 'skills/a/SKILL.md': 'new', 'ensemble/tool.js': 'new tool' });
  expect(() => install(source, target)).toThrow('modified or unrelated');
  expect(fs.readFileSync(path.join(target, '.agents/ensemble/tool.js'), 'utf8')).toBe('old tool');
  write(target, '.agents/skills/a/SKILL.md', 'old');
  expect(install(source, target).written).toBe(2);
  tinyBundle(source, { 'skills/a/SKILL.md': 'new' });
  expect(install(source, target).removed).toBe(1);
  expect(fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8')).toBe('owner agents');
  expect(fs.readFileSync(path.join(target, '.codex/config.toml'), 'utf8')).toBe('owner config');
  expect(fs.readFileSync(path.join(target, '.agents/skills/other/SKILL.md'), 'utf8')).toBe('owner skill');
});

test('rejects symlink escapes, corrupt payloads, invalid manifests and file ancestors before writing', () => {
  const source = path.join(work, 'invalid-source');
  const target = path.join(work, 'invalid-target');
  const outside = path.join(work, 'outside');
  fs.mkdirSync(outside);
  tinyBundle(source, { 'skills/a/SKILL.md': 'a', 'ensemble/tool.js': 'tool' });
  fs.mkdirSync(target);
  fs.symlinkSync(outside, path.join(target, '.agents'));
  expect(() => install(source, target)).toThrow('Symlink');
  expect(fs.readdirSync(outside)).toEqual([]);
  fs.unlinkSync(path.join(target, '.agents'));
  write(target, '.agents/ensemble', 'file in the way');
  expect(() => install(source, target)).toThrow('Non-directory');
  expect(fs.existsSync(path.join(target, '.agents/skills/a/SKILL.md'))).toBe(false);
  fs.unlinkSync(path.join(target, '.agents/ensemble'));
  write(source, 'ensemble/tool.js', 'tampered');
  expect(() => install(source, target)).toThrow('hash mismatch');
  expect(fs.existsSync(path.join(target, '.agents/skills/a/SKILL.md'))).toBe(false);
  write(source, 'manifest.json', JSON.stringify({ schema: 1, files: { 'skills/../../escape': hash('x') } }));
  expect(() => install(source, target)).toThrow('Unsafe bundle path');
});

test('identical unowned files are never silently adopted, and locally edited stale files are preserved', () => {
  const source = path.join(work, 'ownership-source');
  const target = path.join(work, 'ownership-target');
  tinyBundle(source, { 'skills/a/SKILL.md': 'same', 'ensemble/tool.js': 'tool' });
  write(target, '.agents/skills/a/SKILL.md', 'same');
  expect(() => install(source, target)).toThrow('modified or unrelated');
  expect(fs.existsSync(path.join(target, '.agents/ensemble/tool.js'))).toBe(false);
  fs.unlinkSync(path.join(target, '.agents/skills/a/SKILL.md'));
  install(source, target);
  write(target, '.agents/ensemble/tool.js', 'owner edit');
  tinyBundle(source, { 'skills/a/SKILL.md': 'same' });
  expect(() => install(source, target)).toThrow('modified or unrelated');
  expect(fs.readFileSync(path.join(target, '.agents/ensemble/tool.js'), 'utf8')).toBe('owner edit');
});

test('generated outputs stay outside authoritative discovery', () => {
  expect(MIRROR_PACKAGES.has('skills')).toBe(true);
  expect(Object.keys(collectSizes(path.join(REPO, 'packages'))).some((file) => file.startsWith('packages/skills/'))).toBe(false);
  expect(collectSkillDirs(path.join(REPO, 'packages')).filter((dir) => dir.startsWith(path.join(REPO, 'packages/skills/'))).length).toBeGreaterThan(0);
});

test('generic output is explicitly collected and fails strict validation even for ensemble-* host keys', () => {
  const packagesDir = path.join(work, 'strict-packages');
  const relative = 'skills/skills/ensemble-invalid/SKILL.md';
  write(packagesDir, relative, '---\nname: ensemble-invalid\ndescription: Validation control\nmodel: vendor-model\n---\nBody\n');
  const gate = path.join(REPO, 'scripts/validate-skills.js');
  const check = () => spawnSync(process.execPath, ['-e', 'require(process.argv[1]).run(process.argv[2]).then(r=>{console.log(JSON.stringify(r));process.exitCode=r.failures.length?1:0;})', gate, packagesDir], { encoding: 'utf8' });
  const invalid = check();
  expect(invalid.status).toBe(1);
  const result = JSON.parse(invalid.stdout);
  expect(result.checked).toBe(1);
  expect(result.failures[0].errors.join('\n')).toContain('model');
  write(packagesDir, relative, '---\nname: ensemble-invalid\ndescription: Validation control\n---\nBody\n');
  const valid = check();
  expect(valid.status).toBe(0);
  expect(JSON.parse(valid.stdout).failures).toEqual([]);
});

test('relocated installed tools use only installed modules, retain data/adapter discovery and perform real effects', () => {
  const target = path.join(work, 'standalone');
  expect(install(bundle, target).written).toBeGreaterThan(0);
  expect(spawnSync('git', ['init', '--quiet', target], { encoding: 'utf8' }).status).toBe(0);
  const support = path.join(target, '.agents/ensemble');
  const originalBundle = `${bundle}-moved`;
  fs.renameSync(bundle, originalBundle);
  const guard = path.join(work, 'guard.cjs');
  write(work, 'guard.cjs', `const Module=require('module');const path=require('path');const original=Module._resolveFilename;Module._resolveFilename=function(...args){const found=original.apply(this,args);if(path.isAbsolute(found)&&!found.startsWith(${JSON.stringify(support + path.sep)}))throw new Error('Module escaped standalone install: '+found);return found;};`);
  const run = (rel, args) => spawnSync(process.execPath, ['--require', guard, path.join(support, rel), ...args], { cwd: target, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
  write(target, 'sample.md', '---\ndocument_id: PRD-2026-sample\nstatus: Draft\n---\n# Sample\n\n### REQ-001: A requirement\n\n- **AC-001-1:** Given a project, when a tool runs, then an artifact exists.\n');
  const generated = run('packages/product/lib/prd-cli.js', ['generate-features', path.join(target, 'sample.md'), '--out', path.join(target, 'features'), '--json']);
  expect({ status: generated.status, stderr: generated.stderr }).toEqual({ status: 0, stderr: '' });
  expect(fs.readFileSync(path.join(target, 'features/sample/REQ-001.feature'), 'utf8')).toContain('Feature: A requirement');
  const resolved = run('packages/development/lib/toolchain-cli.js', ['resolve', '--project-root', target, '--json']);
  if (resolved.status !== 0) throw new Error(`Installed toolchain failed: ${resolved.stdout}\n${resolved.stderr}`);
  expect({ status: resolved.status, stderr: resolved.stderr }).toEqual({ status: 0, stderr: '' });
  expect(JSON.parse(resolved.stdout).ok).toBe(true);
  write(target, 'package.json', '{"dependencies":{"react":"^19.0.0","react-dom":"^19.0.0"}}');
  write(target, 'src/App.tsx', 'import React, {useState} from "react"; export default function App(){const [n]=useState(1);return <div>{n}</div>;}');
  write(target, 'src/index.tsx', 'import {createRoot} from "react-dom/client"; createRoot(document.getElementById("root"));');
  write(target, 'public/index.html', '<div id="root"></div>');
  const check = run('packages/core/lib/detect-framework.js', [target]);
  expect({ status: check.status, stderr: check.stderr }).toEqual({ status: 0, stderr: '' });
  expect(JSON.parse(check.stdout).primary).toBe('react');
  const catalog = JSON.parse(fs.readFileSync(path.join(support, 'manifest.json')));
  for (const rel of Object.values(catalog.skills)) expect(fs.existsSync(path.join(target, '.agents', rel))).toBe(true);
  for (const rel of Object.values(catalog.roles)) expect(fs.existsSync(path.join(support, rel))).toBe(true);
  fs.renameSync(originalBundle, bundle);
}, 30000);
