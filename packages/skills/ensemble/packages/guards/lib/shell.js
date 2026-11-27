'use strict';
// Minimal shell splitter: commands on && || ; | & newline outside quotes; words with quotes removed.

// Index of the char that closes the substitution opening at src[i] ('$(' -> ')', '`' -> '`'), or -1.
function substitutionEnd(src, i) {
  if (src[i] === '`') {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === '`') return j;
    }
    return -1;
  }
  let depth = 1;
  let q = null;
  for (let j = i + 2; j < src.length; j++) {
    const c = src[j];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === '\\') { j++; continue; }
    if (q === '"') { if (c === '"') q = null; continue; }
    if (c === "'" || c === '"') q = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return -1;
}

// `subs` (optional) collects the bodies of $(...) / `...` substitutions; the raw
// substitution text stays part of its enclosing word. Each returned command array carries
// `.exp`: per word, true when it contains a real shell expansion ($VAR, ${..}, $(..), `..`,
// $'..', $"..") outside single quotes / backslash escapes.
const EXP_NEXT = /[A-Za-z0-9_{(@*#?!$'"]/;
// An unquoted `{a,b}` / `{a..b}` brace expression expands to several words in bash.
// First `{` followed (anywhere after it) by `,` or `..`; linear, deliberately loose.
function hasBraceExpr(s) {
  const b = s.indexOf('{');
  return b >= 0 && (s.indexOf(',', b) >= 0 || s.indexOf('..', b) >= 0);
}
function splitCommands(src, subs = []) {
  const cmds = [];
  let words = [];
  let wexp = [];
  let cur = '';
  let unq = ''; // unquoted, unescaped text of the current word (brace-expansion detection)
  let has = false; // current word started (allows empty quoted words)
  let exp = false;
  let q = null;
  let seg = 0; // pipeline / command-list segment; `|` and process substitution keep it, others bump it
  let unclosed = false;
  let noParen = false; // an unclosed `$(` / backtick was seen: later ones cannot close either (keeps the scan linear)
  let noTick = false;
  const subEnd = (i) => {
    const tick = src[i] === '`';
    if (tick ? noTick : noParen) return -1;
    const end = substitutionEnd(src, i);
    if (end < 0) { unclosed = true; if (tick) noTick = true; else noParen = true; }
    return end;
  };
  const endWord = () => {
    if (has) { words.push(cur); wexp.push(exp || hasBraceExpr(unq)); }
    cur = ''; unq = ''; has = false; exp = false;
  };
  const endCmd = () => { endWord(); if (words.length) { words.exp = wexp; words.seg = seg; cmds.push(words); } words = []; wexp = []; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === '\\' && i + 1 < src.length) { cur += src[++i]; }
      else if (c === '`' || (c === '$' && src[i + 1] === '(')) {
        exp = true;
        const end = subEnd(i);
        if (end >= 0) {
          subs.push(src.slice(i + (c === '`' ? 1 : 2), end));
          cur += src.slice(i, end + 1); i = end;
        } else cur += c;
      } else {
        if (c === '$' && i + 1 < src.length && src[i + 1] !== '"' && EXP_NEXT.test(src[i + 1])) exp = true;
        cur += c;
      }
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '\\') { if (i + 1 < src.length) { cur += src[++i]; has = true; } continue; }
    if (c === '`' || (c === '$' && src[i + 1] === '(')) {
      exp = true;
      const end = subEnd(i);
      if (end >= 0) {
        subs.push(src.slice(i + (c === '`' ? 1 : 2), end));
        cur += src.slice(i, end + 1); has = true; i = end; continue;
      }
    }
    if (c === '$' && i + 1 < src.length && EXP_NEXT.test(src[i + 1])) exp = true;
    if (c === '#' && !has) { while (i < src.length && src[i] !== '\n') i++; endCmd(); continue; }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    if (c === '\n' || c === '\r' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '`') {
      // '>&' / '2>&1' style redirects are not command separators
      if (c === '&' && (src[i - 1] === '>' || src[i - 1] === '<')) { cur += c; has = true; continue; }
      endCmd();
      const pipe = (c === '|' && src[i + 1] !== '|' && src[i - 1] !== '|') || (c === '&' && src[i - 1] === '|') ||
        (c === '(' && (src[i - 1] === '<' || src[i - 1] === '>'));
      if (!pipe) seg++;
      continue;
    }
    cur += c; unq += c; has = true;
  }
  endCmd();
  cmds.unclosed = unclosed;
  return cmds;
}

const WRAPPERS = new Set(['env', 'command', 'sudo', 'time', 'nohup', 'exec', 'builtin']);
// Wrappers that run their trailing operands as a command: `val` options take a separate value,
// `pos` leading positional operands (timeout's DURATION, script's FILE) precede the command.
const WRAP_OPS = {
  timeout: { val: ['-k', '-s', '--kill-after', '--signal'], pos: 1 },
  nice: { val: ['-n', '--adjustment'], pos: 0 },
  ionice: { val: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata'], pos: 0 },
  stdbuf: { val: ['-i', '-o', '-e', '--input', '--output', '--error'], pos: 0 },
  setsid: { val: [], pos: 0 },
  watch: { val: ['-n', '--interval'], pos: 0 },
  caffeinate: { val: ['-t', '-w'], pos: 0 },
  chronic: { val: [], pos: 0 },
  unbuffer: { val: [], pos: 0 },
  script: { val: ['-t', '-c', '-I', '-O', '-B', '-E', '-T', '-m'], pos: 1 },
};
// Reserved words / grouping tokens that can precede a simple command (`do git push`, `{ git push`).
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}']);
const INTERPRETERS = /^(bash|sh|zsh|dash|ksh)$/;
// Commands that only print / search their arguments: `git push` as their words is just text.
const INERT = new Set(['echo', 'printf', 'man', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'cat', 'less', 'more', 'bat', 'head', 'tail', 'wc', 'which', 'type', 'whatis', 'apropos', 'tldr', 'help']);
// `xargs` targets that cannot run git/a shell: input piped into them is data, not code.
const XARGS_SAFE = new Set(['wc', 'grep', 'egrep', 'fgrep', 'rg', 'echo', 'printf', 'cat', 'head', 'tail', 'sort', 'uniq', 'ls', 'tr', 'cut', 'basename', 'dirname', 'file', 'stat', 'du', 'touch', 'rm', 'mv', 'cp', 'chmod', 'chown', 'mkdir']);
const XARGS_VAL = new Set(['-I', '-n', '-P', '-L', '-s', '-a', '-d', '-E', '-R', '-S', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-lines', '--max-chars', '--eof', '--process-slot-var']);

// `git` as a word, later `push` as a word (not git-push, .git/, github, ...). Linear: first
// `git`, then one scan for `push` after it.
const GIT_WORD = /(?<![\w./-])git(?![\w-])/;
const PUSH_WORD = /(?<![\w.-])push(?![\w-])/;
function mentionsGitPush(text) {
  const m = GIT_WORD.exec(text);
  return !!m && PUSH_WORD.test(text.slice(m.index + 3));
}

// Index just past a wrapper's own options / operands, starting at the wrapper word words[i].
function skipWrapper(words, i) {
  const spec = WRAP_OPS[words[i]];
  let j = i + 1;
  while (j < words.length) {
    const x = words[j];
    if (x === '--') { j++; break; }
    if (spec.val.includes(x)) { j += 2; continue; }
    if (x.length > 1 && x.startsWith('-')) { j++; continue; }
    break;
  }
  return Math.min(words.length, j + spec.pos);
}

// Strip leading VAR=val, wrapper words, reserved words and function-definition prefixes
// (`function f {`), so the underlying simple command is what gets classified.
function stripPrefix(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (Object.prototype.hasOwnProperty.call(WRAP_OPS, w)) i = skipWrapper(words, i);
    else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(w) || RESERVED.has(w)) i++;
    else if (w === 'function') i += 2;
    else break;
  }
  // Leftover wrapper options (`sudo -u x git push`, `env -i sh`): resume at the first word that
  // is a command we analyze.
  if (i < words.length && words[i].startsWith('-')) {
    const j = words.findIndex((x, k) => k > i && /^(git|br|eval|xargs|bash|sh|zsh|dash|ksh)$/.test(x.split('/').pop()));
    if (j > i) i = j;
  }
  const out = words.slice(i);
  if (words.exp) out.exp = words.exp.slice(i);
  out.seg = words.seg;
  return out;
}

// Max substitution / `bash -c` / `eval` bodies, and cumulative bytes of analyzed text, per
// command. Beyond either the result is flagged `truncated` and callers MUST fail closed.
const MAX_NODES = 200;
const MAX_BYTES = 1 << 20;

// Where the script word of `bash [options] ...` (shell word at w[from]) is:
// {c: -c given, s: -s given, idx: first positional}.
function shellArgs(w, from = 0) {
  let c = false, s = false, i = from + 1;
  for (; i < w.length; i++) {
    const x = w[i];
    if (x === '--') { i++; break; }
    if (/^[-+][Oo]$/.test(x) || x === '--rcfile' || x === '--init-file') { i++; continue; }
    if (/^[-+][A-Za-z]+$/.test(x)) {
      if (x[0] === '-' && x.includes('c')) c = true;
      if (x[0] === '-' && x.includes('s')) s = true;
      continue;
    }
    if (x.startsWith('--') && x !== '--') continue;
    break;
  }
  return { c, s, idx: i };
}

// First positional word after `xargs` options, i.e. the command xargs runs (undefined: echo).
function xargsTarget(w) {
  for (let i = 1; i < w.length; i++) {
    const x = w[i];
    if (x === '--') return w[i + 1];
    if (XARGS_VAL.has(x)) { i++; continue; }
    if (x.length > 1 && x.startsWith('-')) continue;
    return x;
  }
  return undefined;
}

// Expands $(...) / backtick bodies and `bash -c "..."` / `sh -c "..."` / `eval "..."` payloads
// (nested, in execution order). Flags on the result:
//  - `truncated`: a node/byte budget was exceeded.
//  - `unclosed`: an unterminated `$(` / backtick was seen.
//  - `opaqueGlobal`: a shell/eval/source runs a script that is an expansion (`eval "$x"`), so the
//    value may come from anywhere in the text.
//  - `opaqueTexts`: for a shell/xargs that reads its program from a pipe, here-string, process
//    substitution or stdin, the text of that pipeline segment (the only text that can feed it).
function commandsOf(src) {
  const out = [];
  const opaqueSegs = new Set();
  let nodes = 0;
  let bytes = 0;
  out.opaqueGlobal = false;
  const walk = (s) => {
    bytes += s.length;
    if (nodes++ >= MAX_NODES || bytes > MAX_BYTES) { out.truncated = true; return; }
    const id = nodes;
    const subs = [];
    const cmds = splitCommands(s, subs);
    if (cmds.unclosed) out.unclosed = true;
    for (const body of subs) walk(body);
    for (const raw of cmds) {
      const w = stripPrefix(raw);
      if (!w.length) continue;
      w.segKey = `${id}:${raw.seg}`;
      out.push(w);
      const base = w[0].split('/').pop();
      const redirected = w.some((x, k) => k > 0 && x.startsWith('<'));
      const expAt = (k) => !!(w.exp && w.exp[k]);
      // Any word that is a shell followed by -c: descend into the script word, whatever precedes
      // it (`timeout 5 bash -c ...`, `ssh h bash -c ...`). Words after the script are $0/$1.
      const si = w.findIndex((x) => INTERPRETERS.test(x.split('/').pop()));
      if (si >= 0) {
        const { c, s: stdinFlag, idx } = shellArgs(w, si);
        if (c) {
          w.shellC = true;
          if (w[idx] !== undefined) {
            walk(w[idx]);
            if (expAt(idx) && /^\s*[$`]/.test(w[idx])) out.opaqueGlobal = true;
          }
        } else if (si === 0 && (redirected || stdinFlag || idx >= w.length || w[idx] === '-')) opaqueSegs.add(w.segKey);
      }
      if (base === 'eval') {
        if (w[1]) walk(w.slice(1).join(' '));
        if (redirected) opaqueSegs.add(w.segKey);
        if (w.exp && w.exp.slice(1).some(Boolean)) out.opaqueGlobal = true;
      } else if (base === 'source' || base === '.') {
        if (redirected) opaqueSegs.add(w.segKey);
        if (w.exp && w.exp.slice(1).some(Boolean)) out.opaqueGlobal = true;
      } else if (base === 'xargs') {
        const t = xargsTarget(w);
        if (t !== undefined && !XARGS_SAFE.has(t.split('/').pop())) opaqueSegs.add(w.segKey);
      } else if (!INERT.has(base) && base !== 'git' && !w.shellC) {
        // A word that is itself `git ... push ...` handed to another command (`ssh h "git push"`,
        // `watch "git push"`): analyze it as a script.
        for (let k = 0; k < w.length; k++) if (/^\s*git\s/.test(w[k]) && mentionsGitPush(w[k])) walk(w[k]);
      }
    }
  };
  walk(src);
  const texts = new Map();
  for (const w of out) if (opaqueSegs.has(w.segKey)) texts.set(w.segKey, (texts.get(w.segKey) || '') + w.join(' ') + ' ');
  out.opaqueTexts = [...texts.values()];
  return out;
}

module.exports = { splitCommands, stripPrefix, commandsOf, mentionsGitPush, INERT, MAX_BYTES };
