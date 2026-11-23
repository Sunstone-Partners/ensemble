# PLAN — zflwr + siil7: permitter shell -c redirect check and shell/prefix wrappers

## 1. Verdict

**Real bug, both beads.** Reproduced on this worktree HEAD `a0d6a213` with `node -e` against
`packages/permitter/lib/command-parser.js` (`parseCommand`):

- `npm test > ~/.ssh/authorized_keys` THROWS `Redirection to a path not supported`, but
  `bash -c "npm test > ~/.ssh/authorized_keys"` → `[{npm,test}]` (redirect dropped);
  same for `bash -c "git status; npm test > /etc/passwd"`, `bash -c "npm test 2>&1 > /etc/x"`,
  `bash -c "npm test < /etc/passwd"`.
- `zsh|dash|ksh|ash|mksh -c "git status; rm -rf /"` and `/bin/bash -c "..."` → ONE opaque segment
  with that shell as executable.
- `sudo bash -c "git status; rm -rf /"` → `[{sudo,...}]` (a `Bash(sudo:*)` rule approves it);
  `command bash -c "..."` → `[{command,...}]`.
- `normalizeSegment(['bash','-c','git status; rm -rf /'])` → `{git,status}` only (R3, latent).

Bead claim that is **wrong**: `packages/full/lib/command-parser.js` is NOT a byte-identical mirror,
it is a git symlink (mode 120000 → `../../permitter/lib/command-parser.js`) and
`scripts/validate-all.js` requires it to stay a symlink. **Do not create or write that file.**

## 2. Root cause

`packages/permitter/lib/command-parser.js`:

- `parseCommand()` (line ~887) calls `checkRedirections(tokens)` only on the OUTER token list.
  The inner `-c` string is tokenized separately in `classifySegment()` (line 815) and in
  `normalizeSegment()` (line 739) and never passed to `checkRedirections()` (line 372);
  `normalizeSegment`'s redirect-stripping loop (lines 756-775) then silently drops `>` and its target.
- Only `tokens[0] === 'bash' || tokens[0] === 'sh'` counts as a `-c` wrapper
  (`normalizeSegment` line 727, `classifySegment` line 803), so other shells and absolute paths
  stay one opaque segment.
- `sudo`/`doas`/`command` are not in `WRAPPER_COMMANDS` (line 17) and are not otherwise refused,
  so a shell `-c` behind them survives as a single `sudo`/`command` segment.
- `normalizeSegment` line 741 returns `normalizeSegment(innerSegments[0])` — drops later segments (R3).

## 3. Failing check first

Add ONE new top-level `describe` at the END of `packages/permitter/tests/security.test.js`
(after the last closing `});`), with its own helpers (the existing `autoAllowed`/`executables`
helpers are local to other describes):

