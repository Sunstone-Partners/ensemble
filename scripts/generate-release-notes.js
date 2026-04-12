#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ROOT_PACKAGE_JSON = path.join(ROOT, 'package.json');
const ROOT_CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

function run(command) {
  return execSync(command, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    output: '',
    updateChangelog: false,
    version: '',
    fromTag: '',
    toRef: 'HEAD',
    title: 'Ensemble Plugins',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--output') out.output = args[++i] || '';
    else if (arg === '--update-changelog') out.updateChangelog = true;
    else if (arg === '--version') out.version = args[++i] || '';
    else if (arg === '--from-tag') out.fromTag = args[++i] || '';
    else if (arg === '--to-ref') out.toRef = args[++i] || 'HEAD';
    else if (arg === '--title') out.title = args[++i] || out.title;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/generate-release-notes.js [--output file] [--update-changelog] [--version x.y.z] [--from-tag vX.Y.Z] [--to-ref ref] [--title title]');
      process.exit(0);
    }
  }

  return out;
}

function getRootVersion(explicitVersion) {
  if (explicitVersion) return explicitVersion;
  return JSON.parse(fs.readFileSync(ROOT_PACKAGE_JSON, 'utf8')).version;
}

function getPreviousGeneralTag(currentVersion) {
  const currentTag = `v${currentVersion}`;
  const tags = run("git tag --list 'v*' --sort=-version:refname")
    .split('\n')
    .filter(Boolean)
    .filter((tag) => !tag.startsWith('codex-v'));
  return tags.find((tag) => tag !== currentTag) || '';
}

function getCommitRecords(fromTag, toRef) {
  const range = fromTag ? `${fromTag}..${toRef}` : toRef;
  const format = '%H%x1f%s%x1f%b%x1e';
  const output = run(`git log ${range} --pretty=format:${JSON.stringify(format)}`);
  return output
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash, subject, body] = entry.split('\x1f');
      return { hash, subject: (subject || '').trim(), body: (body || '').trim() };
    });
}

function parseConventionalCommit(record) {
  const match = record.subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s(.+)$/);
  const breakingInBody = /BREAKING CHANGE:\s*(.+)/i.test(record.body);
  const lowerSubject = record.subject.toLowerCase();
  const isMerge = lowerSubject.startsWith('merge ');

  if (!match) {
    return {
      ...record,
      type: 'other',
      scope: null,
      description: record.subject,
      breaking: breakingInBody,
      conventional: false,
      isMerge,
    };
  }

  return {
    ...record,
    type: match[1].toLowerCase(),
    scope: match[2] || null,
    description: match[4],
    breaking: Boolean(match[3]) || breakingInBody,
    conventional: true,
    isMerge,
  };
}

function categorizeCommit(commit) {
  if (commit.breaking) return 'Breaking Changes';

  switch (commit.type) {
    case 'feat': return 'Features';
    case 'fix': return 'Bug Fixes';
    case 'perf': return 'Performance';
    case 'docs': return 'Documentation';
    case 'test': return 'Testing';
    case 'refactor': return 'Refactoring';
    case 'build':
    case 'ci': return 'Build & CI';
    case 'chore': return 'Maintenance';
    default: return 'Other Changes';
  }
}

