'use strict';

/**
 * Harness extension for long, multi-step commands: eval `env`, `setup`, `push.autoSetupRemote` for remote evals, and the
 * `maxTimeoutSec` / `maxRunUsd` ceilings. Runs evals/run.js against a stub `claude` under ~/.omp/trd-skills-eval/jest
 * (never /tmp); no real model, no network.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createSuite, SKILL, PKG_DIR, QUALIFIED } = require('./stub-suite');
const { loadEvalDefs, validateEvalDef, EvalDefinitionError } = require('../lib/eval-def');
const envlib = require('../lib/env');
const setupLib = require('../lib/setup');
const sandbox = require('../lib/sandbox');
const cache = require('../lib/cache');
const exec = require('../lib/exec');
const hash = require('../lib/hash');
const { loadScenarios } = require('../run');

const ARGS = '--repeats 1 --concurrency 1 --model claude-stub-1';
const CMD = `node evals/run.js --skill ${SKILL}`;

let t;
beforeEach(() => { t = createSuite(); });
afterEach(() => t.cleanup());

const q = (l) => `echo '${l.replace(/'/g, "'\\''")}'`;
const initLine = (skills, plugins) => JSON.stringify({ type: 'system', subtype: 'init', skills, plugins, model: 'claude-stub-1' });
const invokeLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: QUALIFIED } }] } });
const resultLine = (text) => JSON.stringify({ type: 'result', num_turns: 1, total_cost_usd: 0.01, result: text });

/**
 * Stub claude: logs one `kind arm argv` line and one `NI=<value of ENSEMBLE_NON_INTERACTIVE>` line per call to calls.log; the agent records
 * the sandbox's push.autoSetupRemote in cfg.txt, sleeps when `sleep` exists next to it, writes SUMMARY.md, and says "done 111".
 */
function writeStub() {
  fs.mkdirSync(t.sub('bin'), { recursive: true });
  t.write(t.sub('bin/claude'), `#!/bin/sh
kind=agent; case "$*" in *stream-json*) ;; *) kind=judge;; esac
arm=baseline; case "$*" in *--plugin-dir*) arm=with-skill;; esac
argv=$(echo "$*" | tr '\\n' ' '); echo "$kind $arm argv=$argv" >> '${t.sub('calls.log')}'
echo "NI=$(printenv ENSEMBLE_NON_INTERACTIVE || echo absent)" >> '${t.sub('calls.log')}'
if [ "$kind" = judge ]; then echo '{"result":"{\\"score\\":0.8,\\"reason\\":\\"ok\\"}","total_cost_usd":0.01}'; exit 0; fi
git config --get push.autoSetupRemote > '${t.sub('cfg.txt')}' 2>/dev/null || echo unset > '${t.sub('cfg.txt')}'
[ -f '${t.sub('sleep')}' ] && sleep 30
[ -f '${t.sub('noresult')}' ] && { echo '{"type":"system","subtype":"init","skills":["verify"],"plugins":[],"model":"claude-stub-1"}'; exit 0; }
case "$arm" in with-skill) echo ok > SUMMARY.md
${q(initLine([QUALIFIED], [{ name: 'ensemble-product', path: PKG_DIR }]))}
${q(invokeLine)}
${q(resultLine('done 111'))};;
*) ${q(initLine(['verify'], []))}
${q(resultLine('done 111'))};;
esac
`);
  fs.chmodSync(t.sub('bin/claude'), 0o755);
}

/** Write eval.json (+ a fixture) with `extra` fields and run it; `args` replaces the default flags. */
function go(extra = {}, { args = ARGS, checks, env } = {}) {
  writeStub();
  fs.mkdirSync(t.sub('scenarios'), { recursive: true });
  t.write(t.sub('skills', SKILL, 'fixture', 'seed.txt'), 'seed\n');
  t.write(t.evalJsonPath, JSON.stringify({
    skill: SKILL, prompt: 'Write a summary of the repo', checks: checks || [{ type: 'fileExists', path: 'SUMMARY.md' }], ...extra,
  }));
  return t.exec(`${CMD} ${args}`, env);
}

const callsText = () => (fs.existsSync(t.sub('calls.log')) ? fs.readFileSync(t.sub('calls.log'), 'utf8') : '');
const agentRuns = (doc) => doc.results[0].runs || [];

