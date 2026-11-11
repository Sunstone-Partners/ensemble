'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Deliver stdin from a real file descriptor (not spawnSync's `input` socket):
// on Node 24 the socket stdin intermittently never reaches EOF, leaving the
// hook blocked in fs.readFileSync(0). The timeout turns any residual hang into
// a fast, clearly-labelled failure.
function spawnHook(script, payload, opts) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guards-in-')), 'stdin.json');
  fs.writeFileSync(file, payload);
  const fd = fs.openSync(file, 'r');
  try {
    const r = spawnSync('node', [script], { ...opts, encoding: 'utf8', stdio: [fd, 'pipe', 'pipe'], timeout: 30000 });
    if (r.error) throw new Error(`hook ${path.basename(script)} failed to complete: ${r.error.message}`);
    return r;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

const PRE = path.join(__dirname, '..', 'hooks', 'pre-bash.js');
const STOP = path.join(__dirname, '..', 'hooks', 'stop-gate.js');
let proj;

const git = (...a) => spawnSync('git', ['-C', proj, ...a], { encoding: 'utf8' });
beforeEach(() => {
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'guards-'));
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i');
});
afterEach(() => { fs.rmSync(proj, { recursive: true, force: true }); });

function run(script, input, env = {}) {
  const clean = { ...process.env };
  delete clean.ENSEMBLE_GUARDS;
  delete clean.CLAUDE_PROJECT_DIR;
  return spawnHook(script, typeof input === 'string' ? input : JSON.stringify(input), {
    env: { ...clean, ...env },
    cwd: proj,
  });
}
const bash = (command, env) => run(PRE, { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: proj, tool_input: { command } }, env);
const stop = (extra = {}, env) => run(STOP, { hook_event_name: 'Stop', cwd: proj, stop_hook_active: false, ...extra }, env);
const config = (c) => {
  fs.mkdirSync(path.join(proj, '.ensemble'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.ensemble', 'guards.json'), JSON.stringify(c));
};

describe('git guards', () => {
  test('commit on main blocked with rule + override hint', () => {
    const r = bash('git commit -m x');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/protected-branch/);
    expect(r.stderr).toMatch(/guards\.json/);
  });
  test('commit on feature branch allowed', () => {
    git('switch', '-q', '-c', 'feat/x');
    expect(bash('git commit -m x').status).toBe(0);
  });
  test('git -C dir and cd chains resolve the right repo', () => {
    git('switch', '-q', '-c', 'feat/x');
    expect(bash(`git -C ${proj} commit -m x`).status).toBe(0);
    const main = fs.mkdtempSync(path.join(os.tmpdir(), 'guards-m-'));
    spawnSync('git', ['-C', main, 'init', '-q', '-b', 'main']);
    try {
      expect(bash(`git -C ${main} commit -m x`).status).toBe(2);
      expect(bash(`cd ${main} && git commit -m x`).status).toBe(2);
      expect(bash(`FOO=1 git -C ${main} commit -m x`).status).toBe(2);
    } finally { fs.rmSync(main, { recursive: true, force: true }); }
  });
  test('chained and newline-separated commits are caught', () => {
    expect(bash('git add . && git commit -m x').status).toBe(2);
    expect(bash('echo hi\ngit commit -m x').status).toBe(2);
    expect(bash('true; git commit -m x').status).toBe(2);
  });
  test('push: default on main, explicit main, HEAD:main blocked; feature allowed', () => {
    expect(bash('git push').status).toBe(2);
    expect(bash('git push origin main').status).toBe(2);
    expect(bash('git push origin HEAD:refs/heads/master').status).toBe(2);
    git('switch', '-q', '-c', 'feat/x');
    expect(bash('git push origin feat/x').status).toBe(0);
    expect(bash('git push -u origin HEAD').status).toBe(0);
    expect(bash('git push origin main').status).toBe(2);
  });
  test('force push to protected reports force-push; feature force allowed', () => {
    const r = bash('git push --force origin main');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/force-push/);
    git('switch', '-q', '-c', 'feat/x');
    expect(bash('git push --force-with-lease origin feat/x').status).toBe(0);
  });
  test('--no-verify and --no-gpg-sign blocked even on feature branch', () => {
    git('switch', '-q', '-c', 'feat/x');
    expect(bash('git commit --no-verify -m x').status).toBe(2);
    expect(bash('git commit -nm x').status).toBe(2);
    expect(bash('git commit --no-gpg-sign -m x').status).toBe(2);
    expect(bash('git push --no-verify origin feat/x').status).toBe(2);
  });
  test('quoted mentions do not trigger', () => {
    expect(bash('echo "git commit on main"').status).toBe(0);
    git('switch', '-q', '-c', 'feat/x');
    expect(bash('git commit -m "do not use --no-verify on main"').status).toBe(0);
    expect(bash("git commit -m 'git push origin main'").status).toBe(0);
    expect(bash('git log main').status).toBe(0);
  });
  test('branch switch earlier in the chain is tracked', () => {
    git('switch', '-q', '-c', 'feat/x');
    for (const c of ['git checkout main && git commit -m x', 'git switch main; git commit -m x',
      'git checkout -B main && git push', 'git switch -C main && git push origin HEAD',
      `git -C ${proj} checkout main && git -C ${proj} commit -m x`]) {
      const r = bash(c);
      expect([c, r.status]).toEqual([c, 2]);
      expect(r.stderr).toMatch(/protected-branch/);
    }
    expect(bash('git checkout feat/x && git commit -m x').status).toBe(0);
    expect(bash('git checkout main && git checkout feat/x && git commit -m x').status).toBe(0);
    expect(bash('git checkout main -- . && git commit -m x').status).toBe(0);
    expect(bash('git checkout -b feat/y && git commit -m x').status).toBe(0);
  });
  test('switching away from main before commit is allowed; file checkouts are not switches', () => {
    git('branch', 'feature');
    expect(bash('git checkout feature && git commit -m x').status).toBe(0);
    expect(bash('git switch -c new && git push origin HEAD').status).toBe(0);
    expect(bash('git checkout -- file && git commit -m x').status).toBe(2);
    expect(bash('git checkout HEAD:file && git commit -m x').status).toBe(2);
    expect(bash('git checkout $B && git commit -m x').status).toBe(0);
    expect(bash('echo "git checkout main" && git commit -m x').status).toBe(2);
  });
  test('quoted checkout mention does not switch branch', () => {
    git('switch', '-q', '-c', 'feat/x');
    expect(bash('git commit -m "git checkout main"').status).toBe(0);
  });
  test('config: custom protected branches and disabled rules', () => {
    config({ protectedBranches: ['release'] });
    expect(bash('git commit -m x').status).toBe(0);
    git('switch', '-q', '-c', 'release');
    expect(bash('git commit -m x').status).toBe(2);
    config({ disable: ['protected-branch'] });
    expect(bash('git commit -m x').status).toBe(0);
    expect(bash('git commit --no-verify -m x').status).toBe(2);
  });
});

