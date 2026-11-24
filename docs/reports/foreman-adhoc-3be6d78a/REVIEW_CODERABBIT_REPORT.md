# CodeRabbit review — PR 1 of TRD-2026-d571763f (ensemble engine CLI)

Run: `run-1e1d08cc4a36b0504325a2302fd43099` · Task: `adhoc-3be6d78a` · Phase: `coderabbit-review` (index 8)
Branch under review: `foreman/adhoc-3be6d78a/run-1e1d08cc4a36b0504325a2302fd43099` · Base: `dev` (merge-base `0a8e73a7`)

## Review engine

The CodeRabbit CLI was available on `PATH` and authenticated. Every round ran the same command from the worktree root:

```
coderabbit review --agent --base "$FOREMAN_BASE_BRANCH"
```

`FOREMAN_BASE_BRANCH=dev` was set and non-empty for the whole phase, so the diff base was `dev` throughout; no round was run against a substituted base.

Each round took roughly 9–10 minutes and printed JSON lines (`review_context`, one line per finding, then a `complete` line carrying `findings` and `outcome`). The three rounds' raw output was captured at `/Users/ldangelo/.omp/ensemble-engine-trd/cr-round1.txt`, `cr-round2.txt` and `cr-round3.txt`.

Operator progress notes were not sent: `foreman_inbox_send` and `foreman_task_add_comment` are not available in this phase, and the phase prompt forbids driving `br` directly. This report is the phase's only operator-facing artifact.

## Rounds

Three rounds were run (the maximum). A further round was only started while the previous round had fixed a `Critical`/`Major` finding, so the third round existed to confirm that the round-2 major fixes were clean.

| Round | Findings received | Critical | Major | Minor | Fixed | Declined |
|---|---|---|---|---|---|---|
| 1 | 8 | 0 | 2 | 6 | 5 | 3 |
| 2 | 6 | 0 | 2 | 4 | 3 | 3 |
| 3 | 3 | 0 | 1 | 2 | 1 | 2 |

Seventeen raw reports resolve to thirteen distinct findings: the PLAN.md `cd` finding was re-reported in rounds 2 and 3, the PLAN.md launcher finding in round 3, and the `toJSON` finding in round 3 in new wording. Eight distinct findings were fixed and five declined.

Round 1 (8 findings) — the full set of the run's first review:

- `packages/development/lib/engine/validate.js` L124-128 — **major**: a dangling symlink was treated as a missing path component, so `resolveCallerPath` accepted a path a later write would follow out of the project root. → **fixed**.
- `packages/development/lib/engine/envelope.js` L69 — **major**: redaction recursed only into `value.constructor === Object`, so an own `constructor` key (as produced by `JSON.parse`) disabled redaction and let a token reach stdout. → **fixed**.
- `packages/development/lib/ensemble-cli.js` L139 — **minor**: the catch block accepted any truthy `error.status`; an unrecognised status made `buildEnvelope` throw *inside* the catch, so the engine returned no envelope and no exit code. → **fixed**.
- `packages/development/lib/engine/envelope.js` L71 (reported against the generated `packages/pi/vendor/lib/engine/envelope.js`) — **minor**: `out[key] = …` for a key named `__proto__` replaced the prototype instead of copying the field, so the emitted JSON silently lost it. → **fixed**.
- `packages/development/tests/engine-mount-parity.test.js` L72-77 — **minor**: the exit-isolation test could not fail — a `process.exit(2)` in the engine produced a numeric status and a null signal, which satisfied both assertions, and the second dispatch ran in a different process. → **fixed**.
- `packages/development/tests/engine-mount-parity.test.js` L114 — **minor**: the legacy-file immutability test compares the working tree with `HEAD`, so a change committed on the branch would still pass it. → **declined** (see below).
- `packages/pi/vendor/lib/engine/argv.js` L90 — **minor**: `--project-root=-workspace` is refused because the value starts with `-`. → **declined** (TRD-mandated rule).
- `docs/reports/foreman-adhoc-3be6d78a/PLAN.md` L241 — **minor**: the §5 verification block repeats `cd packages/development`, which breaks when the commands are run sequentially in one shell. → **declined** (operator-supplied plan, copied unchanged).

Round 2 (6 findings) — run after the round-1 fixes:

