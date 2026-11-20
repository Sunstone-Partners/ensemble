Phase done. Both defects fixed, verified, reported.

## F4 — missing `jira` command
- **New** `packages/full/bin/jira` (0755, `#!/usr/bin/env node`, zero npm deps, global `fetch`): `issues read|list|create|update`, `comments create|list`, `--version`; env `JIRA_BASE_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN` (+`JIRA_PROJECT_KEY`), legacy `ATLASSIAN_*` fallbacks; one stderr line + non-zero exit on config/HTTP errors.
- `packages/full/package.json` gains `"bin": {"jira":"bin/jira"}` (+ matching `package-lock.json` entry — without it npm never links the command).
- Manifest `env:` now declares the 4 `JIRA_*` + 4 legacy names (`buildChildEnv` forwards only declared names → a rename alone would silently strip credentials).
- `scripts/validate-all.js` new `validateBundleBinaries()`: exists, executable, node shebang, builtin-only requires.
- Proof: `npm pack` → `bin/jira` in tarball (mode 0755); `npm install` → `.bin/jira` → `jira 1.0.0`; scratch git repo, PATH only the installed `.bin` → preflight's `jira-installed` passes, only `jira-auth` fails on missing creds (was `MISSING_BINARY: jira`).
- New `scripts/tests/toolchain-jira-bin.test.js` (13 tests): local http server, per-subcommand request assertions + the adapter's `mapOutput` over the binary's output. Red: 12/12 failed before the binary existed.

## F5 — status vocabulary
- Schema: `adapters.<adapterId>.statusMap` (provider→normalized) / `.statusNames` (normalized→provider), `additionalProperties:false`.
- `config.js#resolveAdapterOverrides` (project `.ensemble/toolchain.yaml` only) + new `lib/toolchain/status-overrides.js`; `runner.js` applies overrides when `opts.projectRoot`/`projectConfig` is given (CLI, trd-cli, tracker-findings, complexity-analyzer, work-graph builtin fallback now forward it).
- Write side rewrites only the `--status` value (`--status X` and `--status=X`); read side extends the capability's `parse.statusMap`. Unmapped status still fails `BAD_OUTPUT`, now naming `adapters.jira.statusMap` in the message.
- New `packages/development/tests/toolchain-status-overrides.test.js` (16 tests). Red on old code: 8 failed / 2 passed → green 16/16; defaults byte-identical without an override.

## Verification
`npm run generate:validate` 0 · `npm run validate` 0 · `npx jest scripts/tests` 93/95 suites (4 pre-existing env failures, proven on base) · `packages/development` 310/312 suites (2 pre-existing, proven on base) · generate + pi/codex mirrors regenerated, no Pi version bump.

## State / caveats
- Foreman's auto-commit `387389e4 "init"` landed mid-phase (captured sources, stale pi/codex mirrors, no report). **5 paths still uncommitted for Foreman**: the report, `package-lock.json`, the 2 regenerated mirrors, the new tests.
- Report: `docs/reports/foreman-ensemble-pdf-f4-f5-jira-adapter-v2-r5/FIX_REPORT.md` (34 952 B, md5 `144a7156…`, ends `Directed by: @ldangelo`).
- Incidents absorbed: another run clobbered the report twice and a `git stash` round-trip lost work (recovered via `git fsck --unreachable`); both noted in the report.