describe('br close', () => {
  test('without reason blocked; empty reason blocked', () => {
    const r = bash('br close br-1');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/br-close-reason/);
    expect(bash('br close br-1 --reason ""').status).toBe(2);
    expect(bash('br close br-1 --reason').status).toBe(2);
  });
  test('with reason allowed; other br commands allowed', () => {
    expect(bash('br close br-1 --reason "merged in abc123"').status).toBe(0);
    expect(bash('br close br-1 --reason=done').status).toBe(0);
    expect(bash('br close br-1 -r done').status).toBe(0);
    expect(bash('br list').status).toBe(0);
    expect(bash('echo "br close br-1"').status).toBe(0);
  });
  test('--bypass-reason counts as the close justification; reasonless close without id blocked', () => {
    expect(bash('br close abc-1 --bypass-policy --bypass-reason "why"').status).toBe(0);
    expect(bash('br close abc-1 --bypass-policy --bypass-reason=why').status).toBe(0);
    expect(bash('br close abc-1 --bypass-policy --bypass-reason ""').status).toBe(2);
    expect(bash('br close abc-1 --bypass-policy').status).toBe(2);
    expect(bash('br close').status).toBe(2);
    expect(bash('br close --json').status).toBe(2);
    expect(bash('br close --reason "x"').status).toBe(0);
  });
});

