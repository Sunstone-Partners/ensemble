'use strict';

/**
 * Scripted host-swap scenario (TRD-2026-8d825f54 TRD-041, bead br-d6cq, PRD AC-017-1, AC-017-2,
 * AC-017-3). Proves, through REAL subprocess entry points against the REAL, un-copied
 * `packages/development/lib/toolchain-cli.js`, that an operator can select the Azure DevOps
 * `host` adapter by configuration alone and run push/open/check-status/merge with a stub `az`
 * on `PATH` and no `gh` reachable anywhere, then separately link a change request to a tracker
 * work item through config alone (`host: azure-devops`, `tracker: azure-boards`), mirroring
 * `tracker-swap-scenario.test.js`'s own harness shape for the `host` category instead of
 * `tracker`.
 *
 * Two coverage areas (1:1 with the assignment):
 *   1. AC1/AC2 -- `workflow.push` (real `git`, local bare remote), `host.change-request-create`,
 *      `host.change-request-view` and `host.change-request-merge` (stub `az`) each exit 0 on a
 *      `PATH` with the stub `az` and no real `gh`; the combined scenario output (every
 *      `toolchain-cli run` call's own stdout plus the real argv the stub `az` actually
 *      received, via the same `calls-<bin>.log` convention `tracker-swap-scenario.test.js`'s
 *      own `readCallsLog` already establishes) uses Azure DevOps vocabulary and never GitHub's.
 *   2. AC3 -- `host.change-request-link-work-item` reaches `az repos pr work-item add` with
 *      `host: azure-devops` AND `tracker: azure-boards` selected by `.ensemble/toolchain.yaml`
 *      alone (a bare `resolve --json` call proves both categories resolve from config, with no
 *      production source file ever written by this test).
 *
 * Resolved ambiguities (same "disclosed decision" convention `tracker-swap-scenario.test.js`'s
 * own header uses):
 *   - The assignment's own text says `vcs.push`; TRD-035 already resolved this (see
 *     `packages/development/toolchain/categories/workflow.yaml`'s own header comment): there is
 *     no `vcs` category, this is `workflow.push`.
 *   - Implementation AC2 asks to scan for "the GitHub-only terms listed in the host vocabulary
 *     block (for example 'pull request review decision')". That exact phrase does not literally
 *     appear in either `adapter-host-github/SKILL.md`'s or `adapter-host-azure-devops/SKILL.md`'s
 *     own `## Vocabulary` section (both read in full while researching this bead) -- and
 *     `checkVocabularyBlock` (`packages/development/lib/toolchain/validate.js`) only checks that
 *     heading's PRESENCE, extracting no term list at all. The markdown prose therefore carries no
 *     mechanically-extractable corpus. This test instead scans the scenario's own REAL output
 *     (CLI stdout plus the real argv each stub binary received) for: (a) literal CLI-level
 *     vocabulary unique to each adapter's own `run[]`/`health[]` templates, read verbatim off
 *     `adapter.yaml` while researching this bead (Azure's `repos`/`show`/`update`/`work-item`
 *     subcommand words and `sourceRefName`/`targetRefName` query fields vs GitHub's `view`/
 *     `merge`/`squash`/`baseRefName`/`headRefName`/`statusCheckRollup`/`auth status`/
 *     `github.com`, none of which Azure's templates ever produce and none of which can appear
 *     here since `gh` is never invoked at all); and (b) the task's own illustrative "pull
 *     request"/"policy" examples, satisfied honestly by choosing a PR title/description (this
 *     test's own caller-supplied `host.change-request-create` input, passed through verbatim as
 *     real `az --title`/`--description` argv, never a fabricated adapter output) that contains
 *     those words -- not by inventing backend behavior.
 *
 * Independent review is deferred to the PR 9 gate (STRATEGY=flexible, no reviewer agent runs on
 * this bead).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { installHostAzureDevOpsStub } = require('./fixtures/toolchain/adapter-host-azure-devops-stub');

jest.setTimeout(30000);

const REPO_ROOT = path.join(__dirname, '..', '..');
const TOOLCHAIN_CLI = path.join(REPO_ROOT, 'packages', 'development', 'lib', 'toolchain-cli.js');
const GIT_BIN = '/usr/bin/git';
const BRANCH_NAME = 'feature/host-swap-demo';

// ---------------------------------------------------------------------------
// Generic fixture / subprocess helpers (mirroring tracker-swap-scenario.test.js's own
// mkThrowawayProjectRoot/buildPath/runNode/readCallsLog conventions).
// ---------------------------------------------------------------------------

/** Fresh throwaway `/tmp` directory, symlink-resolved so later path comparisons never trip on
 * macOS's `/tmp` -> `/private/tmp` symlink. */