// A repo with one shipped skill, for load-time tests that never run anything.
let tmp; let repo; let skillsDir;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-ext-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'packages/demo/skills/demo-skill'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'packages/demo/skills/demo-skill/SKILL.md'), '---\nname: demo-skill\n---\n');
  skillsDir = path.join(tmp, 'skills');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const valid = () => ({ skill: 'demo-skill', prompt: 'Write a summary', checks: [{ type: 'fileExists', path: 'SUMMARY.md' }] });
function loadWith(extra, limits) {
  const dir = path.join(skillsDir, 'demo-skill');
  fs.mkdirSync(path.join(dir, 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'eval.json'), JSON.stringify({ ...valid(), ...extra }));
  return loadEvalDefs({ skillsDir, repoRoot: repo, ...(limits && { limits }) });
}
const rejectedPart = (extra, limits) => { const r = loadWith(extra, limits).rejected[0]; return r && { part: r.error.part, message: r.error.message }; };

describe('eval env: validation', () => {
  test('a valid map is loaded and carried onto the scenario', () => {
    const { evals } = loadWith({ env: { ENSEMBLE_NON_INTERACTIVE: '1', MY_MODE_2: 'a b' } });
    expect(evals[0].env).toEqual({ ENSEMBLE_NON_INTERACTIVE: '1', MY_MODE_2: 'a b' });
    expect(require('../lib/eval-def').evalToScenario(evals[0]).env).toEqual(evals[0].env);
  });

  test.each([
    ['PATH'], ['HOME'], ['LD_PRELOAD'], ['LD_LIBRARY_PATH'], ['DYLD_INSERT_LIBRARIES'], ['NODE_OPTIONS'],
    ['MY_API_KEY'], ['GH_TOKEN'], ['APP_SECRET'], ['DB_PASSWORD'], ['ANTHROPIC_API_KEY'], ['ANTHROPIC_BASE_URL'], ['GIT_SSH_COMMAND'], ['HTTPS_PROXY'], ['TMPDIR'],
  ])('the name %s is rejected at load, naming env', (name) => {
    expect(rejectedPart({ env: { [name]: 'x' } })).toMatchObject({ part: 'env' });
    expect(rejectedPart({ env: { [name]: 'x' } }).message).toMatch(new RegExp(name));
  });

  test('a name on the credential allowlist (any runtime) is rejected', () => {
    const file = t.sub('allow.json');
    fs.writeFileSync(file, JSON.stringify({ credentials: ['ODD_NAME'], runtimes: { pi: ['PIONLY'] } }));
    const names = envlib.allKnownCredentialNames(file);
    expect([...names]).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'ODD_NAME', 'PIONLY']));
    expect(() => envlib.validateAgentEnv({ ODD_NAME: '1' }, names)).toThrow(/credential allowlist/);
    expect(() => envlib.validateAgentEnv({ PIONLY: '1' }, names)).toThrow(/credential allowlist/);
  });

  test.each([
    ['lowercase name', { env: { lower: '1' } }],
    ['name starting with a digit', { env: { '1A': '1' } }],
    ['name with a dash', { env: { 'A-B': '1' } }],
    ['non-string value', { env: { FLAG: 1 } }],
    ['value over 200 characters', { env: { FLAG: 'x'.repeat(201) } }],
    ['newline in a value', { env: { FLAG: 'a\nb' } }],
    ['escape in a value', { env: { FLAG: 'a\u001b[31m' } }],
    ['C1 control in a value', { env: { FLAG: 'a\u009bb' } }],
    ['array', { env: ['A=1'] }],
    ['empty object', { env: {} }],
    ['null', { env: null }],
  ])('%s is rejected', (_name, extra) => {
    expect(rejectedPart(extra)).toMatchObject({ part: 'env' });
  });

  test('a 200 character value is accepted', () => {
    expect(loadWith({ env: { FLAG: 'x'.repeat(200) } }).evals).toHaveLength(1);
  });

  test('applyAgentEnv never overwrites a credential or a base variable', () => {
    expect(() => envlib.applyAgentEnv({ A: '1' }, { A: '2' }, [])).toThrow(/refusing to override/);
    expect(() => envlib.applyAgentEnv({}, { MYCRED: '2' }, ['MYCRED'])).toThrow(/refusing to override/);
    expect(envlib.applyAgentEnv({ PATH: '/x' }, { FLAG: '1' }, [])).toEqual({ PATH: '/x', FLAG: '1' });
  });
});