function normalizeDescription(description) {
  return description
    .toLowerCase()
    .replace(/\(#\d+\)/g, '')
    .replace(/\[bead:[^\]]+\]/g, '')
    .replace(/\bv\d+\.\d+\.\d+\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatCommitLine(commit) {
  const scope = commit.scope ? `**${commit.scope}:** ` : '';
  return `- ${scope}${commit.description}`;
}

function isUserFacingCommit(commit) {
  if (commit.breaking) return true;
  if (['feat', 'fix', 'perf'].includes(commit.type)) return true;
  if (!commit.scope) return false;

  const userFacingScopes = [
    'core', 'product', 'development', 'quality', 'infrastructure', 'git',
    'e2e-testing', 'metrics', 'pi', 'opencode', 'codex', 'router', 'permitter',
    'react', 'nestjs', 'rails', 'phoenix', 'blazor', 'jest', 'pytest', 'rspec', 'xunit', 'exunit',
    'commands', 'skills', 'agents', 'release', 'generator'
  ];

  return userFacingScopes.includes(commit.scope);
}

function dedupeCommits(commits) {
  const seen = new Set();
  const result = [];

  for (const commit of commits) {
    const key = [categorizeCommit(commit), commit.scope || '', normalizeDescription(commit.description)].join('::');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(commit);
  }

  return result;
}

function prioritizeCommits(commits) {
  return [...commits].sort((a, b) => {
    const aUser = isUserFacingCommit(a) ? 1 : 0;
    const bUser = isUserFacingCommit(b) ? 1 : 0;
    if (aUser !== bUser) return bUser - aUser;

    const aScoped = a.scope ? 1 : 0;
    const bScoped = b.scope ? 1 : 0;
    if (aScoped !== bScoped) return bScoped - aScoped;

    return a.description.localeCompare(b.description);
  });
}

function summarizeSectionCommits(commits, limit = 12) {
  if (commits.length <= limit) {
    return commits.map(formatCommitLine);
  }

  const kept = commits.slice(0, limit).map(formatCommitLine);
  const remaining = commits.slice(limit);
  const byScope = new Map();

  for (const commit of remaining) {
    const scope = commit.scope || 'misc';
    byScope.set(scope, (byScope.get(scope) || 0) + 1);
  }

  const scopeSummary = Array.from(byScope.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([scope, count]) => `${scope} (${count})`)
    .join(', ');

  kept.push(`- Additional ${remaining.length} related changes not listed individually: ${scopeSummary || 'miscellaneous updates'}`);
  return kept;
}

function buildReleaseNotes({ title, version, fromTag, commits }) {
  const sections = new Map();
  const order = [
    'Breaking Changes',
    'Features',
    'Bug Fixes',
    'Performance',
    'Documentation',
    'Testing',
    'Refactoring',
    'Build & CI',
    'Maintenance',
    'Other Changes',
  ];

  const dedupedCommits = prioritizeCommits(dedupeCommits(commits).filter((commit) => !commit.isMerge));

  for (const commit of dedupedCommits) {
    const category = categorizeCommit(commit);
    if (!sections.has(category)) sections.set(category, []);
    sections.get(category).push(commit);
  }

  const lines = [
    `# ${title} ${version}`,
    '',
    fromTag ? `Changes since ${fromTag}.` : 'Initial release notes for Ensemble Plugins.',
    '',
  ];

  for (const category of order) {
    const items = sections.get(category) || [];
    if (items.length === 0) continue;
    lines.push(`## ${category}`);
    lines.push('');
    lines.push(...summarizeSectionCommits(items));
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

function extractSectionsFromNotes(notes) {
  const sections = new Map();
  let current = '';

  for (const line of notes.split('\n')) {
    if (line.startsWith('## ')) {
      current = line.replace(/^##\s+/, '').trim();
      sections.set(current, []);
      continue;
    }
    if (current && line.startsWith('- ')) {
      sections.get(current).push(line);
    }
  }

  return sections;
}

function buildChangelogEntry(version, notes) {
  const date = new Date().toISOString().slice(0, 10);
  const sections = extractSectionsFromNotes(notes);

  const added = sections.get('Features') || [];
  const fixed = sections.get('Bug Fixes') || [];
  const changed = [
    ...(sections.get('Breaking Changes') || []).map((line) => `${line} _(breaking)_`),
    ...(sections.get('Performance') || []),
    ...(sections.get('Documentation') || []),
    ...(sections.get('Testing') || []),
    ...(sections.get('Refactoring') || []),
    ...(sections.get('Build & CI') || []),
    ...(sections.get('Maintenance') || []),
    ...(sections.get('Other Changes') || []),
  ];

  const lines = [`## [${version}] - ${date}`, ''];

  if (added.length > 0) {
    lines.push('### Added', '');
    lines.push(...added, '');
  }

  if (changed.length > 0) {
    lines.push('### Changed', '');
    lines.push(...changed, '');
  }

  if (fixed.length > 0) {
    lines.push('### Fixed', '');
    lines.push(...fixed, '');
  }

  return lines.join('\n').trimEnd() + '\n';
}

function updateRootChangelog(version, notes) {
  const changelog = fs.readFileSync(ROOT_CHANGELOG, 'utf8');
  const entry = buildChangelogEntry(version, notes);

  const unreleasedBlockRegex = /## \[Unreleased\]\n(?:\n(?:### .*\n(?:- .*\n)*))*\n*/m;
  if (unreleasedBlockRegex.test(changelog)) {
    const updated = changelog.replace(unreleasedBlockRegex, `## [Unreleased]\n\n${entry}\n`);
    fs.writeFileSync(ROOT_CHANGELOG, updated, 'utf8');
    return;
  }

  if (changelog.includes('## [Unreleased]')) {
    const updated = changelog.replace('## [Unreleased]', `## [Unreleased]\n\n${entry}`);
    fs.writeFileSync(ROOT_CHANGELOG, updated, 'utf8');
    return;
  }

  fs.writeFileSync(ROOT_CHANGELOG, `${changelog.trimEnd()}\n\n${entry}`, 'utf8');
}

function main(argv) {
  const args = parseArgs(argv);
  const version = getRootVersion(args.version);
  const fromTag = args.fromTag || getPreviousGeneralTag(version);
  const commits = getCommitRecords(fromTag, args.toRef).map(parseConventionalCommit);
  const notes = buildReleaseNotes({ title: args.title, version, fromTag, commits });

  if (args.output) {
    fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    fs.writeFileSync(path.resolve(args.output), notes, 'utf8');
  }

  if (args.updateChangelog) {
    updateRootChangelog(version, notes);
  }

  process.stdout.write(notes);
}

if (require.main === module) {
  main(process.argv);
}
