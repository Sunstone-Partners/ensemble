'use strict';

/**
 * `--project-root <path>` for toolchain-cli.js (kata vsg4, docs/plans/pr-review-speedup-plan.md
 * section 3H item 1): run capabilities against the repository under review, not process.cwd().
 *
 * Every test spawns the REAL CLI entry point (`node toolchain-cli.js ...`) from a cwd that is
 * deliberately NOT the target repo, against real `git init`/`git worktree add` trees, with a
 * fixture tracker adapter whose `tracker.show` is a genuine `node -e` child that reports the
 * `cwd` it actually ran in and the content of the `beads.txt` it finds there. That makes "which
 * tracker did this resolve to" directly observable instead of asserted from plumbing.
 *
 * Fixture trees live under os.tmpdir() and are removed in `finally` blocks (the same convention
 * toolchain-cli.test.js uses); none of them holds work that needs to survive a reboot.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { spawnSync, execFileSync } = require('child_process');

const { resolveProjectRootFlag } = require('../lib/toolchain-cli');
const CLI = path.join(__dirname, '..', 'lib', 'toolchain-cli.js');
const ADAPTER_ID = 'fixture-project-root-tracker';

const GIT_ENV = {
  PATH: process.env.PATH,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid'
};

/** Only PATH is inherited, so CI/ENSEMBLE_NON_INTERACTIVE/session vars cannot skew the run. */
function cleanSpawnEnv() {
  return { PATH: process.env.PATH };
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' });
}