describe('eval env: reaches the agent only', () => {
  const checks = [
    { type: 'fileExists', path: 'SUMMARY.md' },
    // The check env must not carry the variable: this runs through `sh -c` with the checks' environment.
    { type: 'commandOutputMatches', command: 'printenv ENSEMBLE_NON_INTERACTIVE || echo absent', pattern: '^absent' },
    { type: 'judge', rubric: 'Is the summary clear?' },
  ];

  test('both arms of the agent get it; the check env and the judge do not', () => {
    const r = go({ env: { ENSEMBLE_NON_INTERACTIVE: '1' } }, { args: `${ARGS} --judge-model opus`, checks });
    expect(r.status).toBe(0);
    const lines = callsText().split('\n').filter(Boolean);
    const pairs = [];
    for (let i = 0; i < lines.length; i += 2) pairs.push([lines[i].split(' ').slice(0, 2).join(' '), lines[i + 1]]);
    expect(pairs).toEqual(expect.arrayContaining([['agent with-skill', 'NI=1'], ['agent baseline', 'NI=1'], ['judge baseline', 'NI=absent']]));
    expect(pairs.filter(([k]) => k.startsWith('judge')).every(([, v]) => v === 'NI=absent')).toBe(true);
    expect(pairs.filter(([k]) => k.startsWith('agent')).every(([, v]) => v === 'NI=1')).toBe(true);
    // The check printed `absent`, so the commandOutputMatches check passed (the eval passed).
    expect(r.doc().results[0]).toMatchObject({ pass: true });
  });

  test('without env nothing is added', () => {
    go({}, { args: ARGS });
    expect(callsText()).toMatch(/NI=absent/);
    expect(callsText()).not.toMatch(/NI=1/);
  });

  test('a value like "1" is not a secret: it is not redacted from the transcript, even with a credential set', () => {
    const r = go({ env: { ENSEMBLE_NON_INTERACTIVE: '1' } }, { env: { ANTHROPIC_API_KEY: 'sk-ant-extsecret0123456789' } });
    expect(r.status).toBe(0);
    const text = fs.readFileSync(r.log, 'utf8');
    expect(text).toContain('done 111'); // every "1" survived
    expect(text).not.toContain('[REDACTED]1');
    expect(text).not.toMatch(/\[REDACTED\]\s*11/);
    // Unit: the secrets list is built from credentials only.
    const secrets = envlib.secretValues({ ENSEMBLE_NON_INTERACTIVE: '1', ANTHROPIC_API_KEY: 'sk-ant-x' }, ['ANTHROPIC_API_KEY']);
    expect(secrets).toEqual(['sk-ant-x']);
    expect(envlib.redactText('done 111', secrets)).toBe('done 111');
  });

  test('--allow-env naming a variable the eval sets rejects the eval', () => {
    const r = go({ env: { MY_FLAG: '1' } }, { args: `${ARGS} --allow-env MY_FLAG` });
    expect(r.stderr).toMatch(/REJECTED eval ".*": `env` name MY_FLAG is a credential of this run/);
    expect(callsText()).toBe('');
  });
});

describe('eval setup: validation', () => {
  const bad = (setup) => rejectedPart({ setup });
  test('a valid list is carried onto the scenario', () => {
    const setup = [['br', 'init'], ['git', 'add', '-A'], ['git', 'commit', '-m', 'fixture']];
    const { evals } = loadWith({ setup });
    expect(evals[0].setup).toEqual(setup);
    expect(require('../lib/eval-def').evalToScenario(evals[0]).setup).toEqual(setup);
  });

  test.each([
    ['a string', 'br init'],
    ['an empty list', []],
    ['a command as a string', ['br init']],
    ['an empty argv', [[]]],
    ['a non-string element', [['br', 1]]],
    ['an absolute binary', [['/bin/ls']]],
    ['a relative path binary', [['./run.sh']]],
    ['a path separator in the binary', [['bin/tool']]],
    ['a backslash in the binary', [['bin\\tool']]],
    ['a shell', [['sh', '-c', 'touch x']]],
    ['bash', [['bash', '-c', 'touch x']]],
    ['env', [['env', 'FOO=1', 'ls']]],
    ['a network binary', [['curl', 'http://example.invalid']]],
    ['git fetch', [['git', 'fetch']]],
    ['git clone', [['git', 'clone', 'x']]],
    ['git push', [['git', 'push']]],
    ['git remote', [['git', 'remote', 'add', 'o', 'x']]],
    ['git with a leading option', [['git', '-c', 'core.hooksPath=/x', 'status']]],
    ['bare git', [['git']]],
    ['too many commands', Array.from({ length: 21 }, () => ['true'])],
    ['a NUL byte', [['echo', 'a\0b']]],
  ])('%s is rejected at load, naming setup', (_n, setup) => {
    expect(bad(setup)).toMatchObject({ part: 'setup' });
  });
});

