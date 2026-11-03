'use strict';

/**
 * TRD-007: this repository carries its OWN review files.
 *
 * Validates PRD ACs: AC-002-4 (the files exist here, not only in a template),
 * AC-003-1 (the sensitive paths an owner declares cover this repository's
 * workflows, release gates, installers, generation pipeline and constitution)
 * and AC-001-3 (the policy is data the loader reads, so editing REVIEW.md
 * changes the next review with no code change, rebuild or release).
 *
 * The policy block is graded by the real loader (`pr-review-policy.js`) and
 * the sensitive paths by the real classifier (`pr-review-paths.js`), so a typo
 * in REVIEW.md fails here rather than silently degrading a live review to the
 * strict defaults.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { loadPolicy } = require('../lib/pr-review-policy');
const { classifyPaths } = require('../lib/pr-review-paths');
const { checkDescription } = require('../lib/pr-review-description');

/** The template with every section body filled in, as an author would send it. */
const filled = (template) => template.replace(/^(## .*)$/gm, '$1\n\nfilled by the author.');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

const BASE_SHA = 'b'.repeat(40);

const read = (relative) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(REPO_ROOT, relative));

/** The repository's own policy, re-pointed at a test base commit. */
function repoPolicy() {
  const text = read('REVIEW.md');
  const block = /```ensemble-review-policy\n([\s\S]*?)\n```/.exec(text);
  expect(block).not.toBeNull();
  const declared = JSON.parse(block[1]).sourceSha;
  return loadPolicy({ text: text.replace(declared, BASE_SHA), baseSha: BASE_SHA });
}

describe('this repository ships a root REVIEW.md (AC-002-4)', () => {
  test('REVIEW.md exists at the repository root', () => {
    expect(exists('REVIEW.md')).toBe(true);
  });

  test('its sourceSha names a real commit in this repository', () => {
    const block = /```ensemble-review-policy\n([\s\S]*?)\n```/.exec(read('REVIEW.md'));
    const declared = JSON.parse(block[1]).sourceSha;
    expect(declared).toMatch(/^[0-9a-f]{40}$/);

    // A typo'd or invented sha would silently demote every review to the
    // strict defaults; it must be a commit object that exists here.
    const type = execFileSync('git', ['cat-file', '-t', declared], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    expect(type).toBe('commit');
  });

  test('its policy block is accepted by the loader with nothing rejected', () => {
    const loaded = repoPolicy();
    expect(loaded.ok).toBe(true);
    expect(loaded.source).toBe('policy');
    expect(loaded.rejected).toEqual([]);
  });

  test('it declares maintainers, review bots and a round cap', () => {
    const { policy } = repoPolicy();
    expect(policy.maintainerLogins.length).toBeGreaterThan(0);
    expect(policy.botLogins).toContain('@coderabbitai');
    expect(policy.roundCap).toBeGreaterThanOrEqual(1);
    expect(policy.roundCap).toBeLessThanOrEqual(5);
  });

  test('it explains how area rules files are written (AC-001-3)', () => {
    const text = read('REVIEW.md');
    expect(text).toMatch(/`[^`]*\/REVIEW\.md`/);
    expect(text.toLowerCase()).toContain('area');
  });
});

describe('the declared sensitive paths cover this repository (AC-003-1)', () => {
  const sensitiveFor = (changedPaths) => {
    const { policy } = repoPolicy();
    return classifyPaths({
      changedPaths,
      baseSha: BASE_SHA,
      declaration: { path: 'REVIEW.md', sourceSha: BASE_SHA, sensitive: policy.sensitivePaths },
    });
  };

  test.each([
    ['a CI workflow', '.github/workflows/release.yml'],
    ['a release gate', 'scripts/validate-all.js'],
    ['an installer', 'scripts/install-codex-project.js'],
    ['the generation pipeline', 'scripts/generate-markdown.js'],
    ['a generation pipeline subtree file', 'scripts/generate-codex/index.js'],
    ['the constitution', 'docs/standards/constitution.md'],
  ])('%s is treated as sensitive', (_label, changedPath) => {
    const result = sensitiveFor([changedPath]);
    expect(result.ok).toBe(true);
    expect(result.sensitive).toContain(changedPath);
    expect(result.prSensitive).toBe(true);
  });

  test('an ordinary source file is not sensitive', () => {
    const result = sensitiveFor(['packages/development/lib/trd-parser.js']);
    expect(result.ok).toBe(true);
    expect(result.sensitive).toEqual([]);
    expect(result.prSensitive).toBe(false);
  });
});

describe('this repository ships a PR template and an ownership declaration', () => {
  test('the PR template asks for Testing, Risk and How to revert', () => {
    expect(exists('.github/pull_request_template.md')).toBe(true);
    const template = read('.github/pull_request_template.md');
    expect(template).toContain('## Testing');
    expect(template).toContain('## Risk');
    expect(template).toContain('## How to revert');
  });

  test('the real description checker recognises every section of the template', () => {
    const template = read('.github/pull_request_template.md');

    // Unfilled, the template is NOT a description: headings are not content.
    const empty = checkDescription({ body: template, agentAuthored: false });
    expect(empty.ready).toBe(false);
    expect(empty.missing).toEqual(['testing', 'risk', 'how-to-revert']);

    // Filled in, the same headings satisfy the checker: the template's
    // spelling matches the section labels the checker accepts.
    const answered = checkDescription({ body: filled(template), agentAuthored: false });
    expect(answered.ready).toBe(true);
    expect(answered.missing).toEqual([]);
  });

  test('CODEOWNERS exists and every entry names a path and an owner', () => {
    expect(exists('.github/CODEOWNERS')).toBe(true);
    const entries = read('.github/CODEOWNERS')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const [pattern, ...owners] = entry.trim().split(/\s+/);
      expect(pattern.length).toBeGreaterThan(0);
      expect(owners.length).toBeGreaterThan(0);
      for (const owner of owners) {
        expect(owner).toMatch(/^@[A-Za-z0-9][A-Za-z0-9-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/);
      }
    }
  });
});
