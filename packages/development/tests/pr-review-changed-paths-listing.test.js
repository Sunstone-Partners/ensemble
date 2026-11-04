'use strict';

/**
 * `changedPaths` come from ONE documented command, and a list that did not
 * come from it fails closed where that can be seen (solo-maintainer rule, F-02).
 *
 * "This PR touches no sensitive path" is only as good as the list of changed
 * paths behind it, and git's default listing is lossy twice over:
 *
 *   - `git diff --name-only` prints only the DESTINATION of a rename, so
 *     moving `.github/workflows/ci.yml`, `REVIEW.md` or `CODEOWNERS` out of its
 *     path hides the sensitive path that was deleted;
 *   - it C-quotes any name holding a non-ASCII byte, a control character, `"`
 *     or `\` (`".github/workflows/a\"b.yml"`), and a quoted name matches no
 *     sensitive pattern.
 *
 * Step 1b of the pr-review-cycle skill therefore defines the list as
 * `git diff --name-only -z --no-renames <baseSha> <headSha>` split on NUL.
 * This file runs real git on a real repository to prove both halves -- the
 * default listing is lossy, the documented one is not -- and the command it
 * runs is read out of the skill's own text, so the prose cannot drift from
 * what is proven here. The code can see a quoted name but not a missing
 * rename side, so it refuses the discount for the first and the documented
 * command is the control for the second.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { classifyPaths } = require('../lib/pr-review-paths');
const { assignTier, effectiveTier } = require('../lib/pr-review-tier');
const { readSkillReference } = require('./helpers/pr-review-cycle-skill');

const GUIDANCE = readSkillReference('scope-guidance-depth.md').replace(/\s+/g, ' ');

const SOLO_POLICY = Object.freeze({ maintainerLogins: ['@Maintainer-M'], soloMaintainer: true });
const NO_PEER = Object.freeze({ needsAnotherPerson: false, reason: 'reviewed', evidencePaths: [] });

/** The git arguments of the command Step 1b documents, taken from the skill's text. */
function documentedListing() {
  const match = /run as git diff with the flags `(--name-only -z --no-renames)` over `<baseSha> <headSha>`/.exec(GUIDANCE);
  expect(match).not.toBeNull();
  return ['diff', ...match[1].split(' ')];
}

