

Phase 2 complete.

**CodeRabbit CLI** — 3 rounds, `coderabbit review --agent --base dev`, exit 0 each (v0.9.6), same 11-file set vs dev each round.

**Findings: 7 → 5 fixed outright, 2 fixed in doc half / declined in remediation**
- R1-1 ✅ test env isolation (`hook-contract.test.js:63` — reset `ENSEMBLE_PERMITTER_DISABLE=0` before `...opts.env`)
- R1-2 ✅ TRD §4.1 example → new stdout contract + Appendix C
- R2-1 ✅ TRD §3.2 pipeline = deny-pass then allow-pass
- R2-2 ✅ doc half / ⛔ schema switch (D1: needs another hook event, re-emits invalid `ask`)
- R2-3 ⛔ remediation (D2) / ✅ doc half sharpened (settings-error rows; guarantee stated as "only where the hook runs"; malformed settings = skipped = fail-open, stated in TRD §5.3, README, AC6, PR body `## Risk`)
- R3-1 ✅ diagram; R3-2 ✅ settings-error precision
- Plus advisor-driven F7: env-var polarity (`PERMITTER_ENABLED` → `ENSEMBLE_PERMITTER_DISABLE`), real test-file names, contract wording

**Gates (real exit codes, re-run after last FIX_REPORT edit)**
- `npm run generate:validate` = 0 · `npm run validate` = 0
- `cd packages/permitter && npx jest tests/hook-contract.test.js` = 0 (21 passed)
- `cd packages/permitter && npx jest` = 0 (8 suites, 574 passed)
- Failing-first: dev hook sources vs new tests = 19 failed / 2 passed (exit 1); fix stashed + `ENSEMBLE_PERMITTER_DISABLE=1` = 10 failed / 11 passed
- markdownlint measured dev→now per rule (MD004 65→69, MD007 70→74, others flat); every MD004/MD007 hit is a JS sample line, no prose list added

**Unresolved (need human)** — in report markers
- `docs/PRD/completed/permitter.md:103` Major — archived PRD still documents old PreToolUse/exit-1 protocol
- `packages/permitter/lib/allowlist-loader.js:42` Minor — malformed settings file skipped (intentional fail-open)
- `docs/TRD/permitter.md:1226` Minor — deliverables tree lists two non-existent `packages/permitter/docs` files

**State:** uncommitted for Foreman — M `docs/TRD/permitter.md`, M `docs/reports/.../FIX_REPORT.md`, M `packages/permitter/README.md`, M `packages/permitter/tests/hook-contract.test.js`, ?? `docs/reports/foreman-ensemble-pdf-f6a2-permitter-hook-impl/REVIEW_CODERABBIT_REPORT.md`.

**Progress tools:** inbox note sent (`msg_Sf6jt0BmUu0wU1wa1H5zVw`); `foreman_task_add_comment` failed — `Error: Task external_id is malformed`.