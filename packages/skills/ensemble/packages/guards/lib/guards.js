'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { commandsOf, mentionsGitPush, INERT, MAX_BYTES } = require('./shell');

const DEFAULT_PROTECTED = ['main', 'master', 'production'];
// git global options that take a separate value argument. `--exec-path`, `--html-path`, ... take
// none (their value is only ever `--exec-path=<path>`), so listing them would swallow the subcommand.
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);
// Push options that take a separate value (`--repo`, `--exec`, `--receive-pack` also accept `=`).
// `--signed`, `--force-with-lease`, `--recurse-submodules` only take an attached `=value`.
const PUSH_VALUE_OPTS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
const PUSH_SUBS = new Set(['push', 'send-pack', 'http-push']);

function realOr(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// Config root: CLAUDE_PROJECT_DIR when set and containing the payload cwd, else the
// payload cwd's repository root (git state is evaluated at the payload cwd).
function projectDir(input) {
  const env = process.env.CLAUDE_PROJECT_DIR;
  const cwd = input && typeof input.cwd === 'string' && input.cwd ? input.cwd : null;
  if (!cwd) return env || process.cwd();
  if (env) {
    const rel = path.relative(realOr(env), realOr(cwd));
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return env;
  }
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 3000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : cwd;
}

function loadConfig(dir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, '.ensemble', 'guards.json'), 'utf8'));
    return c && typeof c === 'object' ? c : {};
  } catch { return {}; }
}

function disabled() { return process.env.ENSEMBLE_GUARDS === '0'; }

function ruleOn(cfg, rule) { return !(Array.isArray(cfg.disable) && cfg.disable.includes(rule)); }

function protectedBranches(cfg) {
  return Array.isArray(cfg.protectedBranches) && cfg.protectedBranches.length ? cfg.protectedBranches : DEFAULT_PROTECTED;
}

function currentBranch(dir) {
  const r = spawnSync('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD'], { encoding: 'utf8', timeout: 3000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

// words: ['git', ...]; returns {dir, sub, args} (global options consumed)
function parseGit(words, dir) {
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    const w = words[i];
    if (w === '-C') { dir = path.resolve(dir, words[i + 1] || '.'); i += 2; continue; }
    if (GIT_VALUE_OPTS.has(w)) { i += 2; continue; }
    i++;
  }
  return { dir, sub: words[i], args: words.slice(i + 1), exp: (words.exp || []).slice(i + 1) };
}

const block = (rule, msg) => ({
  rule,
  message: `ensemble-guards [${rule}]: ${msg}\nIf this is intentional, ask the user to approve; they can disable it with {"disable": ["${rule}"]} in .ensemble/guards.json or ENSEMBLE_GUARDS=0.`,
});

// Positional words of a push-like command: [{a, i}] (index into args). With `--repo` the first
// positional is not the remote, so every positional is a refspec.
function pushWords(args) {
  const pos = [];
  let repoOpt = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (PUSH_VALUE_OPTS.has(a)) { if (a === '--repo') repoOpt = true; i++; continue; }
    if (a.startsWith('--repo=')) repoOpt = true;
    if (!a.startsWith('-') || a === '-') pos.push({ a, i });
  }
  return { refs: repoOpt ? pos : pos.slice(1), pos }; // pos[0] is the remote
}

