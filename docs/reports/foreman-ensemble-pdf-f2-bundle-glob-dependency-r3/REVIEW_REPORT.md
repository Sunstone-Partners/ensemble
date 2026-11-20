

**BLOCKING: bead `ensemble-pdf-f2-bundle-glob-dependency-r3` unimplemented. Branch not mergeable. Re-run phase 1 / re-dispatch bead before PR opens.**

Phase 3 (repo-rules-review) complete. Artifact: `docs/reports/foreman-ensemble-pdf-f2-bundle-glob-dependency-r3/REVIEW_REPORT.md` (5 H2 sections, marker block = 6 bullets, END marker last line).

**Diff reviewed** `dev...HEAD` = 2 report markdown files, **zero source code** (phase 1 shipped 2-byte empty `FIX_REPORT.md`).

**Fixed (uncommitted, Foreman commits)**
- `REVIEW_CODERABBIT_REPORT.md` — committed version was 2113 B flattened prose, **0** `FOREMAN_REVIEW_FINDINGS` markers → carry-forward contract had nothing to read. Restored from `~/.omp/ensemble-pdf-f2-r3/` mirror (9713 B, md5 `597d3e21…`, markers = 2).
- `FIX_REPORT.md` — 2 blank lines → one-line honest `NO IMPLEMENTATION` marker (312 B, no contract sections so no section-check can pass it). Also killed only 2 lint errors this branch adds (`MD012`).

**Declined (implementation scope)** — all 6 carried forward, live, verified: `detect-stack.js:44` `require('glob').glob`; `detect-framework.js:21` module-level `require('glob')` (bead premise wrong); `packages/full/package.json` deps only `js-yaml` (ajv vendored, undeclared) + **20** unpublished peerDeps (all `E404` — bead said 21, phase 2 said 17, both wrong); `validate-all.js:551` bare-require gap; `glob-optional.test.js:1` degraded end state.

**Verification**
| cmd | exit |
|---|---|
| `npm run validate` | 0 |
| `npm run generate:validate` | 0 |
| `npx markdownlint-cli2` (3 report files) | 0 |
| `npx markdownlint .` | 1 (1206 pre-existing; 0 from branch) |
| `cd packages/core && npx jest skills/detect-stack` | 0 (5 suites / 189 tests) |
| `foreman_inbox_send` | 0 — BLOCKING note sent (`msg_FrPj-UX6GvXv1w8ER-3SVA`) |
| `foreman_task_add_comment` | 1 — `Task external_id is malformed`; content went to inbox |

No source, script or generated mirror touched. Nothing under `/tmp`. Fixes uncommitted.