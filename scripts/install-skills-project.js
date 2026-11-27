#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { hash, safePath, writeFiles } = require('./lib/skill-bundle');

const STATE = 'ensemble/installed.json';

function install(bundle, target, { dryRun = false } = {}) {
  const root = path.resolve(target, '.agents');
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
  if (manifest.schema !== 1 || !manifest.files || typeof manifest.files !== 'object') throw new Error('Invalid bundle manifest');
  const statePath = safePath(root, STATE);
  const previous = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { schema: 1, files: {} };
  if (previous.schema !== 1 || !previous.files || typeof previous.files !== 'object') throw new Error('Invalid installed manifest');
  const wanted = new Map();
  const removals = [];
  const conflicts = [];
  for (const rel of new Set([...Object.keys(manifest.files), ...Object.keys(previous.files)])) {
    if (rel === STATE || !(rel.startsWith('skills/') || rel.startsWith('ensemble/'))) throw new Error(`Invalid owned path: ${rel}`);
    const dest = safePath(root, rel);
    const exists = fs.existsSync(dest);
    if (exists && !fs.statSync(dest).isFile()) throw new Error(`Expected file: ${dest}`);
    const current = exists ? hash(fs.readFileSync(dest)) : null;
    const expected = manifest.files[rel];
    if (expected !== undefined) {
      if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Invalid file hash: ${rel}`);
      const source = safePath(bundle, rel);
      const bytes = fs.readFileSync(source);
      const mode = manifest.modes?.[rel] ?? 0o644;
      if (mode !== 0o644 && mode !== 0o755) throw new Error(`Invalid file mode: ${rel}`);
      bytes.fileMode = mode;
      if (hash(bytes) !== expected) throw new Error(`Bundle hash mismatch: ${rel}`);
      if (current !== null && (!Object.prototype.hasOwnProperty.call(previous.files, rel) ||
          (current !== expected && current !== previous.files[rel]))) conflicts.push(rel);
      if (current !== null && previous.modes?.[rel] !== undefined &&
          (fs.statSync(dest).mode & 0o777) !== previous.modes[rel] && (fs.statSync(dest).mode & 0o777) !== mode) conflicts.push(rel);
      if (current !== expected || (exists && (fs.statSync(dest).mode & 0o777) !== mode)) wanted.set(rel, bytes);
    } else if (current !== null) {
      if (current !== previous.files[rel] || (previous.modes?.[rel] !== undefined &&
          (fs.statSync(dest).mode & 0o777) !== previous.modes[rel])) conflicts.push(rel);
      else removals.push(dest);
    }
  }
  if (conflicts.length) throw new Error(`Refusing to replace modified or unrelated files: ${conflicts.join(', ')}. Save or remove the conflicting files explicitly, then retry.`);
  // All source bytes and destination paths have been checked before the first write.
  if (!dryRun) {
    writeFiles(root, wanted);
    for (const file of removals) fs.unlinkSync(file);
    const next = `${JSON.stringify({ schema: 1, files: manifest.files, modes: manifest.modes || {} }, null, 2)}\n`;
    if (!fs.existsSync(statePath) || fs.readFileSync(statePath, 'utf8') !== next) writeFiles(root, new Map([[STATE, next]]));
  }
  return { written: wanted.size, removed: removals.length, dryRun, target: root };
}

function main(args) {
  if (args.includes('--help')) {
    console.log('Usage: node scripts/install-skills-project.js <project-directory> [--dry-run]');
    return;
  }
  if (!args[0] || args[0].startsWith('-') || args.slice(1).some((arg) => arg !== '--dry-run')) throw new Error('An explicit project directory is required; use --help');
  const result = install(path.resolve(__dirname, '../packages/skills'), args[0], { dryRun: args.includes('--dry-run') });
  console.log(JSON.stringify(result));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { install };
