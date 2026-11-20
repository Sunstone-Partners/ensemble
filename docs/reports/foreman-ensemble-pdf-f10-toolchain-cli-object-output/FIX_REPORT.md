Phase complete. Status:

**Fix** (source in HEAD `e84de467`, carried by the phase-1 commit):
- `packages/development/lib/toolchain-cli.js:1102` — `printResult()`'s `run` arm now branches on payload type: `typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)`. Raw-stdout capabilities unchanged; `--json` envelope untouched.
- Root cause: `mapAndValidateOutput()` returns a **mapped object** for capabilities with a `parse` block (13 in `adapter-tracker-beads`) and a **raw stdout string** for the rest (7); `String(result.data)` stringified the object into `[object Object]`. Broken consumers: `ensemble-beads-build` phase-5-plan-mode.md:9 (`run work-graph.ready`) and `ensemble-implement-trd-tasks` phase-2-scaffold.md step 2.2. No caller anywhere depended on the literal `[object Object]`.

**Tests added** (`packages/development/tests/toolchain-cli.test.js`, +181): object→JSON, no-parse-block→verbatim, `--json` unchanged, plus 2 mutation-proof tests.
- RED on pre-fix source: `3 failed, 39 skipped, 2 passed` (stdout literally `[object Object]`).
- GREEN: `44 passed`.

**Mirrors regenerated** (`npm run generate:codex`, `npm run generate:pi`; no Pi version bump — `packages/pi/vendor` is not a bump content path). `scripts/tests/toolchain-vendor-sync.test.js` fails on stale mirrors, so this is required.

**Verification**: `npm run generate:validate` EXIT=0; `npm run validate` EXIT=0; narrow jest 44/44; scripts suites 49/49; full `packages/development` jest 309/311 suites (2 failures proven pre-existing: `trd-cli` passes 41/41 with a clean HOME — operator's user-scope `~/.config/ensemble/toolchain.yaml`; `local-ci-adversarial` fails on Node 26 `printenv`, red on origin/dev too).

**BAD_OUTPUT half**: does **not** reproduce on real br 0.6.0 / bv v0.26.0 (scratch workspace `~/.omp/ensemble-pdf-f10/scratch/beadsws`) — every adapter `parse` block returned `ok:true`. Recorded under Follow-ups; no adapter change.

**Artifact**: `docs/reports/foreman-ensemble-pdf-f10-toolchain-cli-object-output/FIX_REPORT.md` (403 lines) with Root cause / Change / Tests / Local verification / Follow-ups / Assumptions / `## PR body` (Summary, Testing, Risk, How to revert, Directed by → `Directed by: @ldangelo`).

**Left uncommitted** per phase rules; tree = 3 modified files + the untracked report (Follow-up #6 tells Foreman to stage it by name — I did not `git add -N` it because that can commit an empty blob).