function mkThrowawayProjectRoot(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeToolchainConfig(dir, lines) {
  fs.mkdirSync(path.join(dir, '.ensemble'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.ensemble', 'toolchain.yaml'), lines.join('\n') + '\n');
}

/**
 * The stub `az` binaries below use a `#!/usr/bin/env node` shebang (the same convention every
 * stub in `tracker-swap-scenario.test.js` uses) -- `env` itself still needs to resolve `node`
 * via `PATH` to launch them at all (confirmed empirically while researching this bead: omitting
 * any `node`-containing directory fails every stub invocation with a literal
 * `env: node: No such file or directory`, not a graceful skip). `path.dirname(process.execPath)`
 * -- the directory `tracker-swap-scenario.test.js`'s own `buildPath()` uses for this -- is
 * `/opt/homebrew/bin` on this machine, which ALSO holds a REAL `gh` binary (confirmed live via
 * `which -a gh`), so including it here would silently defeat this scenario's own "no gh on PATH"
 * requirement. Instead, a single throwaway directory holding ONLY a `node` symlink pointing at
 * `process.execPath` is created once and reused by every test in this file.
 */
const NODE_ONLY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'host-swap-node-only-'));
fs.symlinkSync(process.execPath, path.join(NODE_ONLY_DIR, 'node'));

/**
 * Hosted CI (ubuntu-latest) ships a real `gh` in `/usr/bin`, so putting `/usr/bin:/bin` on the
 * restricted `PATH` would defeat the "no gh on PATH" requirement there (it only held on machines
 * whose `/usr/bin` lacks `gh`). Instead, expose ONLY the system tools the capability calls need
 * (`git`, `ps`, `sh`, `which`) through a private directory of symlinks.
 */
const SYSTEM_TOOLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'host-swap-system-tools-'));
for (const tool of ['git', 'ps', 'sh', 'which']) {
  const real = ['/usr/bin', '/bin'].map((d) => path.join(d, tool)).find((p) => fs.existsSync(p));
  if (real) fs.symlinkSync(real, path.join(SYSTEM_TOOLS_DIR, tool));
}

/**
 * `PATH` containing ONLY the fixture bin dir, `NODE_ONLY_DIR` and `SYSTEM_TOOLS_DIR` (see above) --
 * NEVER the real inherited `process.env.PATH`. `/usr/bin`/`/bin` are confirmed (live, same
 * research pass) to hold neither `gh` nor `az` on this machine, and do hold the real `git`
 * (`/usr/bin/git`) and `ps` (`/bin/ps`, used internally by `runner.js`'s timeout containment)
 * every capability call below needs.
 */
function buildPath(binDir) {
  return [binDir, NODE_ONLY_DIR, SYSTEM_TOOLS_DIR].join(path.delimiter);
}

