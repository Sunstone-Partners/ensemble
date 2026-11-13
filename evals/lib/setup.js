'use strict';

/**
 * Eval `setup`: argv arrays run in the sandbox project directory after the fixture is copied and committed and before the agent
 * starts (see sandbox.createSandbox for the exact position). Repo-authored and trusted at the same level as the fixture, but guarded
 * against mistakes: no shell, a bare binary name resolved only on absolute PATH entries outside the workspace, the sanitized
 * environment of a check (no credentials, throwaway HOME), no network-capable defaults, bounded time and output, and a re-scan of
 * the resulting tree with the fixture rules.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const envlib = require('./env');
const { scanFixture } = require('./fixture');

const MAX_COMMANDS = 20;
const MAX_ARGS = 50;
const MAX_ARG_LENGTH = 2000;
const COMMAND_TIMEOUT_MS = 60 * 1000;
const TOTAL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024;

// A shell, or a wrapper that runs another program by name, would defeat "no shell, argv execution".
const DENIED_BINARIES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'env', 'xargs', 'sudo', 'su', 'doas', 'eval', 'exec', 'nohup', 'busybox']);
// Network-capable programs are not available to setup (the agent run is where a model could reach one).
const NETWORK_BINARIES = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'rsync', 'gh']);
const NETWORK_GIT_SUBCOMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote', 'remote', 'submodule', 'request-pull', 'fetch-pack', 'send-pack']);
const BINARY_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * Validate an eval's `setup` (array of argv arrays) at load time. Returns a deep copy; throws an Error naming the problem.
 */
function validateSetup(setup) {
  if (!Array.isArray(setup) || setup.length === 0) throw new Error('`setup` must be a non-empty array of argv arrays, for example [["br","init"]]');
  if (setup.length > MAX_COMMANDS) throw new Error(`\`setup\` may hold at most ${MAX_COMMANDS} commands`);
  return setup.map((argv, i) => {
    const where = `\`setup[${i}]\``;
    if (!Array.isArray(argv) || argv.length === 0) throw new Error(`${where} must be a non-empty array of strings (an argv; there is no shell)`);
    if (argv.length > MAX_ARGS) throw new Error(`${where} has more than ${MAX_ARGS} elements`);
    for (const a of argv) {
      if (typeof a !== 'string') throw new Error(`${where} must hold only strings`);
      if (a.length > MAX_ARG_LENGTH) throw new Error(`${where} has an element longer than ${MAX_ARG_LENGTH} characters`);
      if (a.includes('\0')) throw new Error(`${where} has an element containing a NUL byte`);
    }
    const bin = argv[0];
    if (/[/\\]/.test(bin) || path.isAbsolute(bin)) throw new Error(`${where}: the binary must be a bare name resolved on the safe PATH, not a path (got ${JSON.stringify(bin.slice(0, 60))})`);
    if (!BINARY_RE.test(bin)) throw new Error(`${where}: binary name ${JSON.stringify(bin.slice(0, 60))} must match ${BINARY_RE}`);
    if (DENIED_BINARIES.has(bin)) throw new Error(`${where}: \`${bin}\` is a shell or a wrapper that runs other programs; \`setup\` is argv execution only`);
    if (NETWORK_BINARIES.has(bin)) throw new Error(`${where}: \`${bin}\` is network-capable and not allowed in \`setup\``);
    if (bin === 'git') {
      if (argv.length < 2 || argv[1].startsWith('-')) throw new Error(`${where}: \`git\` must be followed by a subcommand (no -c, -C or other leading option)`);
      if (NETWORK_GIT_SUBCOMMANDS.has(argv[1])) throw new Error(`${where}: \`git ${argv[1]}\` can reach a remote and is not allowed in \`setup\``);
    }
    return [...argv];
  });
}

/** PATH entries safe to search: absolute, not `.` or empty (those mean the current directory, which is the fixture), outside `workspace`. */
function safePathEntries(parentPath, workspace) {
  const ws = path.resolve(workspace);
  return String(parentPath || '').split(path.delimiter).filter((d) => {
    if (!d || !path.isAbsolute(d)) return false;
    const r = path.resolve(d);
    return !(r === ws || r.startsWith(ws + path.sep));
  });
}

/** Absolute path of the executable `name` on `entries`, or null. */
function resolveBinary(name, entries) {
  for (const d of entries) {
    const p = path.join(d, name);
    try {
      if (!fs.statSync(p).isFile()) continue;
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* next */ }
  }
  return null;
}