- `packages/development/lib/engine/envelope.js` L108 — **major**: a null-prototype record was skipped by redaction although `JSON.stringify` emits its enumerable own properties, so its strings reached stdout unredacted. → **fixed**.
- `packages/development/lib/engine/validate.js` L74 — **minor**: a stdin stream that closes before `end` never settled the promise, so the call hung forever instead of refusing. → **fixed**.
- `packages/development/lib/engine/envelope.js` L146 — **minor**: a custom `toJSON` survived redaction and `JSON.stringify` then emitted whatever it returned, unredacted. → **fixed** (round 3 re-reported it in new words; see below).
- `docs/reports/foreman-adhoc-3be6d78a/PLAN.md` L241-242 — **minor**: re-report of round 1's PLAN.md `cd` finding. → **declined**.
- `docs/reports/foreman-adhoc-3be6d78a/PLAN.md` L204 — **major**: the plan's `E7` puts execution behind `require.main === module`, so the launcher prescribed by `E11` would never call `main`. → **declined** (stale: the implemented launcher calls the exported `run()` explicitly).
- `packages/pi/vendor/lib/engine/mount.js` L83 — **minor**: `spawnSync`'s fixed `maxBuffer` kills a legacy child that writes more than 64 MiB. → **declined** (the ceiling is a deliberate bound).

Round 3 (3 findings) — run to confirm the round-2 major fixes:

- `packages/development/lib/engine/envelope.js` L111 — **minor**: "redact the serialized form of `data`, not the raw object" — re-report of round 2's `toJSON` finding, extended to class instances. → **fixed**.
- `docs/reports/foreman-adhoc-3be6d78a/PLAN.md` L241-242 — **minor**: re-report of round 1's PLAN.md `cd` finding. → **declined**.
- `docs/reports/foreman-adhoc-3be6d78a/PLAN.md` L204 — **major**: "make the launcher call the exported entry point" — re-report of round 2's launcher finding. → **declined** (stale).

Round 3 produced no new issue: its one actionable finding was the `toJSON` re-report, which was fixed.

## Fixed

Eight distinct findings were fixed; each fix is the narrowest change that resolves the finding, with no adjacent improvements bundled in.

1. **`packages/development/lib/engine/validate.js` (major, round 1) — dangling symlink accepted as an in-project path.**
   *What was wrong:* `realpathOfNearestAncestor` treated any `ENOENT` from `realpath` as "this component does not exist yet" and re-attached the missing tail to the nearest existing ancestor. A symlink whose target does not exist (`/project/out → /outside/new-file`) therefore resolved to `/project/out` and passed the containment check, even though creating the file later would follow the link out of the project root.
   *What changed:* added `isDanglingSymlink(target)` (an `lstatSync` that succeeds for the link itself) and a `rejectDanglingSymlink` option on `realpathOfNearestAncestor`. The default is strict, so a candidate path that resolves onto a dangling symlink is refused with `PATH_ESCAPE` / `INVALID_INPUT`. The project root is resolved with the tolerant option, so an absent root behaves exactly as before. Genuinely absent in-project files stay valid.

2. **`packages/development/lib/engine/envelope.js` (major, round 1) — an own `constructor` key disabled redaction.**
   *What was wrong:* `redact` (and `sortKeys`) recursed only when `value.constructor === Object`. A payload parsed from JSON such as `{"constructor":null,"note":"token ghp_…"}` has an own `constructor` property, so the check failed, the record was returned untouched and the token reached stdout unredacted.
   *What changed:* the prototype is inspected instead of the `constructor` property (`Object.getPrototypeOf(value) === Object.prototype`), which an own property cannot change. Ordinary records are still recursed into; null-prototype records were added in round 2 (finding 6).

3. **`packages/development/lib/ensemble-cli.js` (minor, round 1) — an unknown exception status escaped the engine.**
   *What was wrong:* both catch blocks tested `error && error.status`. A handler that threw an error carrying `status = 404` reached `buildEnvelope`, which throws for a status that is not in `STATUS_EXIT`; that throw happened inside the catch block, so `main` returned no envelope and set no exit code.
   *What changed:* added `isEngineStatus(status)` (a string that is a key of `STATUS_EXIT`) and used it in the `--describe` catch and the dispatch catch. A tabled status still produces that status' envelope and exit code; every other exception now goes through `internal()` and yields exit code 6 with the stack on stderr.