describe('expansions in push targets and substitution bodies', () => {
  test.each([
    'git push origin $(echo main)',
    'git push origin ${B}',
    'git push origin $B',
    'git push origin `echo main`',
    'git push origin HEAD:$(echo main)',
    'git push $R main',
    'echo $(git push origin main)',
    'echo `git push origin main`',
    'echo "$(git push origin main)"',
  ])('blocked: %s', (c) => {
    git('switch', '-q', '-c', 'feat/x');
    const r = bash(c);
    expect([c, r.status]).toEqual([c, 2]);
    expect(r.stderr).toMatch(/protected-branch/);
  });
  test('expansion block message is actionable and honors the rule switch', () => {
    git('switch', '-q', '-c', 'feat/x');
    expect(bash('git push origin $B').stderr).toMatch(/literally/);
    config({ disable: ['protected-branch'] });
    expect(bash('git push origin $B').status).toBe(0);
  });
  test('literal feature pushes and substitutions without push still allowed', () => {
    git('switch', '-q', '-c', 'feat/x');
    expect(bash('git push origin feat/x').status).toBe(0);
    expect(bash('echo $(git status)').status).toBe(0);
    expect(bash('git commit -m "$(date)"').status).toBe(0);
  });
  const nest = (n, inner) => { let s = inner; for (let i = 0; i < n; i++) s = `echo "$(${s})"`; return s; };
  test.each([3, 6, 7, 20, 250, 3000])('deeply nested substitution push is blocked (depth %i)', (n) => {
    git('switch', '-q', '-c', 'feat/x');
    const deep = nest(n, 'git push origin feat/x:main');
    for (const c of [deep, `true ${deep}`, `bash -c '${deep.replace(/'/g, "'\\''")}'`, `eval ${JSON.stringify(deep)}`, `cat <<EOF | bash\n${deep}\nEOF`]) {
      const r = bash(c);
      expect([n, c.slice(0, 20), r.status]).toEqual([n, c.slice(0, 20), 2]);
    }
  });
  test('nested bash -c / eval levels beyond the old depth limit are analyzed', () => {
    git('switch', '-q', '-c', 'feat/x');
    let s = 'git push origin main';
    for (let i = 0; i < 6; i++) s = `bash -c ${JSON.stringify(s)}`;
    expect(bash(s).status).toBe(2);
    let e = 'git push origin main';
    for (let i = 0; i < 6; i++) e = `eval ${JSON.stringify(e)}`;
    expect(bash(e).status).toBe(2);
  });
  test('deep nesting without git is not blocked', () => {
    expect(bash(nest(250, 'date')).status).toBe(0);
  });
  test('single-quoted or escaped $ in a push target is a literal branch name', () => {
    git('switch', '-q', '-c', 'feat/x');
    expect(bash("git push origin 'feat/x$SUF'").status).toBe(0);
    expect(bash("git push origin 'release/1.0$'").status).toBe(0);
    expect(bash('git push origin feat/x\\$SUF').status).toBe(0);
    expect(bash('git push origin "feat/x\\$SUF"').status).toBe(0);
    expect(bash("echo '$(git push origin main)'").status).toBe(0);
    expect(bash('git push origin feat/x$').status).toBe(0);
    expect(bash('git push origin "feat/x$SUF"').status).toBe(2);
    expect(bash('git push origin feat/x$SUF').status).toBe(2);
    expect(bash("git push origin $'main'").status).toBe(2);
  });
  test('abbreviated heads/<branch> destination hits the protected branch', () => {
    git('switch', '-q', '-c', 'feat/x');
    for (const c of ['git push origin HEAD:heads/main', 'git push origin feat/x:heads/main', 'git push origin :heads/main', 'git push origin heads/main', 'git push --force origin HEAD:heads/main']) {
      const r = bash(c);
      expect([c, r.status]).toEqual([c, 2]);
    }
    expect(bash('git push origin feat/x:heads/feat/y').status).toBe(0);
    expect(bash('git push origin v1.2.3 origin/main').status).toBe(0);
  });
  test('sh -c with unquoted payload runs bare git (not a push); quoted forms are blocked', () => {
    git('switch', '-q', '-c', 'feat/x');
    expect(bash('sh -c git push origin main').status).toBe(0);
    expect(bash("sh -c 'git push origin main'").status).toBe(2);
    expect(bash('bash -c "git push origin main"').status).toBe(2);
  });
});

