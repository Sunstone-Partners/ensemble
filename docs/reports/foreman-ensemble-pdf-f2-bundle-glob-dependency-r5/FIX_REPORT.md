

**Phase done.** `fix` for `ensemble-pdf-f2-bundle-glob-dependency-r5` — 19 paths staged, uncommitted (Foreman owns commit + PR).

**Root cause** — `packages/core/skills/detect-stack/detect-stack.js` required npm `glob`; dereferenced `packages/full` bundle has no `glob` (only `ajv`+`js-yaml` vendored) → every wildcard lookup empty + `degraded: 'glob-unavailable'`. Validator missed it: skill files were non-blocking, and scanner read template literals as deps.

**Change**
- NEW `packages/core/skills/detect-stack/glob.js` — dependency-free matcher, exactly the glob(10) subset detect-stack uses (braces, `**`, `*/?`, dot rule, ignore, nodir, absolute, maxDepth; symlinks never followed). 24–30 ms/pattern vs npm glob 23–38 ms.
- `detect-stack.js` loads it; degraded plumbing gone.
- `scripts/validate-all.js` — code-aware bare-spec scanner (skips strings/template text; handles regex literals, divisions, `require.resolve`); **every** bundle file now blocking; `module.isBuiltin` (so `fs/promises` ok); `// validate-bundle-ignore` escape hatch (used nowhere in shipped code).
- `packages/full/package.json` — deps `ajv` + `js-yaml`; 20 peerDeps KEPT (reporter said 21; ranges match workspace; CHANGELOG:416 + VERSIONING_STRATEGY §3 make them the convention). `packages/core/package.json` declares `glob` devDep; lockfile +2 lines.

**Failing-first** — skill suite 9/10 red → 10/10; validator suite 7/44 red → 44/44. +24 equivalence tests vs npm glob 10.5.0.

**Verified** — `generate:validate` 0 · `validate` 0 · packages/core jest 18 suites/468 tests · validator jest 44 · eslint 0 err (3 warn: 2 ignored generated mirrors, 1 pre-existing) · markdownlint 0 (5 MD) · `npm ci --dry-run` 0 · dereferenced-bundle probe: all 4 axes answer with evidence, no degraded flag; old-vs-new envelopes identical.

**Pre-existing, unchanged** — packages/pi `lib-bundler.test.ts:723`; scripts toolchain-config + toolchain-detect (operator `~/.ensemble/toolchain.yaml`). Proven by stash.

**Follow-ups in report** — `packages/core/lib/detect-framework.js:21` still needs `glob` (ensemble-core plugin, not in full bundle) · dereferenced-install smoke test owned by another task · primary framework picked by first file, not rank.

**Caveats** — artifact got clobbered twice by a plain-git `workflow.push` tool-error wrapper; restored from index, final md5 `118191cd…` verified (backup `~/.omp/ensemble-pdf-f2-r5/FIX_REPORT.final.md`). `foreman_inbox_send` OK (msg `msg_GtKQ4sbvkc9XVZutUnGMIw`); `foreman_task_add_comment` failed server-side ("Task external_id is malformed"). Advisor budget exhausted after 4 reviews; last one's items all applied. Report: `docs/reports/foreman-ensemble-pdf-f2-bundle-glob-dependency-r5/FIX_REPORT.md` (incl. PR body, `Directed by: @ldangelo`).

Directed by: @ldangelo