/** A repository whose pull request moves three sensitive files and adds a workflow git has to quote. */
function buildRepository() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-changed-paths-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  const write = (relative, body) => {
    const target = path.join(repo, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };
  const lines = (name) => Array.from({ length: 12 }, (_, index) => `${name} line ${index}\n`).join('');

  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  // Git's own defaults, stated so a developer's global config cannot change what is shown.
  git('config', 'core.quotepath', 'true');
  git('config', 'diff.renames', 'true');

  write('.github/workflows/ci.yml', lines('workflow'));
  write('REVIEW.md', lines('review rules'));
  write('.github/CODEOWNERS', lines('owners'));
  write('packages/agent-core/src/x.ts', 'export const x = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD').trim();

  for (const directory of ['tools', 'docs']) fs.mkdirSync(path.join(repo, directory), { recursive: true });
  git('mv', '.github/workflows/ci.yml', 'tools/ci.yml');
  git('mv', 'REVIEW.md', 'docs/REVIEW.md');
  git('mv', '.github/CODEOWNERS', 'docs/OWNERS');
  write('.github/workflows/a"b.yml', lines('quoted'));
  write('packages/agent-core/src/x.ts', 'export const x = 2;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'move the guards, add a workflow, change a High path');
  const headSha = git('rev-parse', 'HEAD').trim();

  return { repo, git, baseSha, headSha };
}

let fixture;

beforeAll(() => {
  fixture = buildRepository();
});

afterAll(() => {
  fs.rmSync(fixture.repo, { recursive: true, force: true });
});

/** The real tier chain over a changed-path list, with a "no" second assessment. */
function chainFor(changedPaths) {
  const declaration = { sourceSha: fixture.baseSha, sensitive: [], high: ['packages/agent-core/**'] };
  const paths = classifyPaths({ changedPaths, declaration, baseSha: fixture.baseSha });
  const assignment = assignTier({ paths, kinds: [{ kind: 'product', paths: changedPaths }], secondAssessment: NO_PEER });
  return { paths, assignment, effective: effectiveTier({ assignment, policy: SOLO_POLICY, author: 'maintainer-m' }) };
}

describe("git's default listing is lossy", () => {
  let lossy;

  beforeAll(() => {
    lossy = fixture.git('diff', '--name-only', fixture.baseSha, fixture.headSha).split('\n').filter((line) => line !== '');
  });

  test('it names the destination of a move and drops the sensitive path that was deleted', () => {
    expect(lossy).toEqual(expect.arrayContaining(['tools/ci.yml', 'docs/REVIEW.md', 'docs/OWNERS']));
    for (const deleted of ['.github/workflows/ci.yml', 'REVIEW.md', '.github/CODEOWNERS']) expect(lossy).not.toContain(deleted);
  });

  test('it quotes a name that holds a double quote, so the path it names is not the path on disk', () => {
    expect(lossy).toContain('".github/workflows/a\\"b.yml"');
    expect(lossy).not.toContain('.github/workflows/a"b.yml');
  });

  test('a list holding a quoted name is refused for the solo-maintainer discount', () => {
    const { assignment, effective } = chainFor(lossy);
    expect(assignment.warnings).toContain('non-verbatim-changed-path');
    expect(effective).toMatchObject({ effectiveTier: 'high', soloMaintainer: { eligible: false, login: null } });
  });
});

describe('the documented listing is rename-complete and verbatim', () => {
  let listed;

  beforeAll(() => {
    const out = fixture.git(...documentedListing(), fixture.baseSha, fixture.headSha);
    listed = out.split('\0');
    expect(listed.pop()).toBe(''); // the empty field after the last NUL
  });

  test('both sides of every move are listed, and no name is quoted', () => {
    expect([...listed].sort()).toEqual(
      [
        '.github/CODEOWNERS',
        '.github/workflows/a"b.yml',
        '.github/workflows/ci.yml',
        'REVIEW.md',
        'docs/OWNERS',
        'docs/REVIEW.md',
        'packages/agent-core/src/x.ts',
        'tools/ci.yml',
      ].sort()
    );
  });

  test('the sensitive paths that were moved away are sensitive again, and the discount is refused', () => {
    const { paths, assignment, effective } = chainFor(listed);
    expect(paths.sensitive).toEqual(
      expect.arrayContaining(['.github/workflows/ci.yml', '.github/workflows/a"b.yml', 'REVIEW.md', '.github/CODEOWNERS'])
    );
    expect(assignment.declarationChanged).toBe(true);
    expect(assignment.warnings).toEqual([]);
    expect(effective).toMatchObject({ effectiveTier: 'high', soloMaintainer: { eligible: false, login: null } });
  });
});

describe('the skill says exactly how changedPaths is produced', () => {
  test('Step 1b names the one command, NUL splitting and what each flag is for', () => {
    expect(documentedListing()).toEqual(['diff', '--name-only', '-z', '--no-renames']);
    expect(GUIDANCE).toContain('split on NUL with the empty field after the last NUL dropped');
    expect(GUIDANCE).toContain('`-z` makes git print every name verbatim');
    expect(GUIDANCE).toContain('`--no-renames` makes git list BOTH sides of a move');
  });

  test('the prose forbids every other source, and an empty list as a stand-in for a failed command', () => {
    expect(GUIDANCE).toContain("Never take the list from the host's own file listing");
    expect(GUIDANCE).toContain("from git's `--name-status` output, from a diff with renames detected");
    expect(GUIDANCE).toContain('never pass `[]` or a guess');
  });
});