describe('config resolution from payload cwd', () => {
  test('config in payload repo applies when hook process cwd and env point elsewhere', () => {
    config({ protectedBranches: ['release'] });
    git('switch', '-q', '-c', 'release');
    const sub = path.join(proj, 'nested');
    fs.mkdirSync(sub);
    const clean = { ...process.env };
    delete clean.ENSEMBLE_GUARDS;
    delete clean.CLAUDE_PROJECT_DIR;
    const hook = (cwd, env = {}) => spawnHook(PRE,
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command: 'git commit -m x' } }),
      { env: { ...clean, ...env }, cwd: '/' });
    expect(hook(proj).status).toBe(2);
    expect(hook(sub).status).toBe(2); // repo root found from a subdirectory
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'guards-o-'));
    try {
      expect(hook(proj, { CLAUDE_PROJECT_DIR: other }).status).toBe(2); // env does not contain payload cwd
      expect(hook(proj, { CLAUDE_PROJECT_DIR: proj }).status).toBe(2);
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  });
});

describe('stop gate', () => {
  test('disabled by default', () => {
    expect(stop().status).toBe(0);
  });
  test('blocks on failing command with output tail', () => {
    config({ dod: { command: 'echo boom-marker; exit 3', timeoutSec: 20 } });
    const r = stop();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/boom-marker/);
  });
  test('SubagentStop event also gated; passing command allows', () => {
    config({ dod: { command: 'exit 0' } });
    expect(stop({ hook_event_name: 'SubagentStop' }).status).toBe(0);
    config({ dod: { command: 'exit 1' } });
    expect(stop({ hook_event_name: 'SubagentStop' }).status).toBe(2);
  });
  test('allows when stop_hook_active', () => {
    config({ dod: { command: 'exit 1' } });
    expect(stop({ stop_hook_active: true }).status).toBe(0);
  });
  test('timeout blocks; dod rule can be disabled', () => {
    config({ dod: { command: 'sleep 5', timeoutSec: 1 } });
    expect(stop().status).toBe(2);
    config({ dod: { command: 'exit 1' }, disable: ['dod'] });
    expect(stop().status).toBe(0);
  });
});

describe('fail open / kill switch', () => {
  test('malformed stdin exits 0', () => {
    expect(run(PRE, 'not json{').status).toBe(0);
    expect(run(STOP, '').status).toBe(0);
    expect(run(PRE, { tool_input: { command: 42 } }).status).toBe(0);
  });
  test('malformed config fails open to defaults without crashing', () => {
    fs.mkdirSync(path.join(proj, '.ensemble'));
    fs.writeFileSync(path.join(proj, '.ensemble', 'guards.json'), '{bad');
    expect(bash('git commit -m x').status).toBe(2);
  });
  test('ENSEMBLE_GUARDS=0 disables everything', () => {
    config({ dod: { command: 'exit 1' } });
    expect(bash('git commit -m x', { ENSEMBLE_GUARDS: '0' }).status).toBe(0);
    expect(bash('br close x', { ENSEMBLE_GUARDS: '0' }).status).toBe(0);
    expect(stop({}, { ENSEMBLE_GUARDS: '0' }).status).toBe(0);
  });
});