function pushTargets(refWords, cur) {
  if (!refWords.length) return cur ? [cur] : [];
  return refWords.map(({ a: r }) => {
    let dst = r.replace(/^\+/, '');
    if (dst.includes(':')) dst = dst.split(':').pop();
    dst = dst.replace(/^(refs\/)?heads\//, ''); // git also resolves `heads/<b>` to refs/heads/<b>
    return dst === 'HEAD' || dst === '' ? cur : dst;
  }).filter(Boolean);
}

function refExists(dir, ref) {
  const r = spawnSync('git', ['-C', dir, 'show-ref', '--verify', '--quiet', ref], { timeout: 3000 });
  return r.status === 0;
}

// Branch HEAD points at after `git checkout|switch args` in dir.
// undefined = not a branch switch; null = switched but target unknown (fail open); string = branch.
function switchedBranch(sub, args, dir, prot) {
  const valueOpts = sub === 'switch' ? ['-c', '-C', '--create', '--force-create'] : ['-b', '-B'];
  let create = false, detach = false, branch = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (valueOpts.includes(a)) { create = true; branch = args[i + 1] === undefined ? null : args[i + 1]; break; }
    const eq = valueOpts.find((o) => o.startsWith('--') && a.startsWith(o + '='));
    if (eq) { create = true; branch = a.slice(eq.length + 1); break; }
    if (a === '--detach' || a === '-d') { detach = true; continue; }
    if (a === '--orphan') { create = true; branch = args[i + 1] === undefined ? null : args[i + 1]; break; }
    if (a.startsWith('-') && a !== '-') continue;
    if (branch === null) branch = a; // first positional: branch (or start-point/path)
    break;
  }
  if (detach) return null;
  if (branch === null) return undefined;
  if (branch === '-' || /[$`]/.test(branch)) return null; // unknown at parse time
  if (create) return branch;
  if (sub === 'checkout') {
    if (branch.includes(':')) return undefined; // <tree-ish>:path
    if (args.includes('--')) return undefined; // `checkout <tree-ish> -- path`
    const known = prot.includes(branch) || refExists(dir, `refs/heads/${branch}`) ||
      spawnSync('git', ['-C', dir, 'for-each-ref', '--format=x', `refs/remotes/*/${branch}`], { encoding: 'utf8', timeout: 3000 }).stdout.trim() !== '';
    if (!known) return undefined; // path, tag, sha...: not a branch switch
  }
  return branch;
}

function checkBash(command, cfg, cwd) {
  const prot = protectedBranches(cfg);
  let dir = cwd;
  const sim = new Map(); // dir -> simulated branch (null = unknown)
  const branchOf = (d) => (sim.has(d) ? sim.get(d) : currentBranch(d));
  if (command.length > MAX_BYTES && mentionsGitPush(command)) {
    return block('protected-branch', 'command is larger than 1 MB and mentions git push, so it cannot be analyzed and is blocked. Run the git command directly.');
  }
  const cmds = commandsOf(command);
  if (cmds.truncated && /\b(git|br)\b/.test(command) && ruleOn(cfg, 'protected-branch')) {
    return block('protected-branch', 'command nests more than 200 substitutions / `bash -c` / `eval` bodies (or exceeds 1 MB of analyzed text), so it cannot be analyzed and is blocked because it mentions git/br. Split it into simpler commands.');
  }
  if (cmds.unclosed && mentionsGitPush(command) && ruleOn(cfg, 'protected-branch')) {
    return block('protected-branch', 'the command has an unterminated `$(` or backtick and mentions `git push`, so it cannot be analyzed. Fix the quoting or run the git command directly.');
  }
  if ((cmds.opaqueTexts.some(mentionsGitPush) || (cmds.opaqueGlobal && mentionsGitPush(command))) && ruleOn(cfg, 'protected-branch')) {
    return block('protected-branch', 'the command text mentions `git push` and feeds it to a shell/xargs/eval/source through stdin, a pipe, a here-string, a process substitution or an expansion, so it cannot be analyzed. Run the git command directly.');
  }
  for (const w of cmds) {
    const base = w[0].split('/').pop();
    if (base === 'cd' && w[1]) { dir = path.resolve(dir, w[1]); continue; }

    if (base === 'br' && ruleOn(cfg, 'br-close-reason')) {
      const sub = w.slice(1).find((x) => !x.startsWith('-'));
      if (sub === 'close') {
        const rest = w.slice(1);
        let reason = null;
        rest.forEach((x, i) => {
          if (x.startsWith('--reason=')) reason = x.slice(9);
          else if (x.startsWith('--bypass-reason=')) reason = x.slice(16);
          else if (x === '--reason' || x === '-r' || x === '--bypass-reason') reason = rest[i + 1] === undefined ? '' : rest[i + 1];
        });
        if (reason === null || !reason.trim()) {
          return block('br-close-reason', '`br close` requires a non-empty --reason citing evidence (commit, PR, test run). Re-run as: br close <id> --reason "<evidence>".');
        }
      }
      continue;
    }
    if (base !== 'git') {
      // Backstop: `git push` spelled as separate words under another command (`ssh h git push`,
      // `find -exec git push`) is a push we failed to classify; only inert printers and shells
      // whose -c payload was analyzed (trailing words are $0/$1) may carry it.
      const gi = w.indexOf('git');
      if (gi >= 0 && w.indexOf('push', gi + 1) > gi && !INERT.has(base) && !w.shellC && ruleOn(cfg, 'protected-branch')) {
        return block('protected-branch', 'a `git ... push` appears as words of a command that is not git itself, so it cannot be proven not to push a protected branch. Run the git command directly.');
      }
      continue;
    }

    const g = parseGit(w, dir);
    const { sub, args } = g;
    if (ruleOn(cfg, 'bypass-flags')) {
      const long = args.find((a) => a === '--no-verify' || a === '--no-gpg-sign');
      const shortN = sub === 'commit' && args.some((a) => /^-[A-Za-z]*n[A-Za-z]*$/.test(a) && !a.startsWith('--'));
      if (long || shortN) {
        return block('bypass-flags', `git ${sub} with ${long || '-n (--no-verify)'} bypasses hooks/signing. Fix the failing hook or signing problem instead of skipping it.`);
      }
    }
    if (sub === 'checkout' || sub === 'switch') {
      const sb = switchedBranch(sub, args, g.dir, prot);
      if (sb !== undefined) sim.set(g.dir, sb);
      continue;
    }
    if (sub === 'commit' && ruleOn(cfg, 'protected-branch')) {
      const b = branchOf(g.dir);
      if (b && prot.includes(b)) {
        return block('protected-branch', `git commit on protected branch "${b}". Create a feature branch first (git switch -c <name>) and commit there.`);
      }
    }
    if (PUSH_SUBS.has(sub)) {
      const { refs, pos } = pushWords(args);
      // A real expansion ($VAR, ${..}, $(..), backticks) in the remote/refspec cannot be proven
      // not to name a protected branch. Single-quoted / escaped `$` is a literal and is fine.
      const unresolved = pos.filter(({ i }) => g.exp[i]).map(({ a }) => a);
      if (unresolved.length && ruleOn(cfg, 'protected-branch')) {
        return block('protected-branch', `git push target "${unresolved[0]}" contains a shell expansion ($VAR, \${...}, $(...), backticks or a {a,b} / {a..b} brace expression), so it cannot be proven not to be a protected branch. Spell the branch name literally.`);
      }
      const b = branchOf(g.dir);
      const all = args.includes('--all') || args.includes('--mirror');
      const force = args.some((a) => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || a === '--force-if-includes' || /^-[A-Za-z]*f[A-Za-z]*$/.test(a)) ||
        args.some((a) => a.startsWith('+'));
      const hit = all ? ['(all branches)'] : pushTargets(refs, b).filter((t) => prot.includes(t));
      if (hit.length) {
        if (force && ruleOn(cfg, 'force-push')) return block('force-push', `force push to protected branch "${hit[0]}". Never rewrite shared history; push a feature branch and open a PR.`);
        if (ruleOn(cfg, 'protected-branch')) return block('protected-branch', `git ${sub} to protected branch "${hit[0]}". Push a feature branch and open a PR instead.`);
      }
    }
  }
  return null;
}

function readInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return null; }
}

function tail(s, lines = 60, chars = 4000) {
  const t = s.split('\n').slice(-lines).join('\n');
  return t.length > chars ? t.slice(-chars) : t;
}

function checkStop(input, cfg, dir) {
  const dod = cfg.dod;
  if (!dod || typeof dod.command !== 'string' || !dod.command.trim() || !ruleOn(cfg, 'dod')) return null;
  if (input.stop_hook_active === true) return null;
  const sec = Number(dod.timeoutSec) > 0 ? Number(dod.timeoutSec) : 300;
  const r = spawnSync(dod.command, { shell: true, cwd: dir, encoding: 'utf8', timeout: sec * 1000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error && r.error.code !== 'ETIMEDOUT') return null; // could not run at all: fail open
  if (!r.error && r.status === 0) return null;
  const why = r.error ? `timed out after ${sec}s` : `exited ${r.status}`;
  return block('dod', `Definition-of-Done command \`${dod.command}\` ${why}. Fix the failures before finishing.\n--- output tail ---\n${tail((r.stdout || '') + (r.stderr || ''))}`);
}

module.exports = { mentionsGitPush, checkBash, checkStop, loadConfig, readInput, projectDir, disabled };