/** Environment for setup commands: a check's (no credentials, throwaway HOME, safe PATH) plus the git lockdown variables. */
function setupEnv({ parentEnv, home, workspace }) {
  const env = envlib.buildEnv({ parent: parentEnv, credentials: [], home });
  env.PATH = safePathEntries(parentEnv.PATH || '/usr/bin:/bin', workspace).join(path.delimiter);
  return {
    ...env, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'false', GIT_ALLOW_PROTOCOL: 'file',
  };
}

const oneLine = (text, n = 160) => envlib.shortReason(text).slice(0, n);

/**
 * Run `commands` in order in `dir`. Stops at the first failure.
 * opts: { root, parentEnv, timeoutMs (per command), totalMs }
 * Returns null on success, else a one-line reason naming the command index and binary.
 */
function runSetup(commands, { dir, home, parentEnv = process.env, timeoutMs = COMMAND_TIMEOUT_MS, totalMs = TOTAL_TIMEOUT_MS }) {
  fs.mkdirSync(home, { recursive: true });
  const env = setupEnv({ parentEnv, home, workspace: dir });
  const entries = env.PATH.split(path.delimiter).filter(Boolean);
  const deadline = Date.now() + totalMs;
  for (let i = 0; i < commands.length; i++) {
    const argv = commands[i];
    const label = `setup[${i}] ${argv[0]}${argv[0] === 'git' ? ` ${argv[1]}` : ''}`;
    const bin = resolveBinary(argv[0], entries);
    if (!bin) return `${label}: \`${argv[0]}\` was not found on the safe PATH`;
    const left = deadline - Date.now();
    if (left <= 0) return `${label}: the setup time budget of ${Math.round(totalMs / 1000)}s was used up`;
    const args = argv[0] === 'git' ? [...envlib.GIT_HARDEN, ...argv.slice(1)] : argv.slice(1);
    const r = spawnSync(bin, args, {
      cwd: dir, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
      timeout: Math.min(timeoutMs, left), killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT_BYTES,
    });
    if (r.error) {
      const code = r.error.code;
      if (code === 'ETIMEDOUT') return `${label}: timed out`;
      if (code === 'ENOBUFS') return `${label}: output exceeded ${MAX_OUTPUT_BYTES} bytes`;
      return `${label}: could not start (${code || oneLine(r.error.message)})`;
    }
    if (r.status !== 0) {
      const tail = oneLine(`${r.stderr || ''} ${r.stdout || ''}`.slice(-400));
      return `${label}: exit ${r.status === null ? `signal ${r.signal}` : r.status}${tail ? `: ${tail}` : ''}`;
    }
  }
  return null;
}

/** Hooks other than git's `.sample` files in the repository at `dir`. */
function planted(dir) {
  const hooks = path.join(dir, '.git', 'hooks');
  if (!fs.existsSync(hooks)) return [];
  return fs.readdirSync(hooks).filter((n) => !n.endsWith('.sample')).map((n) => `.git/hooks/${n}`);
}

/**
 * Re-check the tree after setup with the fixture rules: no `.claude`, `.mcp.json`, `.gitmodules`... anywhere but the repository's own
 * top-level `.git`, no symlink out of the tree, no git hook, and `.git/config` byte-identical to `configBefore`.
 * Returns null when clean, else a reason.
 */
function checkAfterSetup(dir, configBefore) {
  const problems = scanFixture(dir).filter((p) => p.file !== '.git' && !p.file.startsWith(`.git${path.sep}`));
  if (problems.length) return `setup wrote rejected paths: ${problems.map((p) => `${p.file} (${p.reason})`).join('; ')}`;
  const hooks = planted(dir);
  if (hooks.length) return `setup wrote git hooks: ${hooks.join(', ')}`;
  const now = fs.readFileSync(path.join(dir, '.git', 'config'));
  if (!now.equals(configBefore)) return 'setup changed the repository git config (only the sandbox\'s own settings are allowed)';
  return null;
}

module.exports = { validateSetup, runSetup, checkAfterSetup, safePathEntries, resolveBinary, setupEnv, COMMAND_TIMEOUT_MS, TOTAL_TIMEOUT_MS, MAX_OUTPUT_BYTES, MAX_COMMANDS };
