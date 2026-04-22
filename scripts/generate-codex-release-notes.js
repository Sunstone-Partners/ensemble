#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = path.join(ROOT, 'packages', 'codex', 'package.json');
const CHANGELOG = path.join(ROOT, 'packages', 'codex', 'CHANGELOG.md');

function run(command) {
  return execSync(command, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    output: '',
    updateChangelog: false,
    version: '',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--output') out.output = args[++i] || '';
    else if (arg === '--update-changelog') out.updateChangelog = true;
    else if (arg === '--version') out.version = args[++i] || '';
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/generate-codex-release-notes.js [--output file] [--update-changelog] [--version x.y.z]');
      process.exit(0);
    }
  }

  return out;
}

function getPackageVersion(explicitVersion) {
  if (explicitVersion) return explicitVersion;
  return JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version;
}

function getPreviousTag(currentVersion) {
  const tags = run("git tag --list 'codex-v*' --sort=-version:refname").split('\n').filter(Boolean);
  const currentTag = `codex-v${currentVersion}`;
  return tags.find((tag) => tag !== currentTag) || '';
}

function getCommitLines(previousTag) {
  const range = previousTag ? `${previousTag}..HEAD` : 'HEAD';
  const format = '%s';
  const output = run(`git log ${range} --pretty=format:${JSON.stringify(format)}`);
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function bucketCommit(subject) {
  const lower = subject.toLowerCase();
  if (lower.startsWith('feat') || lower.includes(' add ') || lower.includes(' support ')) return 'Features';
  if (lower.startsWith('fix') || lower.startsWith('bug')) return 'Fixes';
  if (lower.startsWith('docs') || lower.includes('readme') || lower.includes('changelog')) return 'Documentation';
  if (lower.startsWith('test')) return 'Testing';
  return 'Other';
}

function unique(items) {
  return Array.from(new Set(items));
}

function buildReleaseNotes(version, previousTag, commits) {
  const buckets = {
    Features: [],
    Fixes: [],
    Documentation: [],
    Testing: [],
    Other: [],
  };

  for (const commit of unique(commits)) {
    buckets[bucketCommit(commit)].push(commit);
  }

  const lines = [
    `# @fortium/ensemble-codex ${version}`,
    '',
    previousTag
      ? `Changes since ${previousTag}.`
      : 'Initial published release notes for ensemble-codex.',
    '',
  ];

  for (const [section, items] of Object.entries(buckets)) {
    if (items.length === 0) continue;
    lines.push(`## ${section}`);
    lines.push('');
    for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push('## Install');
  lines.push('');
  lines.push('```bash');
  lines.push('npm install -D @fortium/ensemble-codex');
  lines.push('npx ensemble-codex-install . --force');
  lines.push('```');
  lines.push('');

  return lines.join('\n').trimEnd() + '\n';
}

function updateChangelog(version, notes) {
  const changelog = fs.readFileSync(CHANGELOG, 'utf8');
  const lines = notes.split('\n');
  const summaryBullets = [];
  let capture = false;
  for (const line of lines) {
    if (line.startsWith('## Install')) break;
    if (line.startsWith('## ')) {
      capture = true;
      continue;
    }
    if (capture && line.startsWith('- ')) summaryBullets.push(line);
  }

  const entry = [`## ${version}`, '', ...summaryBullets, ''].join('\n');
  const updated = changelog.replace(/^# Changelog\n\n/, `# Changelog\n\n${entry}`);
  fs.writeFileSync(CHANGELOG, updated, 'utf8');
}

function main(argv) {
  const args = parseArgs(argv);
  const version = getPackageVersion(args.version);
  const previousTag = getPreviousTag(version);
  const commits = getCommitLines(previousTag);
  const notes = buildReleaseNotes(version, previousTag, commits);

  if (args.output) {
    fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    fs.writeFileSync(path.resolve(args.output), notes, 'utf8');
  }

  if (args.updateChangelog) {
    updateChangelog(version, notes);
  }

  process.stdout.write(notes);
}

if (require.main === module) {
  main(process.argv);
}
