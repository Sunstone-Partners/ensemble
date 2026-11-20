Phase complete. Final state:

**CodeRabbit review — 3 rounds, no code changes (deliberate)**

| Round | Command | Result |
|---|---|---|
| 1 | `coderabbit review --agent --base "$FOREMAN_BASE_BRANCH"` (=$FOREMAN_BASE_BRANCH=dev) | exit 0, findings: 0 |
| 2 | `coderabbit review --agent --fresh --base dev` | exit 0, findings: 0 (`reused: true` on the first attempt, so re-run with `--fresh`) |
| 3 | same under `zsh -ic` (rule out env suppression) | exit 0, findings: 0 |

`reviewedFiles` in all three: only `FIX_REPORT.md`. **The branch contains no code** — `git diff dev...HEAD --stat` = 1 file, 2 insertions, and that file is a 2-byte empty `FIX_REPORT.md`. So `findings: 0` is a false-clean signal, not a pass. I verified the task's own acceptance criteria against the tree instead: F7a (no `lib/reqnroll-cli.js` in the bundle), F7b (`packages/full/lib/prd-cli.js` → the development CLI, which has no `generate-features`; the two `prd-cli.js` files are disjoint, so the prescribed relink would break `list`/`status`/`migrate-frontmatter`), F11 (e2e contract files not mirrored), the missing install smoke test, and the `scripts/validate-all.js:65` / `:551` one-directional validator gaps — all still open. I did **not** implement the fix here: a review phase that writes the fix has nothing independently reviewing it, the prd-cli superset question is a real design decision, and the required failing-first red run belongs in `FIX_REPORT.md`.

**Deliverable** — `docs/reports/foreman-ensemble-pdf-f7-f11-bundle-path-hygiene-r3/REVIEW_CODERABBIT_REPORT.md`, 13197 bytes, md5 `80c4e7ee2faf709d253264e17911da0f`, stable across 6 checks over ~2 min, 5 required H2 sections in order, `FOREMAN_REVIEW_FINDINGS_START/END` present with END as the last line, 6 findings (3 Critical / 2 Major / 1 Minor), markdownlint exit 0, untracked per contract. Scratch mirror `~/.omp/ensemble-pdf-f7-r3/REVIEW_CODERABBIT_REPORT.md`.

**Verification** — `npm run validate` exit 0; `npx jest scripts/tests` exit 1: 2 suites / 4 tests failed, 1892 passed of 1897 total, all four from the operator's real `/Users/ldangelo/.config/ensemble/toolchain.yaml` (`workflow: plain-git` → `source:'user'`), pre-existing and out of scope.

**Clobber investigation** — the artifact path was twice found holding 785 bytes of unrelated tool-error JSON. `~/.omp/foreman-watch/*.sh` are read-only API pollers (curl/jq → stdout, no writes; grep for `REVIEW_CODERABBIT|docs/reports|worktrees|tee` → no match), so they're cleared as the writer and the overwrite stays unattributed — hence writing to `~/.omp` first and re-hashing at the end.

**Notified** — `foreman_inbox_send` twice (`msg_6mw7r0sQNDwlQgE-4P_VrA`, `msg_-MctrLF5MLtlOPkC_T_1VA`). `foreman_task_add_comment` fails with "Task external_id is malformed" for all three `ensemble-pdf-f7-f11-*` runs (`external_id: null` in `foreman_task_list`) — a Foreman-side data gap, not a phase error.

**Operator action needed**: this run must not merge as a fix — the implementation phase has to be re-run. The sibling `-r2` run `run-fa406d3e12dd1373808198e55b3a90ec` is still `in_progress`; check it first so a third attempt doesn't duplicate real work.