function runNode(cliPath, args, cwd, env) {
  const r = spawnSync(process.execPath, [cliPath, ...args], { cwd, env, encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    // some assertions below only need status/stdout/stderr
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function readCallsLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Real, un-stubbed `git` invocation used only for scenario SETUP (creating the throwaway repo,
 * its local bare "remote", and its commits) -- never the capability call under test itself,
 * which always goes through `toolchain-cli.js run workflow.push` with the restricted `PATH`
 * above. Inherits the full test-runner environment (fine for setup; irrelevant to the "no gh on
 * PATH" requirement, which only constrains the CLI-under-test's own child processes). */
function runGit(args, cwd) {
  const r = spawnSync(GIT_BIN, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${r.status}): ${r.stderr}`);
  }
  return r;
}

/** Confirm `gh` is not resolvable at all under `PATH` (same `which`-based check
 * `tracker-swap-scenario.test.js`'s own `expectNoBrBvOnPath` uses for `br`/`bv`). */
function expectNoGhOnPath(PATH) {
  const whichGh = spawnSync('which', ['gh'], { env: { PATH }, encoding: 'utf8' });
  expect(whichGh.status).not.toBe(0);
  expect(whichGh.stdout.trim()).toBe('');
}

// ---------------------------------------------------------------------------
// GitHub-only vs Azure DevOps vocabulary (see this file's own header for how this corpus was
// derived). Each GitHub-only term is a literal CLI/field token read verbatim off
// `packages/git/skills/adapter-host-github/adapter.yaml`'s own `run[]` templates; each Azure
// term is either a literal token off `packages/infrastructure/skills/adapter-host-azure-devops/
// adapter.yaml`'s own `run[]` templates, or one of the task's own illustrative words ("pull
// request", "policy") realized honestly via this test's own PR title/description input.
// ---------------------------------------------------------------------------

const GITHUB_ONLY_TERMS = [
  'squash', // gh pr merge <id> --squash (az has no squash concept; merge uses --status completed)
  'statusCheckRollup', // gh pr view --json ...statusCheckRollup
  'baseRefName', // gh pr view --json ...baseRefName (az's own field is targetRefName)
  'headRefName', // gh pr view --json ...headRefName (az's own field is sourceRefName)
  'auth status', // gh auth status (az uses `account show` / `devops configure --list` instead)
  'github.com', // gh auth status --hostname github.com
  'pr view', // gh pr view <id> (az's equivalent subcommand is `pr show`)
  'pr merge', // gh pr merge <id> (az's equivalent subcommand is `pr update`)
  'pr checks' // gh pr checks <id> (az has no equivalent subcommand at all)
];

const AZURE_TERMS = [
  // az repos pr create/show/update -- gh has no `repos` prefix at all. (`work-item` is Azure
  // vocabulary too, verified directly against AC3's own real argv in its own describe block
  // below, not scanned for here: this scenario's own create/view/merge calls never invoke
  // `repos pr work-item add` at all.)
  'repos pr',
  'sourceRefName', // az's own --query field name (gh's equivalent is headRefName)
  'pull request', // this scenario's own host.change-request-create title input (see header)
  'policy' // this scenario's own host.change-request-create description input (see header)
];

/** Every `toolchain-cli run` call's own stdout, plus the real argv the stub `az` actually
 * received (one joined-with-spaces line per logged call) -- the full real output this scripted
 * scenario produced, never a narrative summary. */
function combinedScenarioOutput(cliResults, azCallsLogPath) {
  const cliText = cliResults.map((r) => r.stdout || '').join('\n');
  const argvText = readCallsLog(azCallsLogPath)
    .map((argv) => argv.join(' '))
    .join('\n');
  return [cliText, argvText].join('\n');
}

// ---------------------------------------------------------------------------
// 1. AC1/AC2 -- push/open/check-status/merge through the Azure DevOps host adapter, stub `az`,
//    no `gh` on PATH, vocabulary scan over the real combined output.
// ---------------------------------------------------------------------------

describe('AC1/AC2: scripted push/open/check-status/merge through adapter-host-azure-devops (stub az, no gh on PATH)', () => {
  const remoteDir = mkThrowawayProjectRoot('host-swap-remote-');
  const project = mkThrowawayProjectRoot('host-swap-project-');
  const binDir = path.join(project, 'bin');

  runGit(['init', '-q', '--bare', remoteDir]);
  runGit(['init', '-q', '-b', BRANCH_NAME], project);
  runGit(['config', 'user.email', 'host-swap-scenario@example.com'], project);
  runGit(['config', 'user.name', 'Host Swap Scenario'], project);
  fs.writeFileSync(path.join(project, 'README.md'), '# host swap scenario fixture\n');
  runGit(['add', 'README.md'], project);
  runGit(['commit', '-q', '-m', 'initial commit'], project);
  runGit(['remote', 'add', 'origin', remoteDir], project);
  // Raw setup push (bypassing the CLI) establishes the upstream tracking branch `git push` (no
  // args, as `workflow.push`'s own run template invokes it) needs to have anything to resolve.
  runGit(['push', '-q', '-u', 'origin', BRANCH_NAME], project);
  // A second, real commit so the CLI's own `workflow.push` call transmits real new data, not
  // merely confirming an already-up-to-date remote.
  fs.writeFileSync(path.join(project, 'CHANGES.md'), 'host swap demo change\n');
  runGit(['add', 'CHANGES.md'], project);
  runGit(['commit', '-q', '-m', 'second commit for workflow.push proof'], project);

  writeToolchainConfig(project, ['host: azure-devops']);
  installHostAzureDevOpsStub(binDir, { prId: '501' });
  const azCallsLogPath = path.join(binDir, 'calls-az.log');

  const PATH = buildPath(binDir);

  test('no gh resolvable on this restricted PATH', () => {
    expectNoGhOnPath(PATH);
  });

  const preflight = runNode(
    TOOLCHAIN_CLI,
    [
      'preflight',
      '--require',
      'workflow.push',
      '--require',
      'host.change-request-create',
      '--require',
      'host.change-request-view',
      '--require',
      'host.change-request-merge',
      '--json'
    ],
    project,
    { PATH }
  );

  test('preflight passes (git + az health checks all pass with the stub)', () => {
    expect(preflight.json && preflight.json.ok).toBe(true);
    expect(typeof preflight.json.runId).toBe('string');
  });

  const runId = preflight.json && preflight.json.runId;

  const push = runNode(TOOLCHAIN_CLI, ['run', 'workflow.push', '--run-id', runId, '--json', '--non-interactive'], project, { PATH });

  test('Implementation AC1(a): workflow.push exits 0 and actually pushes the second commit', () => {
    expect(push.status).toBe(0);
    expect(push.json && push.json.ok).toBe(true);
    const remoteLog = runGit(['log', '--oneline', '-1', BRANCH_NAME], remoteDir);
    expect(remoteLog.stdout).toContain('second commit for workflow.push proof');
  });

  const create = runNode(
    TOOLCHAIN_CLI,
    [
      'run',
      'host.change-request-create',
      '--run-id',
      runId,
      '--arg',
      'baseBranch=main',
      '--arg',
      `headBranch=${BRANCH_NAME}`,
      '--arg',
      'title=Open pull request for host adapter swap demo',
      '--arg',
      'description=Follows repository branch policy requirements for merging.',
      '--json',
      '--non-interactive'
    ],
    project,
    { PATH }
  );

  test('Implementation AC1(b): host.change-request-create exits 0, routes to az, state normalized to "open"', () => {
    expect(create.status).toBe(0);
    expect(create.json && create.json.ok).toBe(true);
    expect(create.json.adapter).toBe('azure-devops');
    expect(create.json.data.id).toBe('501');
    expect(create.json.data.state).toBe('open'); // statusMap: active -> open
    expect(create.json.data.headBranch).toBe(BRANCH_NAME); // trimPrefix stripped refs/heads/
    expect(create.json.data.baseBranch).toBe('main');
  });

  const view = runNode(
    TOOLCHAIN_CLI,
    ['run', 'host.change-request-view', '--run-id', runId, '--arg', `id=${create.json && create.json.data.id}`, '--json', '--non-interactive'],
    project,
    { PATH }
  );

  test('Implementation AC1(c): host.change-request-view ("check status") exits 0 and reports the created PR', () => {
    expect(view.status).toBe(0);
    expect(view.json && view.json.ok).toBe(true);
    expect(view.json.data.id).toBe('501');
    expect(view.json.data.state).toBe('open');
    expect(view.json.data.headBranch).toBe(BRANCH_NAME);
    expect(view.json.data.baseBranch).toBe('main');
  });

  const merge = runNode(
    TOOLCHAIN_CLI,
    ['run', 'host.change-request-merge', '--run-id', runId, '--arg', `id=${create.json && create.json.data.id}`, '--json', '--non-interactive'],
    project,
    { PATH }
  );

  test('Implementation AC1(d): host.change-request-merge exits 0, state normalized to "closed"', () => {
    expect(merge.status).toBe(0);
    expect(merge.json && merge.json.ok).toBe(true);
    expect(merge.json.data.id).toBe('501');
    expect(merge.json.data.state).toBe('closed'); // statusMap: completed -> closed
  });

  test('Implementation AC2: the real argv az received routes through "repos pr", never "pr view"/"pr merge"', () => {
    const calls = readCallsLog(azCallsLogPath).map((argv) => argv.join(' '));
    expect(calls.some((line) => line.startsWith('repos pr create'))).toBe(true);
    expect(calls.some((line) => line.startsWith('repos pr show'))).toBe(true);
    expect(calls.some((line) => line.startsWith('repos pr update'))).toBe(true);
    for (const line of calls) {
      expect(line).not.toContain('pr view');
      expect(line).not.toContain('pr merge');
    }
  });

  test('Implementation AC2: combined scenario output uses Azure DevOps vocabulary, never GitHub-only terms', () => {
    const output = combinedScenarioOutput([push, create, view, merge], azCallsLogPath);
    for (const term of AZURE_TERMS) {
      expect(output).toContain(term);
    }
    for (const term of GITHUB_ONLY_TERMS) {
      expect(output).not.toContain(term);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. AC3 -- host.change-request-link-work-item via config only (host: azure-devops,
//    tracker: azure-boards), no source file changes.
// ---------------------------------------------------------------------------

describe('AC3: host.change-request-link-work-item via config only (host: azure-devops, tracker: azure-boards)', () => {
  const project = mkThrowawayProjectRoot('host-swap-link-');
  const binDir = path.join(project, 'bin');

  // "Using config only" (Implementation AC3): the ONLY change this scenario makes is this one
  // `.ensemble/toolchain.yaml` file inside a throwaway `os.tmpdir()` project -- no file under
  // `REPO_ROOT` (in particular neither `adapter-host-azure-devops/adapter.yaml` nor
  // `adapter-tracker-azure-boards/adapter.yaml`) is ever written by this test.
  writeToolchainConfig(project, ['host: azure-devops', 'tracker: azure-boards']);
  installHostAzureDevOpsStub(binDir, { prId: '501' });
  const azCallsLogPath = path.join(binDir, 'calls-az.log');

  const PATH = buildPath(binDir);

  test('no gh resolvable on this restricted PATH', () => {
    expectNoGhOnPath(PATH);
  });

  const resolve = runNode(TOOLCHAIN_CLI, ['resolve', '--json'], project, { PATH });

  test('config alone resolves BOTH host and tracker to their Azure adapters (no code, no detection)', () => {
    expect(resolve.json && resolve.json.ok).toBe(true);
    expect(resolve.json.data.host).toEqual({ adapter: 'azure-devops', source: 'project' });
    expect(resolve.json.data.tracker).toEqual({ adapter: 'azure-boards', source: 'project' });
  });

  const preflight = runNode(TOOLCHAIN_CLI, ['preflight', '--require', 'host.change-request-link-work-item', '--json'], project, { PATH });
  const runId = preflight.json && preflight.json.runId;

  test('preflight passes for the link capability', () => {
    expect(preflight.json && preflight.json.ok).toBe(true);
  });

  const link = runNode(
    TOOLCHAIN_CLI,
    ['run', 'host.change-request-link-work-item', '--run-id', runId, '--arg', 'id=501', '--arg', 'workItemId=4321', '--json', '--non-interactive'],
    project,
    { PATH }
  );

  test('Implementation AC3: host.change-request-link-work-item exits 0 and reaches az repos pr work-item add', () => {
    expect(link.status).toBe(0);
    expect(link.json && link.json.ok).toBe(true);
    expect(link.json.adapter).toBe('azure-devops');
    expect(typeof link.json.data).toBe('string'); // no `parse` block: raw stdout, per adapter.yaml
    expect(link.json.data).toContain('Linked pull request 501 to work item(s): 4321');

    const calls = readCallsLog(azCallsLogPath);
    const workItemAddCall = calls.find((argv) => argv.join(' ').startsWith('repos pr work-item add'));
    expect(workItemAddCall).toEqual(['repos', 'pr', 'work-item', 'add', '--id', '501', '--work-items', '4321']);
  });
});