4. **`packages/development/lib/engine/envelope.js` (minor, round 1) — a `__proto__` field was lost.**
   *What was wrong:* `out[key] = value` for a key named `__proto__` invoked the inherited setter and replaced the prototype of the rebuilt object instead of copying the field, so the supplied JSON silently lost it.
   *What changed:* added `setOwn(target, key, value)`, which defines the property with `Object.defineProperty` (enumerable, writable, configurable data property). `redact` and `sortKeys` now write every key that way.

5. **`packages/development/tests/engine-mount-parity.test.js` (minor, round 1) — the exit-isolation check could not fail.**
   *What was wrong:* the test spawned the engine twice as two separate processes and asserted only that the first returned a numeric status with a null signal. An engine that called `process.exit(2)` satisfies that assertion, and the second process' success says nothing about the first one.
   *What changed:* the test now mounts a fixture CLI (`packages/development/tests/fixtures/engine/exit-cli.js`, which calls `process.exit(2)`) and runs **both** dispatches inside **one** child process, which writes an `ENGINE_SURVIVED:<first>:<second>` marker after the second dispatch. The assertions require a null signal, exit status 0 and the marker — so an engine that exits early can no longer pass. The old fixture (`toolchain-cli.js resolve --no-such-flag-for-legacy`) was not usable: that legacy command exits 0 and ignores the unknown flag, so it never exercised the exit path.

6. **`packages/development/lib/engine/envelope.js` (major, round 2) — null-prototype records were not redacted.**
   *What was wrong:* `JSON.stringify` emits the enumerable own properties of a null-prototype object, but the record check required the `Object.prototype` prototype, so such a record was returned untouched and its strings reached stdout unredacted.
   *What changed:* `isRecord` now accepts a null prototype as well (`prototype === null`). Ordinary objects and null-prototype objects are recursed into; everything else keeps its previous treatment.

7. **`packages/development/lib/engine/validate.js` (minor, round 2) — a closed stdin stream hung the reader.**
   *What was wrong:* `readStdinCapped` settled only on `end`, `error` or the size cap. A stream that is destroyed before EOF emits `close` with neither `end` nor `error`, so the promise never settled and the caller waited forever.
   *What changed:* a `close` handler that fires when the stream closed before it ended now fails the promise with `invalidInputError('INPUT_STREAM_CLOSED', …)` — status `INVALID_INPUT`, so the engine refuses instead of hanging.

8. **`packages/development/lib/engine/envelope.js` (minor, rounds 2 and 3) — a custom `toJSON` bypassed redaction.**
   *What was wrong:* `redact` copied a callable `toJSON` into the rebuilt envelope unchanged. `JSON.stringify` calls `toJSON` during emission, i.e. *after* redaction, so whatever it returned was written to stdout without passing through the secret redaction — for a plain record and for a class instance alike.
   *What changed:* `redact` now materializes the serialized form before redacting it (`if (typeof value.toJSON === 'function') return redact(value.toJSON());`), so the value that reaches stdout is the redacted serialized form. The `toJSON` function is in-process code that `JSON.stringify` would have called anyway, so materializing it earlier adds no trust boundary; standard types (`Buffer`, `Date`) serialize identically before and after the change.

Regression tests were added for every one of the eight fixes (`packages/development/tests/engine-envelope.test.js`, `packages/development/tests/engine-registry.test.js`, `packages/development/tests/engine-mount-parity.test.js`), plus the fixture `packages/development/tests/fixtures/engine/exit-cli.js`.

## Declined

Five distinct findings were declined, with the reason recorded.

1. **`docs/reports/foreman-adhoc-3be6d78a/PLAN.md` L241 — "Keep the verification commands in the correct directory" (minor, rounds 1, 2 and 3).**
   *The finding:* §5 of the plan enters `packages/development` and then repeats `cd packages/development` for the two following commands, so those commands resolve to `packages/development/packages/development` and do not run; the root smoke-test command then uses `cd ../..`, which is wrong for the same reason.
   *The reason:* `PLAN.md` is a byte-identical copy of the operator-supplied plan (`/Users/ldangelo/.omp/ensemble-engine-trd/PLAN-pr1-workpackages.md`); the plan phase's contract is to copy it unchanged, and the review phase must not rewrite the operator's plan text. The defect is in the supplied plan's §5 block, not in the implementation. The working command sequence is recorded in **Verification** below so the operator can use it directly.