describe('fail-closed push-adjacent text', () => {
  const PUSH = 'git push origin HEAD:refs/heads/main';
  beforeEach(() => { git('switch', '-q', '-c', 'feat/x'); });

  test.each([
    `for i in 1; do ${PUSH}; done`,
    `if true; then ${PUSH}; fi`,
    `while :; do ${PUSH}; break; done`,
    `until false; do ${PUSH}; break; done`,
    `if false; then :; else ${PUSH}; fi`,
    `! ${PUSH}`,
    `{ ${PUSH}; }`,
    `f(){ ${PUSH}; }; f`,
    `f () { ${PUSH}; }; f`,
    `function f { ${PUSH}; }; f`,
    `bash -c 'for i in 1; do ${PUSH}; done'`,
    `bash -c '{ ${PUSH}; }'`,
    `time ${PUSH}`,
  ])('control flow / grouping / function bodies are analyzed: %s', (c) => {
    const r = bash(c);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/protected-branch/);
  });

  test.each([
    `bash -c -- "${PUSH}"`,
    `bash -e -c "${PUSH}"`,
    `bash -x -c "${PUSH}"`,
    `bash -O extglob -c "${PUSH}"`,
    `bash +O extglob -c "${PUSH}"`,
    `bash --norc -c "${PUSH}"`,
    `bash --login -c "${PUSH}"`,
    `bash -o pipefail -c "${PUSH}"`,
    `dash -c "${PUSH}"`,
    `ksh -c "${PUSH}"`,
  ])('shell -c option forms reach the script word: %s', (c) => {
    expect(bash(c).status).toBe(2);
  });

  test.each([
    'git --exec-path push origin main',
    'git --html-path push origin main',
    'git --no-pager push origin main',
    'git -p push origin main',
    'git --bare push origin main',
    'git --exec-path=/x push origin main',
    'git -c a=b push origin main',
    'git --git-dir x push origin main',
    'git --config-env a=B push origin main',
  ])('git global options: %s', (c) => {
    expect(bash(c).status).toBe(2);
  });

  test.each([
    'git push origin {main,x}',
    'git push origin {main,}',
    'git push origin ma{in,}',
    'git push origin {a..b}',
    'git push origin {x,y,main}',
    'git push origin "{a,"{main,x}',
  ])('brace expansion in push refs is unresolved: %s', (c) => {
    const r = bash(c);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/protected-branch/);
  });

  test.each([
    `echo "${PUSH}" | xargs -I@ sh -c @`,
    `echo '${PUSH}' | sh`,
    `echo '${PUSH}' | bash`,
    `printf '${PUSH}' | bash -s`,
    `sh <<< "${PUSH}"`,
    `bash <(echo '${PUSH}')`,
    `x='${PUSH}'; eval "$x"`,
    `x='${PUSH}'; sh -c "$x"`,
    `echo '${PUSH}' | env sh`,
    `echo '${PUSH}' | sudo -u root bash`,
    `source <(echo '${PUSH}')`,
    `echo '${PUSH}' | zsh`,
  ])('opaque input to an interpreter that mentions git push: %s', (c) => {
    const r = bash(c);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/protected-branch/);
  });

  test.each([
    'timeout 5 git push origin main',
    'ssh host git push origin main',
    'find . -exec git push origin main ;',
    'sudo -u root git push origin main',
    'nice -n 5 git push origin main',
  ])('backstop: git ... push as words of another command: %s', (c) => {
    expect(bash(c).status).toBe(2);
  });

  test('escaped bash -c nesting does not exhaust memory; hook still gives a verdict', () => {
    let cmd = `${PUSH}`;
    for (let i = 0; i < 22; i++) cmd = `bash -c "${cmd.replace(/[\\"$`]/g, '\\$&')}"`;
    const t = Date.now();
    const r = bash(cmd);
    expect(r.status).toBe(2);
    expect(Date.now() - t).toBeLessThan(5000);
  });
  test('moderately nested escaped payload over the byte budget is blocked', () => {
    let cmd = `${PUSH}`;
    for (let i = 0; i < 16; i++) cmd = `bash -c "${cmd.replace(/[\\"$`]/g, '\\$&')}"`;
    expect(cmd.length).toBeLessThan(1 << 20);
    expect(bash(cmd).status).toBe(2);
  });

  test.each([
    'git push origin feat/x',
    'git push -u origin HEAD',
    'git push origin feat/x:feat/y',
    "git push origin 'feat/x$SUF'",
    "git push origin 'feat/{a,b}'",
    'git push origin v1.2.3',
    'git commit -m "docs: mention git push in README"',
    'echo "git push origin main"',
    'echo git push origin main',
    'grep -rn "git push" docs/',
    'man git-push',
    'bash script.sh',
    "bash -c 'echo hi'",
    "sh -c 'ls | wc -l'",
    'for f in *.js; do echo $f; done',
    'if [ -f x ]; then cat x; fi',
    'git status && git log --oneline | head',
    'xargs -n1 echo < list.txt',
    'npm test',
    'git checkout main',
    'echo hi -',
    'git --exec-path',
    'git --no-pager log --oneline',
  ])('stays allowed: %s', (c) => {
    expect(bash(c).status).toBe(0);
  });
});