describe('eval setup: argv[0] is a bare name', () => {
  test.each([['/bin/ls'], ['./run.sh'], ['bin/tool'], ['bin\\tool'], ['../x']])('%s is refused as a path, not merely as an odd name', (bin) => {
    expect(rejectedPart({ setup: [[bin]] }).message).toMatch(/must be a bare name resolved on the safe PATH, not a path/);
  });
});

describe('eval setup: run in the sandbox', () => {
  test('commands run in order, in the project dir, before the agent; a setup commit moves the baseline', () => {
    const r = go({
      setup: [['touch', 'one'], ['cp', 'one', 'two'], ['git', 'add', '-A'], ['git', 'commit', '-q', '-m', 'setup'], ['touch', 'three']],
    }, {
      checks: [
        { type: 'fileExists', path: 'one' }, { type: 'fileExists', path: 'two' }, { type: 'fileExists', path: 'three' }, { type: 'fileExists', path: 'seed.txt' },
        // the setup commit is part of the baseline: main has not moved since, even though HEAD is after the fixture commit
        { type: 'noProtectedBranchCommit' },
        // `cp one two` ran after `touch one`; `three` was made after the commit, so it is untracked
        { type: 'commandOutputMatches', command: 'git status --porcelain', pattern: '\\?\\? three', flags: 'm' },
      ],
    });
    expect(r.status).toBe(0);
    expect(r.doc().results[0]).toMatchObject({ pass: true });
  });

  test('the agent never starts when setup fails: an incomplete run with a named reason, never a pass, fail or skip', () => {
    const r = go({ setup: [['true'], ['false'], ['touch', 'never']] });
    expect(callsText()).toBe(''); // stub never called
    const doc = r.doc();
    const runs = agentRuns(doc);
    expect(doc.results[0].outcome).toBe('incomplete');
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run).toMatchObject({ outcome: 'incomplete', pass: null, costUsd: 0 });
      expect(run.incompleteReason).toMatch(/^setup failed: setup\[1\] false: exit 1/);
    }
  });

  test('a missing binary is named', () => {
    const r = go({ setup: [['definitely-not-a-binary-xyz']] });
    expect(agentRuns(r.doc())[0].incompleteReason).toMatch(/setup failed: setup\[0\] definitely-not-a-binary-xyz: `definitely-not-a-binary-xyz` was not found on the safe PATH/);
  });

  test('a setup command that fails shows the start of its error output', () => {
    const r = go({ setup: [['git', 'checkout', 'no-such-branch']] });
    expect(agentRuns(r.doc())[0].incompleteReason).toMatch(/setup\[0\] git checkout: exit \d+: .*no-such-branch/);
  });

  test('setup is not run through a shell: metacharacters are plain arguments', () => {
    const r = go({ setup: [['touch', 'a; touch b'], ['touch', '$(touch c)']] }, {
      checks: [
        { type: 'fileExists', path: 'a; touch b' }, { type: 'fileExists', path: '$(touch c)' },
        { type: 'commandOutputMatches', command: 'ls b c 2>&1 || true', pattern: 'No such file' },
        { type: 'commandOutputMatches', command: 'test ! -e b && test ! -e c && echo clean', pattern: '^clean' },
      ],
    });
    expect(r.doc().results[0]).toMatchObject({ pass: true });
  });

  test('setup gets no credential, a throwaway HOME and no relative PATH entry', () => {
    const dir = t.sub('proj'); fs.mkdirSync(dir);
    const env = setupLib.setupEnv({
      parentEnv: { PATH: `/usr/bin::.:rel:${dir}/bin:/bin`, HOME: '/real/home', ANTHROPIC_API_KEY: 'sk-ant-x', OTHER: 'y', CI: 'true' }, home: t.sub('h'), workspace: dir,
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OTHER).toBeUndefined();
    expect(env.HOME).toBe(t.sub('h'));
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env).toMatchObject({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'false' });
  });

  test('a fixture binary is never resolved: the workspace and relative PATH entries are skipped', () => {
    const dir = t.sub('proj'); fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    const entries = setupLib.safePathEntries(`bin:${path.join(dir, 'bin')}:`, dir);
    expect(entries).toEqual([]);
    expect(setupLib.resolveBinary('tool', entries)).toBeNull();
  });

  test('setup runs with a bounded time: a command that outlives its limit fails the setup', () => {
    const dir = t.sub('b'); fs.mkdirSync(dir);
    const started = Date.now();
    const failure = setupLib.runSetup([['sleep', '20']], { dir, home: t.sub('bh'), timeoutMs: 300 });
    expect(failure).toMatch(/setup\[0\] sleep: timed out/);
    expect(Date.now() - started).toBeLessThan(10000);
  });

  test('setup output is bounded: a command printing more than the cap fails the setup', () => {
    const dir = t.sub('o'); fs.mkdirSync(dir);
    const failure = setupLib.runSetup([['yes']], { dir, home: t.sub('oh'), timeoutMs: 10000 });
    expect(failure).toMatch(/setup\[0\] yes: output exceeded/);
  });

  test('the total time budget is enforced across commands', () => {
    const dir = t.sub('tb'); fs.mkdirSync(dir);
    expect(setupLib.runSetup([['true']], { dir, home: t.sub('tbh'), totalMs: 0 })).toMatch(/time budget/);
  });

  test('a sandbox whose setup fails is returned with setupError and no baseline; cleanup works', () => {
    const scenarioDir = t.sub('sc'); fs.mkdirSync(path.join(scenarioDir, 'fixture'), { recursive: true });
    fs.writeFileSync(path.join(scenarioDir, 'fixture', 'a.txt'), 'a');
    const sb = sandbox.createSandbox(scenarioDir, { setup: [['false']] }, { workdir: t.sub('work') });
    expect(sb.setupError).toMatch(/setup\[0\] false: exit 1/);
    expect(sb.baseline.mainSha).toBeNull();
    sb.cleanup();
    expect(fs.existsSync(sb.root)).toBe(false);
  });
});