2. **`packages/development/tests/engine-mount-parity.test.js` L114 — "Use the PR base for the legacy-file immutability check" (minor, round 1).**
   *The finding:* the test compares the working-tree file with `git show HEAD:<path>`; a legacy CLI change committed on this branch would already be in `HEAD`, so the test would pass despite the modification it claims to reject.
   *The reason:* comparing against the target branch's merge base belongs to pull-request validation, which this run does not perform, and a detached CI checkout has no `dev` ref to compare against — the test would fail there for the wrong reason. TRD-003's requirement is satisfied by the diff itself: this branch modifies neither `packages/development/lib/trd-cli.js` nor `packages/development/lib/toolchain-cli.js`. The test's header comment was corrected so that it no longer overstates what it proves (the working tree matches `HEAD`; the PR diff is the authority for TRD-003).

3. **`packages/pi/vendor/lib/engine/argv.js` L90 — "Accept valid operands that start with `-`" (minor, round 1).**
   *The finding:* `--project-root=-workspace` explicitly supplies a relative directory whose name starts with `-`, and the parser refuses it as `MISSING_FLAG_VALUE`.
   *The reason:* the TRD requires it. `docs/TRD/TRD-2026-d571763f-ensemble-engine-cli.md` line 147: "a value starting with `-` is refused where a value is expected (the rule `toolchain-cli` already applies)". Accepting the inline spelling would weaken a TRD-mandated rule, and the TRD is the contract for this PR. The finding is reported against the generated vendor copy; the development source is the same code.

4. **`docs/reports/foreman-adhoc-3be6d78a/PLAN.md` L204 — "Make the launcher call the exported entry point" (major, rounds 2 and 3).**
   *The finding:* the plan's `E7` puts execution behind `require.main === module`, so the launcher prescribed by `E11` would require the module without calling `main`, and no envelope would be emitted.
   *The reason:* stale against the code as it is. The implemented launcher `packages/full/bin/ensemble` ends with `require('../lib/ensemble-cli.js').run(process.argv.slice(2));` — it calls the exported entry point explicitly — and `node packages/full/bin/ensemble --describe` prints the envelope and exits 0 (covered by `scripts/tests/ensemble-bundle-smoke.test.js`). The finding describes the wording of the supplied plan document, not the implementation under review.

5. **`packages/pi/vendor/lib/engine/mount.js` L83 — "Remove the fixed output ceiling from the passthrough path" (minor, round 2).**
   *The finding:* `spawnSync`'s `maxBuffer: 64 * 1024 * 1024` kills a legacy child that writes more than 64 MiB, so a large legacy output is truncated into a failure.
   *The reason:* the ceiling is a deliberate memory bound: it turns unbounded output into a loud, bounded failure instead of an unbounded allocation. The TRD prescribes no size limit, and raising or removing the ceiling would change the mounted group's behaviour without a stated requirement.

## Verification

All commands were run from the worktree root unless stated otherwise.

| Command | Exit code | Result |
|---|---|---|
| `cd packages/development && npx jest tests/engine-envelope.test.js tests/engine-registry.test.js tests/engine-mount-parity.test.js` | 0 | 3 suites passed, 32 tests passed |
| `npx jest scripts/tests/ensemble-bundle-smoke.test.js` (root) | 0 | 1 suite passed, 11 tests passed |
| `(cd packages/development && npx jest)` — the package's full suite, as listed in the plan's §5 | 1 | 316 suites passed, 1 suite failed (`tests/local-ci-adversarial.test.js`), 13 284 tests passed, 1 failed — see below; the failure is pre-existing and unrelated to this run |
| `npm run generate:pi` (root) | 0 | regenerated `packages/pi/vendor/lib/engine/envelope.js` and `packages/pi/vendor/lib/ensemble-cli.js`; no Pi version bump |
| `npm run generate:validate` | 0 | "✓ Validation passed (64 files)" |
| `npm run validate` | 0 | contract docs up to date, 298 skills conform (pre-existing baseline hints only) |
| `cd packages/development && npx eslint lib/engine/envelope.js lib/engine/validate.js lib/ensemble-cli.js lib/engine/mount.js tests/engine-envelope.test.js tests/engine-registry.test.js tests/engine-mount-parity.test.js tests/fixtures/engine/exit-cli.js` | 0 | 0 errors; 5 "file ignored" warnings — the repository's `eslint.config.mjs` ignores `**/lib/**` and `**/fixtures/**`, so only the three `tests/engine-*.test.js` files are linted |