```js
// =============================================================================
// foreman-zflwr + foreman-siil7: redirects and shells hidden inside `-c`
// =============================================================================
describe('foreman-zflwr/siil7: shell -c wrappers hide redirects and shells', () => {
  const allowlist = ['Bash(npm test:*)', 'Bash(git:*)', 'Bash(npm run build:*)'];
  function autoAllowed(cmd) {
    let cmds;
    try { cmds = parseCommand(cmd); } catch { return false; }
    return cmds.length > 0 && cmds.every(c => matchesAny(c, allowlist));
  }
  const executables = cmd => parseCommand(cmd).map(c => c.executable);

  // zflwr: an inner redirection must throw exactly like a top-level one.
  test.each([
    'bash -c "npm test > ~/.ssh/authorized_keys"',
    'bash -c "git status; npm test > /etc/passwd"',
    'bash -c "npm test 2>&1 > /etc/x"',
    'bash -c "npm test < /etc/passwd"',
    'bash -c "npm test >> /etc/x"',
    'bash -c "npm test &> /etc/x"'
  ])('an inner redirection to a path is refused: %s', (cmd) => {
    expect(() => parseCommand(cmd)).toThrow(/Redirection to a path not supported/);
    expect(autoAllowed(cmd)).toBe(false);
  });

  test.each([
    'sh -c "npm test > /dev/null"', 'bash -c "npm test >/dev/null 2>&1"', 'bash -c "npm test 2>&1"'
  ])('/dev/null and fd dups inside -c still parse: %s', (cmd) => {
    expect(parseCommand(cmd)).toEqual([{ executable: 'npm', args: 'test' }]);
    expect(autoAllowed(cmd)).toBe(true);
  });

  // siil7 R1: every shell, including an absolute path, expands its inner segments.
  test.each([
    'zsh -c "git status; rm -rf /"', 'dash -c "git status; rm -rf /"',
    'ksh -c "git status; rm -rf /"', 'ash -c "git status; rm -rf /"',
    'mksh -c "git status; rm -rf /"', '/bin/bash -c "git status; rm -rf /"',
    '/usr/bin/zsh -c "git status; rm -rf /"'
  ])('a non-bash shell -c is expanded, not one opaque segment: %s', (cmd) => {
    expect(executables(cmd)).toEqual(['git', 'rm']);
    expect(autoAllowed(cmd)).toBe(false);
  });

  test('a single inner command under another shell still parses', () => {
    expect(parseCommand('zsh -c "npm test"')).toEqual([{ executable: 'npm', args: 'test' }]);
  });

  // siil7 R2: a shell -c behind a prefix fails closed.
  test.each([
    'sudo bash -c "git status; rm -rf /"', 'doas bash -c "git status; rm -rf /"',
    'command bash -c "git status; rm -rf /"', 'command sh -c "git status; rm -rf /"',
    'env bash -c "git status; rm -rf /"', 'timeout 5 bash -c "git status; rm -rf /"',
    'nohup bash -c "git status; rm -rf /"', 'sudo zsh -c "npm test"'
  ])('a shell -c behind a prefix is refused: %s', (cmd) => {
    expect(() => parseCommand(cmd)).toThrow(/shell -c behind a wrapper is not supported/);
    expect(autoAllowed(cmd)).toBe(false);
  });

  test.each([
    ['sudo git status', 'sudo'], ['sudo -u x git status', 'sudo'], ['command -v git', 'command'],
    ['env git status', 'git'], ['bash script.sh', 'bash'], ['sudo -u x bash script.sh', 'sudo']
  ])('%s is unchanged (executable %s)', (cmd, executable) => {
    expect(executables(cmd)).toEqual([executable]);
  });

  // siil7 R3: the exported single-segment contract no longer silently drops segments.
  test('normalizeSegment() refuses a multi-segment inner command, keeps single', () => {
    expect(() => normalizeSegment(['bash', '-c', 'git status; rm -rf /']))
      .toThrow(/shell -c with more than one inner command/);
    expect(normalizeSegment(['bash', '-c', 'npm test'])).toEqual({ executable: 'npm', args: 'test' });
  });
});
```

Red run (before the lib edit): `cd packages/permitter && npx jest tests/security.test.js`.
Expect failures in the new describe only: the redirect cases return `[{npm,test}]` instead of
throwing, the non-bash shells return one `zsh`/`dash`/… executable, the prefix cases return
`sudo`/`command`/`bash`.

## 4. Edits — `packages/permitter/lib/command-parser.js` only

**Edit 1 — new constants + helpers.** Insert immediately BEFORE `const SKIP_COMMANDS` (line 20):

```js
// Shell executables whose `-c STRING` argument hides a whole command line.
const SHELL_EXECUTABLES = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'mksh']);

// Prefixes that are not stripped as wrappers but can hide a shell -c behind them.
const PRIVILEGE_PREFIXES = new Set(['sudo', 'doas', 'command']);

// True when a token names a shell, by basename, so /bin/bash counts.
function isShellExecutable(token) {
  if (typeof token !== 'string' || token === '') return false;
  const base = token.slice(token.lastIndexOf('/') + 1);
  return SHELL_EXECUTABLES.has(base);
}

// True when a later token is a shell followed by -c (shell hidden behind a prefix).
function hidesShellC(tokens) {
  for (let i = 1; i < tokens.length; i++) {
    if (isShellExecutable(tokens[i]) && tokens.indexOf('-c', i + 1) !== -1) return true;
  }
  return false;
}
```

**Edit 2 — `normalizeSegment()`, replace lines 727-745** (the whole
`if (options.expandWrappers !== false && (tokens[0] === 'bash' || tokens[0] === 'sh')) { ... }`
block, and reword the comment above it) with:

```js
  // A shell -c hidden behind sudo/doas/command cannot be judged: fail closed.
  if (PRIVILEGE_PREFIXES.has(tokens[0]) && hidesShellC(tokens)) {
    throw new Error('shell -c behind a wrapper is not supported');
  }

  if (isShellExecutable(tokens[0])) {
    const cIndex = tokens.indexOf('-c');
    if (cIndex !== -1 && cIndex + 1 < tokens.length) {
      // parseCommand() reaches here only after an env/timeout/... prefix was
      // stripped; that wrapper's options may change what actually runs, so the
      // hidden command line is refused rather than classified.
      if (options.expandWrappers === false) {
        throw new Error('shell -c behind a wrapper is not supported');
      }

      const innerCommand = tokens[cIndex + 1];
      if (!innerCommand || innerCommand.trim() === '') {
        return null;
      }

      // Strict: an unterminated quote in the inner command hides words just
      // the same as one in the outer command. The inner text also gets the
      // top-level redirection check, so `bash -c "npm test > /etc/x"` throws.
      const innerTokens = tokenize(innerCommand, { strict: true });
      checkRedirections(innerTokens);
      const innerSegments = splitByOperators(innerTokens);
      if (innerSegments.length > 1) {
        throw new Error('shell -c with more than one inner command is not supported here');
      }
      if (innerSegments.length === 1) {
        return normalizeSegment(innerSegments[0], options);
      }
      return null;
    }
  }
```