describe('eval setup: the resulting tree is held to the fixture rules', () => {
  const reason = (setup) => agentRuns(go({ setup }).doc())[0].incompleteReason;

  test('setup writing .claude/ is rejected, and the agent never starts', () => {
    const r = go({ setup: [['mkdir', '.claude'], ['touch', '.claude/settings.json']] });
    expect(agentRuns(r.doc())[0].incompleteReason).toMatch(/^setup failed: setup wrote rejected paths: \.claude \(/);
    expect(callsText()).toBe('');
  });

  test('a nested .claude, .mcp.json and .gitmodules are rejected too', () => {
    expect(reason([['mkdir', '-p', 'sub/.claude']])).toMatch(/rejected paths: .*\.claude/);
    expect(reason([['touch', '.mcp.json']])).toMatch(/rejected paths: \.mcp\.json/);
    expect(reason([['touch', '.gitmodules']])).toMatch(/rejected paths: \.gitmodules/);
  });

  test('a symlink pointing outside the tree is rejected', () => {
    expect(reason([['ln', '-s', '/etc/passwd', 'pw']])).toMatch(/rejected paths: pw \(symlink points outside/);
  });

  test('a changed git config is rejected', () => {
    expect(reason([['git', 'config', 'core.hooksPath', '/somewhere']])).toMatch(/changed the repository git config/);
    expect(reason([['git', 'config', 'alias.x', '!sh']])).toMatch(/changed the repository git config/);
  });

  test('a planted git hook is rejected', () => {
    expect(reason([['touch', '.git/hooks/pre-commit']])).toMatch(/setup wrote git hooks: \.git\/hooks\/pre-commit/);
  });

  test('a clean setup passes the re-scan (the repository .git itself is not a finding)', () => {
    const dir = t.sub('clean'); fs.mkdirSync(dir);
    spawnSync('git', ['init', '-q'], { cwd: dir });
    expect(setupLib.checkAfterSetup(dir, fs.readFileSync(path.join(dir, '.git', 'config')))).toBeNull();
  });
});

describe('setup git hardening and the eval hash', () => {
  test('git in setup runs with the harness hardening: a planted pre-commit hook does not run', () => {
    const dir = t.sub('hk'); fs.mkdirSync(dir);
    const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...envlib.gitEnv(), GIT_CONFIG_GLOBAL: '/dev/null' } });
    g('init', '-q'); g('config', 'user.email', 'a@b.invalid'); g('config', 'user.name', 'a');
    const marker = t.sub('hook-ran');
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const failure = setupLib.runSetup([['git', 'commit', '-q', '--allow-empty', '-m', 'x']], { dir, home: t.sub('hkh') });
    expect(failure).toBeNull();
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('env and setup are part of the eval hash (eval.json is hashed whole): changing either changes it', () => {
    const dir = path.join(skillsDir, 'h'); fs.mkdirSync(path.join(dir, 'fixture'), { recursive: true });
    const at = (extra) => { fs.writeFileSync(path.join(dir, 'eval.json'), JSON.stringify({ ...valid(), ...extra })); return hash.evalHash(dir); };
    const plain = at({});
    const withEnv = at({ env: { ENSEMBLE_NON_INTERACTIVE: '1' } });
    const otherEnv = at({ env: { ENSEMBLE_NON_INTERACTIVE: '0' } });
    const withSetup = at({ setup: [['touch', 'a']] });
    const otherSetup = at({ setup: [['touch', 'b']] });
    expect(new Set([plain, withEnv, otherEnv, withSetup, otherSetup]).size).toBe(5);
  });
});

describe('remote evals get push.autoSetupRemote', () => {
  const gitCfg = (cwd) => spawnSync('git', ['config', '--local', '--get', 'push.autoSetupRemote'], { cwd, encoding: 'utf8' });
  const scenarioDir = () => { const d = t.sub('sc'); fs.mkdirSync(path.join(d, 'fixture'), { recursive: true }); fs.writeFileSync(path.join(d, 'fixture', 'a.txt'), 'a'); return d; };

  test('set (sandbox-local) when remote is true; unset otherwise', () => {
    const remote = sandbox.createSandbox(scenarioDir(), { remote: true }, { workdir: t.sub('work') });
    expect(gitCfg(remote.dir).stdout.trim()).toBe('true');
    remote.cleanup();
    const plain = sandbox.createSandbox(scenarioDir(), {}, { workdir: t.sub('work') });
    expect(gitCfg(plain.dir).stdout.trim()).toBe('');
    plain.cleanup();
  });

  test('a bare git push of a new branch works against the sandbox origin', () => {
    const sb = sandbox.createSandbox(scenarioDir(), { remote: true, setup: [['touch', 'x']] }, { workdir: t.sub('work') });
    expect(sb.setupError).toBeNull();
    const git = (...a) => spawnSync('git', a, { cwd: sb.dir, encoding: 'utf8', env: { ...envlib.gitEnv(), GIT_CONFIG_GLOBAL: '/dev/null' } });
    expect(git('switch', '-q', '-c', 'feature/x').status).toBe(0);
    const push = git('push', '-q');
    expect(push.status).toBe(0);
    expect(spawnSync('git', ['--git-dir', sb.baseline.remotePath, 'rev-parse', 'refs/heads/feature/x'], { encoding: 'utf8' }).status).toBe(0);
    expect(sb.baseline.remoteMainSha).toMatch(/^[0-9a-f]{40}$/);
    sb.cleanup();
  });

  test('end to end through run.js: the agent sees it only for a remote eval', () => {
    go({ remote: true });
    expect(fs.readFileSync(t.sub('cfg.txt'), 'utf8').trim()).toBe('true');
    t.resetCalls();
    go({});
    expect(fs.readFileSync(t.sub('cfg.txt'), 'utf8').trim()).toBe('unset');
  });
});

describe('ceilings: maxTimeoutSec and maxRunUsd', () => {
  test('limits.json has the long-run ceilings and keeps the defaults', () => {
    expect(exec.loadLimits()).toMatchObject({ timeoutSec: 900, maxTimeoutSec: 7200, runReserveUsd: 5, maxRunUsd: 40 });
  });

  test('without the keys the ceilings equal the defaults (nothing changes); bad ceilings are refused', () => {
    const f = t.sub('limits.json');
    fs.writeFileSync(f, JSON.stringify({ maxUsdPerSuite: 50 }));
    expect(exec.loadLimits(f)).toMatchObject({ timeoutSec: 900, maxTimeoutSec: 900, runReserveUsd: 5, maxRunUsd: 5 });
    fs.writeFileSync(f, JSON.stringify({ maxTimeoutSec: 100 }));
    expect(() => exec.loadLimits(f)).toThrow(/maxTimeoutSec/);
    fs.writeFileSync(f, JSON.stringify({ maxRunUsd: 1 }));
    expect(() => exec.loadLimits(f)).toThrow(/maxRunUsd/);
  });

  test('an eval above the ceiling is rejected at load with a named error; at or below is accepted', () => {
    expect(rejectedPart({ timeoutSec: 7201 })).toMatchObject({ part: 'timeoutSec' });
    expect(rejectedPart({ timeoutSec: 7201 }).message).toMatch(/maxTimeoutSec 7200/);
    expect(rejectedPart({ runUsd: 40.01 })).toMatchObject({ part: 'runUsd' });
    expect(rejectedPart({ runUsd: 40.01 }).message).toMatch(/maxRunUsd 40/);
    expect(rejectedPart({ runUsd: 0 })).toMatchObject({ part: 'runUsd' });
    expect(rejectedPart({ runUsd: '5' })).toMatchObject({ part: 'runUsd' });
    expect(loadWith({ timeoutSec: 7200, runUsd: 40 }).evals[0]).toMatchObject({ timeoutSec: 7200, runUsd: 40 });
    // the ceiling is data: with the default limits an eval cannot ask for more than 900 / $5
    const tight = { ...exec.loadLimits(), maxTimeoutSec: 900, maxRunUsd: 5 };
    expect(rejectedPart({ timeoutSec: 901 }, tight)).toMatchObject({ part: 'timeoutSec' });
    expect(rejectedPart({ runUsd: 5.5 }, tight)).toMatchObject({ part: 'runUsd' });
  });

  test('a rejected definition is an EvalDefinitionError', () => {
    expect(() => validateEvalDef({ ...valid(), timeoutSec: 99999 }, (() => { const d = path.join(skillsDir, 'demo-skill'); fs.mkdirSync(path.join(d, 'fixture'), { recursive: true }); return d; })(), { repoRoot: repo }))
      .toThrow(EvalDefinitionError);
  });

  test('--timeout above maxTimeoutSec is exit 2; at the ceiling it runs', () => {
    const over = go({}, { args: `${ARGS} --timeout 7201` });
    expect(over.status).toBe(2);
    expect(over.stderr).toMatch(/--timeout 7201 exceeds the limit of 7200s/);
    expect(callsText()).toBe('');
    expect(go({}, { args: `${ARGS} --timeout 7200` }).status).toBe(0);
  });

  test('an eval timeoutSec above the old 900 ceiling is honoured end to end, with its budget, and in the cache key and replay', () => {
    const r = go({ timeoutSec: 3600, runUsd: 12 }, { checks: [{ type: 'fileExists', path: 'MISSING.md' }] });
    expect(r.status).toBe(1);
    // the stub saw the eval's budget on the command line, for both arms
    const argvLines = callsText().split('\n').filter((l) => l.startsWith('agent'));
    expect(argvLines).toHaveLength(2);
    for (const l of argvLines) expect(l).toMatch(/--max-budget-usd 12( |$)/);
    // recorded settings carry the effective time limit and budget
    const run0 = agentRuns(r.doc())[0];
    expect(run0).toBeDefined();
    const text = fs.readFileSync(r.log, 'utf8');
    expect(text).toMatch(/"timeoutSec": 3600/);
    expect(text).toMatch(/"runUsd": 12/);
    // the replay command carries both and, run again, reaches the stub with the same budget and is not refused as above the ceiling
    const m = /replay: (node evals\/run\.js .*)/.exec(r.stdout);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/--timeout '?3600'?/);
    expect(m[1]).toMatch(/--run-usd '?12'?/);
    t.resetCalls();
    const again = t.exec(m[1]);
    expect(again.status).not.toBe(2);
    expect(callsText()).toMatch(/agent with-skill argv=.*--max-budget-usd 12( |$)/);
    // cache key: the per-eval budget and time limit are part of it
    const base = { ev: { id: 'e', skill: 's', invocation: 'plain' }, arm: 'with-skill', run: 1, runtime: 'claude', requestedModel: 'm', copy: { skillHash: 'a', packageHash: 'b' }, evalVersion: 'v', timeoutMs: 3600000, runUsd: 12, judgeModel: null };
    expect(cache.keyOf(cache.keyInputs(base))).not.toBe(cache.keyOf(cache.keyInputs({ ...base, runUsd: 13 })));
    expect(cache.keyOf(cache.keyInputs(base))).not.toBe(cache.keyOf(cache.keyInputs({ ...base, timeoutMs: 900000 })));
  });

  test('--run-usd overrides the eval runUsd; the suite cap still bounds it', () => {
    go({ runUsd: 12 }, { args: `${ARGS} --run-usd 3` });
    expect(callsText()).toMatch(/--max-budget-usd 3( |$)/);
    t.resetCalls();
    go({ runUsd: 30 }, { args: `${ARGS} --max-usd 8` });
    expect(callsText()).toMatch(/--max-budget-usd 8( |$)/);
  });

  test('an eval without runUsd keeps the runReserveUsd default of 5', () => {
    go({});
    expect(callsText()).toMatch(/--max-budget-usd 5( |$)/);
  });

  test('the reservation uses the eval budget: with $30 reserved per run under a $50 cap, a run of unknown cost leaves no room for the second arm', () => {
    t.write(t.sub('noresult'), ''); // no result line: no reported cost, so the run is charged its full reservation
    const r = go({ runUsd: 30 }, { args: `${ARGS} --max-usd 50` });
    const agentCalls = callsText().split('\n').filter((l) => l.startsWith('agent'));
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]).toMatch(/--max-budget-usd 30( |$)/);
    expect(r.stdout).toMatch(/cost cap \$50 reached/);
  });

  test('the per-eval budget is in the stored-result key end to end: the same run is reused, a different budget is not', () => {
    const args = `${ARGS} --max-usd 100`;
    go({ runUsd: 30 }, { args });
    expect(callsText()).toMatch(/agent with-skill/);
    t.resetCalls();
    expect(go({ runUsd: 30 }, { args }).stdout).toMatch(/reusing stored result/);
    expect(callsText()).toBe('');
    // --max-usd 8 clamps the per-run budget to 8: a different budget, so a different key, so the stub is called again
    go({ runUsd: 30 }, { args: `${ARGS} --max-usd 8` });
    expect(callsText()).toMatch(/agent \w+(-\w+)? argv=.*--max-budget-usd 8( |$)/);
  });

  test('a legacy scenario may not set env, setup or runUsd (they are validated only for skill evals)', () => {
    const values = { env: { A: '1' }, setup: [['sh', '-c', 'x']], runUsd: 3 };
    for (const [k, v] of Object.entries(values)) {
      const base = t.sub(`legacy-${k}`);
      t.write(path.join(base, 'one', 'scenario.json'), JSON.stringify({ prompt: 'x', graders: [], [k]: v }));
      expect(() => loadScenarios(base)).toThrow(new RegExp(`\`${k}\` is a skill eval field`));
    }
    t.write(t.sub('legacy-ok', 'one', 'scenario.json'), JSON.stringify({ prompt: 'x', graders: [], timeoutSec: 600 }));
    expect(loadScenarios(t.sub('legacy-ok'))).toHaveLength(1);
  });

  test('a legacy scenario stays capped at the 900 s default: only skill evals reach maxTimeoutSec', () => {
    t.write(t.sub('scenarios', 'legacy-long', 'scenario.json'), JSON.stringify({
      type: 'agent', prompt: 'x', plugins: [], timeoutSec: 5000, graders: [{ type: 'fileExists', path: 'MISSING.md' }],
    }));
    writeStub();
    const r = t.exec('node evals/run.js --scenario legacy-long --repeats 1 --model claude-stub-1');
    expect(r.stdout).toMatch(/replay: .*--timeout '?900'?/);
  });

  test('a per-eval timeoutSec below the ceiling is honoured: a sleeping agent times out', () => {
    t.write(t.sub('sleep'), '');
    const r = go({ timeoutSec: 1 });
    expect(r.doc().results[0].runs.some((x) => x.outcome === 'timed_out')).toBe(true);
    expect(r.stdout).toMatch(/TIMED_OUT/);
  });

  test('an eval above the ceiling is rejected at run time with exit 2 and never reaches the stub', () => {
    const r = go({ timeoutSec: 7201 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/REJECTED eval ".*": `timeoutSec` 7201 exceeds the ceiling maxTimeoutSec 7200/);
    expect(callsText()).toBe('');
    const r2 = go({ runUsd: 41 });
    expect(r2.status).toBe(2);
    expect(r2.stderr).toMatch(/`runUsd` 41 exceeds the ceiling maxRunUsd 40/);
    expect(callsText()).toBe('');
  });
});