The single failure in the full package suite is `tests/local-ci-adversarial.test.js` — "the step prints no env, nor GH_TOKEN/GITHUB_TOKEN" — where `expect(text).toContain('PATH')` fails. It is **pre-existing and unrelated to this run**:

- The test imports only `../lib/local-ci-runner`, `../lib/local-ci-config` and `../lib/local-ci-cli`; this phase's diff touches `lib/engine/envelope.js`, `lib/engine/validate.js` and `lib/ensemble-cli.js` only, so no code path in the failing test passes through a changed module.
- With this phase's changes removed (`git stash push -u`), the same file fails identically: `Tests: 1 failed, 70 passed, 71 total`.
- The assertion depends on the local-CI gate keeping the head of the printed environment in the failure message; on this machine the environment dump is long enough (the worktree's `PATH` entries) that the `PATH` key falls into the truncated tail of the message, so the expectation does not hold. The same failure mode is not reproduced by the engine's own tests, which pass in full.

The working, sequential form of the plan's §5 verification block (see declined finding 1) is:

```
(cd packages/development && npx jest tests/engine-envelope.test.js tests/engine-registry.test.js tests/engine-mount-parity.test.js)
(cd packages/development && npx jest tests/trd-cli.test.js tests/toolchain-cli.test.js)
(cd packages/development && npx jest)
(npx jest scripts/tests/ensemble-bundle-smoke.test.js scripts/tests/validate-all.test.js scripts/tests/full-bundle-install-smoke.test.js)
```

Each check was proved able to fail (Constitution Rule 7) before its fix was accepted:

- Restoring the three pre-fix source files while keeping the new tests produced 4 failures: "a handler error with an unknown status is contained as INTERNAL", "an own constructor key does not stop redaction", "a `__proto__` field survives as an own data property", "a dangling symlink out of the tree is refused".
- Restoring the round-1 sources against the round-2 tests produced 2 failures: "a null-prototype record is redacted too" and "a stdin stream that closes before it ends is refused" (the latter as a 5 s jest timeout — the hang).
- Patching `packages/development/lib/engine/mount.js`'s `runLegacy` to `process.exit(child.status)` made the rewritten exit-isolation test fail (`Expected: 0 Received: 2`, no `ENGINE_SURVIVED` marker) while the previous version of that test stayed green. `mount.js` was restored afterwards and is not part of this phase's diff.
- Removing the `toJSON` materialization from `redact` made the new test fail with the raw token in stdout: `"{\"data\":{\"note\":\"token ghp_a1b2c3d4e5a1b2c3d4e5a1b2c3d4e5\"},…}"`. The fix was restored immediately afterwards.

The fixes are left uncommitted for Foreman to commit. `git status --porcelain` after the phase:

```
 M packages/development/lib/engine/envelope.js
 M packages/development/lib/engine/validate.js
 M packages/development/lib/ensemble-cli.js
 M packages/development/tests/engine-envelope.test.js
 M packages/development/tests/engine-mount-parity.test.js
 M packages/development/tests/engine-registry.test.js
 M packages/pi/vendor/lib/engine/envelope.js
 M packages/pi/vendor/lib/ensemble-cli.js
?? docs/reports/foreman-adhoc-3be6d78a/REVIEW_CODERABBIT_REPORT.md
?? packages/development/tests/fixtures/engine/exit-cli.js
```

The two generated files under `packages/pi/vendor/` are byte copies of `packages/development/lib/` produced by `npm run generate:pi`; they are committed with their sources.

<!-- FOREMAN_REVIEW_FINDINGS_START -->
{"schema": "foreman.review_findings/1", "reviewed": true, "findings": [{"severity": "major", "path": "packages/development/lib/engine/validate.js", "line": 161, "description": "A symlink whose target does not exist was re-attached to its nearest existing ancestor, so a path that would write outside the project root passed the containment check (rounds 1).", "disposition": "fixed", "source": "coderabbit"}, {"severity": "major", "path": "packages/development/lib/engine/envelope.js", "line": 59, "description": "Redaction recursed only into objects whose `constructor` property equalled `Object`, so an own `constructor` key from parsed JSON left the payload's strings unredacted (rounds 1).", "disposition": "fixed", "source": "coderabbit"}, {"severity": "major", "path": "packages/development/lib/engine/envelope.js", "line": 59, "description": "A null-prototype record was skipped by redaction although JSON.stringify emits its enumerable own properties, so its strings reached stdout unredacted (round 2).", "disposition": "fixed", "source": "coderabbit"}, {"severity": "minor", "path": "packages/development/lib/ensemble-cli.js", "line": 94, "description": "A handler error carrying a status outside the engine's status table made buildEnvelope throw inside the catch block, so the engine returned no envelope and no exit code (round 1).", "disposition": "fixed", "source": "coderabbit"}, {"severity": "minor", "path": "packages/development/lib/engine/envelope.js", "line": 75, "description": "Assigning to a `__proto__` key replaced the prototype of the rebuilt object instead of copying the field, so the emitted JSON silently lost it (round 1).", "disposition": "fixed", "source": "coderabbit"}, {"severity": "minor", "path": "packages/development/lib/engine/envelope.js", "line": 111, "description": "A custom toJSON survived redaction and was called by JSON.stringify after redaction had run, so its return value reached stdout unredacted (rounds 2 and 3).", "disposition": "fixed", "source": "coderabbit"}, {"severity": "minor", "path": "packages/development/lib/engine/validate.js", "line": 75, "description": "A stdin stream that closed before `end` never settled the read promise, so the call hung instead of refusing the input (round 2).", "disposition": "fixed", "source": "coderabbit"}, {"severity": "minor", "path": "packages/development/tests/engine-mount-parity.test.js", "line": 70, "description": "The exit-isolation test ran its two dispatches in separate processes and asserted only a numeric status and a null signal, so an engine that called process.exit(2) still passed it (round 1).", "disposition": "fixed", "source": "coderabbit"}, {"severity": "minor", "path": "docs/reports/foreman-adhoc-3be6d78a/PLAN.md", "line": 241, "description": "The plan's verification block repeats `cd packages/development`, so the second and third commands resolve to a non-existent directory and do not run (rounds 1, 2 and 3).", "disposition": "declined", "source": "coderabbit"}, {"severity": "minor", "path": "packages/development/tests/engine-mount-parity.test.js", "line": 116, "description": "The legacy-file immutability test compares the working tree with HEAD, so a legacy CLI change committed on this branch would still pass it (round 1).", "disposition": "declined", "source": "coderabbit"}, {"severity": "minor", "path": "packages/pi/vendor/lib/engine/argv.js", "line": 90, "description": "The parser refuses an inline flag value that starts with `-`, which the TRD explicitly requires for a value position (round 1).", "disposition": "declined", "source": "coderabbit"}, {"severity": "major", "path": "docs/reports/foreman-adhoc-3be6d78a/PLAN.md", "line": 204, "description": "The plan's E7 puts execution behind `require.main === module`, which the finding reads as leaving the prescribed launcher without an entry call (rounds 2 and 3).", "disposition": "declined", "source": "coderabbit"}, {"severity": "minor", "path": "packages/pi/vendor/lib/engine/mount.js", "line": 83, "description": "The passthrough spawn keeps a fixed 64 MiB output ceiling, so a legacy child writing more is killed instead of being served (round 2).", "disposition": "declined", "source": "coderabbit"}]}
<!-- FOREMAN_REVIEW_FINDINGS_END -->
<!-- FOREMAN_RISK_JUDGEMENT_START -->
{"schema": "foreman.risk_judgement/1", "level": "MEDIUM", "rationale": "The change adds a new CLI surface with a security-sensitive input boundary (path containment, secret redaction, exit-code contract) and mounts the legacy CLIs behind it; the review fixed three redaction/containment weaknesses and one unhandled-status escape, each with a regression test, and left the legacy byte-parity proven by live comparison. Five findings were declined, all in the operator-supplied plan text or in deliberate bounds. Per the TRD, TRD-001 still requires a human security reviewer and no auto-merge."}
<!-- FOREMAN_RISK_JUDGEMENT_END -->