describe('round 4: wrappers, plumbing, scoping, linearity', () => {
  const FM = 'git push origin feat:main';
  beforeEach(() => { git('switch', '-q', '-c', 'feat/x'); });

  test.each([
    `timeout 5 bash -c "${FM}"`,
    `nice bash -c "${FM}"`,
    `ionice -c 3 bash -c "${FM}"`,
    `stdbuf -oL bash -c "${FM}"`,
    `setsid bash -c "${FM}"`,
    `caffeinate -i bash -c "${FM}"`,
    `script -q /dev/null bash -c "${FM}"`,
    `echo hi; timeout 5 bash -c "${FM}"`,
    `for i in 1; do timeout 5 bash -c "${FM}"; done`,
    `f(){ timeout 5 bash -c "${FM}"; }; f`,
    `bash -c "timeout 5 bash -c \\"${FM}\\""`,
    `timeout 5 bash -c "eval git push origin feat:main"`,
    `timeout -k 2 10 git push origin main`,
    `nice -n 5 bash -c "${FM}"`,
    `watch "git push origin main"`,
    `ssh host "git push origin main"`,
    `env -i bash -c "${FM}"`,
  ])('wrapped shell payload is analyzed: %s', (c) => {
    expect(bash(c).status).toBe(2);
  });

  test('positional args after a -c payload are not executed', () => {
    expect(bash('timeout 5 bash -c "echo hello" git push origin feat:main').status).toBe(0);
    expect(bash('timeout 5 git push origin feat/x').status).toBe(0);
    expect(bash('ssh host "git push origin feat/x"').status).toBe(0);
  });

  test.each([
    'git send-pack file:///tmp/x.git feat:main',
    'git send-pack --force file:///tmp/x.git feat:main',
    'git http-push http://h/x.git feat:main',
    'git send-pack --all file:///tmp/x.git',
    'git send-pack file:///tmp/x.git main',
  ])('push plumbing is guarded: %s', (c) => {
    expect(bash(c).status).toBe(2);
  });
  test('push plumbing to a feature ref is allowed', () => {
    expect(bash('git send-pack file:///tmp/x.git feat:topic').status).toBe(0);
  });

  test.each([
    ['unquoted', '$( ', 2],
    ['quoted', 'echo "$( ', 2],
    ['backtick', '` ', 2],
    ['braces', '{a, ', 0],
  ])('unbalanced substitutions are linear: %s', (_n, unit, withPush) => {
    const text = unit.repeat(Math.ceil(400000 / unit.length));
    const t = Date.now();
    expect(bash(text).status).toBe(0);
    expect(Date.now() - t).toBeLessThan(1500);
    const t2 = Date.now();
    expect(bash(`${text}\ngit push origin feat/x`).status).toBe(withPush);
    expect(Date.now() - t2).toBeLessThan(1500);
  });

  test.each([
    'git push origin --repo=https://github.com/o/r.git feat:topic',
    'git push origin --repo https://github.com/o/r.git feat:topic',
    'git push -o ci.skip origin feat/x',
    'git push --push-option=x origin feat/x',
    'git push --force-with-lease origin feat/x',
    'git push --signed=if-asked origin feat/x',
    'git push --recurse-submodules=check origin feat/x',
    'git push --receive-pack=/usr/bin/git-receive-pack origin feat/x',
    'git push --dry-run origin feature',
    'git stash push -m x',
  ])('push options with values are skipped: %s', (c) => {
    expect(bash(c).status).toBe(0);
  });
  test.each([
    'git push --repo=origin main',
    'git push --repo origin main',
    'git push -o ci.skip origin main',
    'git push -o x origin HEAD:main',
  ])('push option handling still blocks protected refs: %s', (c) => {
    expect(bash(c).status).toBe(2);
  });

  test.each([
    'printf "%s\\n" "docs mention git push in the changelog" | xargs -a /dev/null wc -l',
    'echo "git push origin main" > notes.md; xargs --version',
    'echo "git push origin main" | xargs wc -l',
    'echo "git push origin main" | xargs -n1 echo',
    'cat notes | xargs grep "git push"',
    'echo "git push" | xargs -I{} echo {}',
  ])('opaque gate is scoped: %s', (c) => {
    expect(bash(c).status).toBe(0);
  });
  test.each([
    'echo "git push origin main" | xargs sh -c @',
    'echo "git push origin feat/x" | xargs bash -c @',
    'echo "git push origin feat/x" | xargs git',
    'echo "git push origin feat/x" | xargs -I@ sh -c @',
    'echo "git push origin main" | tee x | sh',
  ])('opaque gate still blocks real consumers: %s', (c) => {
    expect(bash(c).status).toBe(2);
  });

  test.each([
    'timeout 30 npm test',
    "ssh dev 'ls'",
    "find . -name '*.js' -exec grep -l git {} +",
    'git log --oneline | xargs -I{} echo {}',
    'git stash push -m x',
    'git push --dry-run origin feature',
    'mkdir -p src/{a,b}',
    'cp f{,.bak}',
    'echo {1..3}',
    'eval "$(ssh-agent -s)"',
    'source .env',
    '. ./venv/bin/activate',
    'for f in *.md; do git add $f; done',
    'gh pr create',
  ])('everyday command stays allowed: %s', (c) => {
    expect(bash(c).status).toBe(0);
  });

  test('malformed guards.json falls back to default protected branches', () => {
    fs.mkdirSync(path.join(proj, '.ensemble'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.ensemble', 'guards.json'), '{not json');
    expect(bash('git push origin main').status).toBe(2);
    fs.writeFileSync(path.join(proj, '.ensemble', 'guards.json'), '[1,2]');
    expect(bash('git push origin main').status).toBe(2);
  });

  test('mentionsGitPush is one shared predicate', () => {
    const { mentionsGitPush } = require('../lib/guards');
    expect(mentionsGitPush('foo git -C x push origin')).toBe(true);
    expect(mentionsGitPush('git status')).toBe(false);
    expect(mentionsGitPush('git-push and github push')).toBe(false);
    expect(mentionsGitPush('git '.repeat(100000))).toBe(false);
  });
});