function mkScratch(prefix) {
  // realpath: os.tmpdir() is a symlink on macOS (/var -> /private/var).
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A real git repo with one (empty) commit so `git worktree add` works. */
function mkRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

/**
 * Give `root` a tracker of its own: `.ensemble/toolchain.yaml` selecting the fixture adapter,
 * the adapter itself, and a `beads.txt` that stands in for that tree's tracker data.
 * `tracker.show` appends to `ran.marker` in its cwd so "nothing ran" is checkable.
 */
function installTracker(root, beads) {
  fs.mkdirSync(path.join(root, '.ensemble'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ensemble', 'toolchain.yaml'), `tracker: ${ADAPTER_ID}\n`);
  const skillDir = path.join(root, 'packages', 'fixture-pkg', 'skills', ADAPTER_ID);
  fs.mkdirSync(skillDir, { recursive: true });
  const script =
    "const fs=require('fs');fs.appendFileSync('ran.marker','x');" +
    "process.stdout.write(JSON.stringify({cwd:fs.realpathSync(process.cwd()),beads:fs.readFileSync('beads.txt','utf8')}))";
  fs.writeFileSync(
    path.join(skillDir, 'adapter.yaml'),
    yaml.dump({
      adapter: ADAPTER_ID,
      version: '1.0.0',
      categories: ['tracker'],
      contract: { tracker: '1.0' },
      binaries: [process.execPath],
      allowlist: [{ bin: process.execPath, sub: ['-e'] }],
      env: [],
      health: [{ id: 'ok-check', run: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 5000 }],
      detect: [],
      capabilities: { 'tracker.show': { run: [process.execPath, '-e', script] } }
    })
  );
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${ADAPTER_ID}\n`);
  fs.writeFileSync(path.join(root, 'beads.txt'), beads);
}

function cli(cwd, args) {
  return spawnSync('node', [CLI, ...args], { cwd, env: cleanSpawnEnv(), encoding: 'utf8' });
}

/** `run tracker.show --json` -> the parsed envelope with `data` parsed from the fixture JSON. */
function runShow(cwd, extraArgs) {
  const res = cli(cwd, ['run', 'tracker.show', '--json', ...extraArgs]);
  const envelope = JSON.parse(res.stdout);
  return { res, envelope, data: envelope.ok ? JSON.parse(envelope.data) : undefined };
}

describe('toolchain-cli --project-root (kata vsg4)', () => {
  let scratch;
  let unrelated;

  beforeEach(() => {
    scratch = mkScratch('toolchain-cli-project-root-');
    // The cwd every spawn starts in: a plain directory that is NOT a git repo and has no tracker.
    unrelated = path.join(scratch, 'unrelated-cwd');
    fs.mkdirSync(unrelated);
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  // AC1
  test('run reads the tracker of the --project-root repo, not the cwd, for two distinct repos', () => {
    const repoA = mkRepo(path.join(scratch, 'repo-a'));
    const repoB = mkRepo(path.join(scratch, 'repo-b'));
    installTracker(repoA, 'beads-of-A');
    installTracker(repoB, 'beads-of-B');

    const a = runShow(unrelated, ['--project-root', repoA]);
    expect(a.res.status).toBe(0);
    expect(a.envelope.adapter).toBe(ADAPTER_ID);
    expect(a.data).toEqual({ cwd: repoA, beads: 'beads-of-A' });

    const b = runShow(unrelated, ['--project-root', repoB]);
    expect(b.res.status).toBe(0);
    expect(b.data).toEqual({ cwd: repoB, beads: 'beads-of-B' });

    // Nothing leaked into the cwd the CLI was started from.
    expect(fs.readdirSync(unrelated)).toEqual([]);
  });

  test('the flag wins over the cwd even when the cwd is itself a valid repo with its own tracker', () => {
    const cwdRepo = mkRepo(path.join(scratch, 'cwd-repo'));
    const target = mkRepo(path.join(scratch, 'target-repo'));
    installTracker(cwdRepo, 'beads-of-cwd');
    installTracker(target, 'beads-of-target');

    expect(runShow(cwdRepo, []).data.beads).toBe('beads-of-cwd');
    expect(runShow(cwdRepo, ['--project-root', target]).data).toEqual({
      cwd: target,
      beads: 'beads-of-target'
    });
    // Exactly one run happened in the cwd repo (the flag-less one): the flagged run did not.
    expect(fs.readFileSync(path.join(cwdRepo, 'ran.marker'), 'utf8')).toBe('x');
  });

  test('a relative --project-root resolves against the cwd, and a symlink resolves to its real path', () => {
    const repo = mkRepo(path.join(scratch, 'repo-rel'));
    installTracker(repo, 'beads-rel');
    const link = path.join(scratch, 'link-to-repo');
    fs.symlinkSync(repo, link);

    const viaRelative = runShow(scratch, ['--project-root', 'repo-rel']);
    expect(viaRelative.data).toEqual({ cwd: repo, beads: 'beads-rel' });

    const viaLink = cli(unrelated, ['preflight', '--require', 'tracker.show', '--run-id', 'rel-1', '--project-root', link, '--json']);
    expect(viaLink.status).toBe(0);
    // State lands under the REAL path (the symlink and its target share one ledger directory).
    expect(fs.existsSync(path.join(repo, '.ensemble', 'state', 'toolchain', 'preflight-rel-1.json'))).toBe(true);
  });

  // AC2: the CLI uses a linked worktree path verbatim as the adapter cwd/state root and never maps
  // it back to the main checkout. (What data a real `br` then reads from a worktree is br's own
  // behaviour -- it shares the main DB -- and is documented in the CLI header, smoke-tested for real.)
  test('a linked worktree as --project-root is used verbatim as cwd and state root, never mapped to the main checkout', () => {
    const main = mkRepo(path.join(scratch, 'ensemble'));
    const worktree = path.join(scratch, 'ensemble.pr-review');
    git(main, ['worktree', 'add', '-q', '-b', 'review', worktree]);
    expect(fs.statSync(path.join(worktree, '.git')).isFile()).toBe(true); // really a linked worktree

    installTracker(main, 'beads-of-main-checkout');
    installTracker(worktree, 'beads-of-worktree');

    const wt = runShow(unrelated, ['--project-root', worktree]);
    expect(wt.res.status).toBe(0);
    expect(wt.data).toEqual({ cwd: worktree, beads: 'beads-of-worktree' });

    const mn = runShow(unrelated, ['--project-root', main]);
    expect(mn.data).toEqual({ cwd: main, beads: 'beads-of-main-checkout' });

    const pre = cli(unrelated, ['preflight', '--require', 'tracker.show', '--run-id', 'wt-1', '--project-root', worktree, '--json']);
    expect(pre.status).toBe(0);
    expect(fs.existsSync(path.join(worktree, '.ensemble', 'state', 'toolchain', 'preflight-wt-1.json'))).toBe(true);
    expect(fs.existsSync(path.join(main, '.ensemble', 'state'))).toBe(false);
  });

  test('state written by run/preflight follows --project-root (ledger of the repo under review)', () => {
    const repo = mkRepo(path.join(scratch, 'repo-state'));
    installTracker(repo, 'beads-state');

    const pre = cli(unrelated, ['preflight', '--require', 'tracker.show', '--run-id', 'state-1', '--project-root', repo, '--json']);
    expect(pre.status).toBe(0);
    expect(fs.existsSync(path.join(repo, '.ensemble', 'state', 'toolchain', 'preflight-state-1.json'))).toBe(true);
    expect(fs.existsSync(path.join(unrelated, '.ensemble'))).toBe(false);
  });

  // AC3
  describe('invalid --project-root is INVALID_ARG and nothing runs', () => {
    /** cwd is a VALID repo with a working tracker: if the guard were missing, the adapter would run. */
    function runWithBadRoot(rawArgs) {
      const cwdRepo = mkRepo(path.join(scratch, 'valid-cwd-repo'));
      installTracker(cwdRepo, 'beads-of-cwd');
      const res = cli(cwdRepo, ['run', 'tracker.show', '--json', ...rawArgs]);
      return { cwdRepo, res, parsed: JSON.parse(res.stdout) };
    }

    function expectRejected({ cwdRepo, res, parsed }, messageFragment) {
      expect(res.status).toBe(1);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('INVALID_ARG');
      expect(parsed.error.message).toContain('--project-root');
      expect(parsed.error.message).toContain(messageFragment);
      expect(fs.existsSync(path.join(cwdRepo, 'ran.marker'))).toBe(false);
      expect(fs.existsSync(path.join(cwdRepo, '.ensemble', 'state'))).toBe(false);
    }

    test('nonexistent path', () => {
      expectRejected(
        runWithBadRoot(['--project-root', path.join(scratch, 'does-not-exist')]),
        'does not exist'
      );
    });

    test('a file, not a directory', () => {
      const file = path.join(scratch, 'a-file');
      fs.writeFileSync(file, 'x');
      expectRejected(runWithBadRoot(['--project-root', file]), 'not a directory');
    });

    test('a plain directory that is not a git repo', () => {
      const plain = path.join(scratch, 'plain-dir');
      fs.mkdirSync(plain);
      expectRejected(runWithBadRoot(['--project-root', plain]), 'not a git repository root');
    });

    test('a subdirectory of a repo (not its root)', () => {
      const repo = mkRepo(path.join(scratch, 'repo-with-sub'));
      const sub = path.join(repo, 'packages');
      fs.mkdirSync(sub);
      expectRejected(runWithBadRoot(['--project-root', sub]), 'not a git repository root');
    });

    test('a bogus .git file that is not a gitdir pointer', () => {
      const fake = path.join(scratch, 'fake-worktree');
      fs.mkdirSync(fake);
      fs.writeFileSync(path.join(fake, '.git'), 'not a pointer\n');
      expectRejected(runWithBadRoot(['--project-root', fake]), 'not a git repository root');
    });

    test('an empty .git directory (no HEAD)', () => {
      const fake = path.join(scratch, 'fake-git-dir');
      fs.mkdirSync(path.join(fake, '.git'), { recursive: true });
      expectRejected(runWithBadRoot(['--project-root', fake]), 'not a git repository root');
    });

    test('missing value, flag-looking value, and a repeated flag', () => {
      const repo = mkRepo(path.join(scratch, 'ok-repo'));
      expectRejected(runWithBadRoot(['--project-root']), 'requires a path value');
      expectRejected(runWithBadRoot(['--project-root', '--non-interactive']), 'requires a path value');
      expectRejected(runWithBadRoot(['--project-root', repo, '--project-root', repo]), 'at most once');
    });

    test('works for every state-writing subcommand, not just run', () => {
      const cwdRepo = mkRepo(path.join(scratch, 'valid-cwd-repo'));
      installTracker(cwdRepo, 'beads-of-cwd');
      const missing = path.join(scratch, 'does-not-exist');
      for (const args of [
        ['preflight', '--require', 'tracker.show', '--run-id', 'bad-1'],
        ['confirm-status', 'tracker.show'],
        ['confirm-record', 'tracker.show', '--run-id', 'bad-1'],
        ['resolve']
      ]) {
        const res = cli(cwdRepo, [...args, '--project-root', missing, '--json']);
        const parsed = JSON.parse(res.stdout);
        expect({ args, status: res.status, code: parsed.error && parsed.error.code }).toEqual({
          args,
          status: 1,
          code: 'INVALID_ARG'
        });
      }
      expect(fs.existsSync(path.join(cwdRepo, '.ensemble', 'state'))).toBe(false);
    });
  });

  describe('trace follows --project-root and still never fails the traced flow', () => {
    test('trace start/summarize write and read the trace under the target repo', () => {
      const repo = mkRepo(path.join(scratch, 'repo-trace'));
      const start = cli(unrelated, ['trace', 'start', '--run-id', 'tr-1', '--name', 'phase', '--project-root', repo, '--json']);
      expect(start.status).toBe(0);
      expect(JSON.parse(start.stdout).ok).toBe(true);
      expect(fs.existsSync(path.join(repo, '.ensemble', 'state', 'toolchain', 'trace-tr-1.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(unrelated, '.ensemble'))).toBe(false);

      const summary = cli(unrelated, ['trace', 'summarize', '--run-id', 'tr-1', '--project-root', repo, '--json']);
      expect(summary.status).toBe(0);
      const parsed = JSON.parse(summary.stdout);
      expect(parsed.run_id).toBe('tr-1');
      expect(parsed.span_count).toBe(1);
    });

    test('an invalid root degrades to `trace: unavailable`, exit 0, and writes nothing', () => {
      const missing = path.join(scratch, 'does-not-exist');
      const start = cli(unrelated, ['trace', 'start', '--run-id', 'tr-2', '--name', 'phase', '--project-root', missing]);
      expect(start.status).toBe(0);
      expect(start.stderr).toContain('trace: unavailable');
      expect(start.stderr).toContain('--project-root');
      expect(fs.readdirSync(unrelated)).toEqual([]);
    });
  });

  test('resolveProjectRootFlag returns the realpath for a symlink and for a relative path', () => {
    const repo = mkRepo(path.join(scratch, 'repo-real'));
    const link = path.join(scratch, 'link-real');
    fs.symlinkSync(repo, link);
    expect(resolveProjectRootFlag(link)).toEqual({ projectRoot: repo });
    const relative = path.relative(process.cwd(), repo);
    expect(resolveProjectRootFlag(relative)).toEqual({ projectRoot: repo });
  });

  test('without the flag behaviour is unchanged: the cwd is the project root', () => {
    const repo = mkRepo(path.join(scratch, 'repo-default'));
    installTracker(repo, 'beads-default');
    expect(runShow(repo, []).data).toEqual({ cwd: repo, beads: 'beads-default' });
  });
});
