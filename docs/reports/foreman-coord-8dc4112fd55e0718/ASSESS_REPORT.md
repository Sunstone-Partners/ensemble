assess phase done.

**Artifact**: `docs/reports/foreman-coord-8dc4112fd55e0718/ASSESS_REPORT.md` (21.9 KB, all 5 required sections + evidence tables)

**Read-only confirmed**: `git diff --stat dev HEAD` empty, 0 commits, no PR. `dev == origin/dev == HEAD == a0d6a213`.

**Preliminary verdicts** (cited w/ file:line + real cmd output):

| Defect | Verdict | Evidence |
|---|---|---|
| 1 inline MoSCoW | **FIXED** | `packages/development/lib/prd-parser.js:73,78,89-95,105-137`; commit `4c9e2e78`; `tests/prd-parser.test.js` 26/26, exit 0 |
| 2 TRD `prd_reference`/`prd_path` | **FIXED** (caveat) | `packages/development/lib/trd-parser.js:206,212,382,402-437`; commits `712bd4bb`,`bb052ad7`; `tests/trd-frontmatter-key-spelling.test.js` 14/14. Caveat: `prdReference` non-null **only if a path exists** — id-only ref still null by design |
| 3 Foreman env detection | **PARTIALLY FIXED** | new-feature chain OK (`ensemble-new-feature/SKILL.md:30`, commit `5b6c0028`, guard `tests/helpers/foreman-invariants.js:132-143`); **gap**: front door `skills/ensemble-feature/SKILL.md:37` accepts only literal `--foreman` token, `FOREMAN_TASK_TITLE` count = 0 in that file, and `checkFrontDoor` (`:157`) asserts no env rule → nothing can fail on it |

**Gates**: 51/51 foreman suites, exit 0 · `npm run generate:validate` exit 0 (64 files, no drift) · `npx jest tests/helpers` → exit 1 "no tests found" (helpers ≠ tests, expected; guarded by the 2 consuming suites) · `pi --provider litellm-stack --model MiniMax-M3` → `OK` → provider fine, nothing skipped.

**Progress tools**: `foreman_inbox_send` sent (msg_X-sTBDoep80j-3TVS8vqAg start, msg_WZGLHMotb2A92MJrVcb20w complete). `foreman_task_add_comment` failed twice — `INVALID_STATE: Task external_id is malformed` (args match schema; provider-side) → recorded in report §0.

Next phase: publish final verification artifact, **open no PR**, report defect 3 as PARTIALLY FIXED. Front-door gap fix = operator call (additive SKILL.md edit + `checkFrontDoor` guard + `npm run generate`/`generate:pi`).