**Edit 3 — `classifySegment()` line 803**: replace
`if (tokens.length > 0 && (tokens[0] === 'bash' || tokens[0] === 'sh')) {`
with `if (tokens.length > 0 && isShellExecutable(tokens[0])) {`.

**Edit 4 — `classifySegment()` line 815**: replace
`const innerSegments = splitByOperators(tokenize(innerCommand, { strict: true }));`
with

```js
      const innerTokens = tokenize(innerCommand, { strict: true });
      checkRedirections(innerTokens);
      const innerSegments = splitByOperators(innerTokens);
```

**Edit 5 — exports (line ~900)**: add `isShellExecutable`, `SHELL_EXECUTABLES` and
`PRIVILEGE_PREFIXES` to the `module.exports` constants block (same style as `WRAPPER_COMMANDS`).

**Edit 6 — update 2 existing tests in `packages/permitter/tests/security.test.js`** (these assert the
old, now-fixed behaviour; the bead scope says so explicitly):

- lines 1274-1288, `'a wrapper in front of bash -c is not reduced to its first segment: %s'` —
  the 5 cases (`env bash -c`, `env -i bash -c`, `env A=1 sh -c`, `timeout 5 bash -c`,
  `nohup bash -c`) must now be
  `expect(() => parseCommand(cmd)).toThrow(/shell -c behind a wrapper is not supported/);`
  plus `expect(autoAllowed(cmd)).toBe(false);`. Rename the case to
  `'a wrapper in front of bash -c is refused: %s'` and update the comment above it.
- line 1589, `'a direct normalizeSegment() call keeps its single-segment contract'` —
  `normalizeSegment(['bash','-c','unset FOO; npm test'])` now throws; change to
  `expect(() => normalizeSegment(['bash','-c','unset FOO; npm test'])).toThrow(/shell -c with more than one inner command/);`

Do NOT change `tests/security.test.js` lines 1262-1272 (`sudo`/`command` stay plain commands —
still passes) or `tests/command-parser.test.js` (verified: all its `normalizeSegment` subshell
cases are single-segment and still pass).

**Edit 7 — `packages/permitter/CHANGELOG.md`**, under `## [Unreleased]` → `### Security`, append:

```md
- A `-c` wrapper no longer hides a redirection or a second command from the allowlist: the inner
  command text now gets the same redirection check as the top level (`bash -c "npm test > ~/.ssh/authorized_keys"`
  used to auto-allow under `Bash(npm test:*)`), every shell is recognised (`zsh`, `dash`, `ksh`, `ash`,
  `mksh` and absolute paths such as `/bin/bash`, not just `bash`/`sh`), and a shell `-c` behind
  `sudo`, `doas`, `command`, `env`, `timeout` or `nohup` now defers to the permission dialog instead of
  matching a `Bash(sudo:*)`/`Bash(bash:*)` rule. `/dev/null` targets and fd duplications
  (`2>&1`, `>&2`) inside `-c` are still allowed.
```

## 5. Verification

From the repository root:

```
cd packages/permitter && npx jest tests/security.test.js            # new + updated tests green
cd packages/permitter && npx jest tests                             # whole package
cd ../.. && npx eslint packages/permitter
cd ../.. && npm run generate:validate && npm run validate
```

Success = green jest (prototype run of this exact patch: 912 tests, only the 6 listed stale
assertions failed, all covered by Edit 6), clean eslint, and `validate-all.js` still happy that
`packages/full/lib/command-parser.js` is a symlink.

## 6. Out of scope

- `packages/full/lib/command-parser.js` — a symlink; do not create, copy or edit it.
- `.beads/`, `docs/reports/` (including this plan), any other package.
- No refactor of `checkRedirections`, `isRedirection`, the tokenizer or `WRAPPER_COMMANDS`.
- Do not relax any existing assertion other than the two named in Edit 6.
- PR: ONE PR to `dev`, title `fix(permitter): check redirects and shells inside shell -c wrappers`.
  Body must state the defect, the fix, red-then-green evidence, that a human security reviewer must
  read the diff before merge, and that auto-merge must stay off.
