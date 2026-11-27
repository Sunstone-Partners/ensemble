# Local CI Gate - Speed and Fidelity Measurement

Period: 2026-10-22. One measured run of each kind, on one machine (macOS arm64; host Node 22.23.3; the gate fetched Node 22 and 24 with `npx -p node@<major>`). This is a single run, not a cohort: treat the figures as indicative.
Head commit compared: b9208b5b6fa4a307105094c4d9d42837067000c2 (the head of PR #189; hosted CI ran on this same commit).
Basis for verdict: cold local run vs hosted; equal means within 30000 ms.

| Node | Local cold | Local warm | Hosted | Verdict |
| --- | --- | --- | --- | --- |
| both (22 + 24 sequentially) | 334.3s | 303.8s | 185.0s | slower |

How the figures were taken, so they can be repeated:

- **Local** is the real gate CLI (`local-ci-cli.js gate`, `dryRun`) run on the head above, which runs all nine trusted steps on Node 22 and then on Node 24 in one process. Wall time covers both versions together; the gate does not record per-version or per-step time, so it cannot be split. **Cold** used an empty npm cache directory (real downloads); **warm** repeated the run with that cache populated. Both runs passed (`nodes: 22 ok, 24 ok`).
- **What was NOT timed:** `npm run ci:local` (the old template's capture procedure). The gate's trusted list has nine steps and `ci:local` six; the extra three (`reject-windows-invalid-filenames`, `check-package-json-consistency`, `validate-opencode-plugin-json`) are workflow steps `ci:local` does not run. The gate is what a maintainer waits for after enablement, so it is what was measured, and it is slightly heavier than `ci:local` on the same commit. `ci:local` was measured earlier at about 130 s for a single Node version, one run, which is not comparable to the table.
- **Hosted** is read from `gh api repos/Sunstone-Partners/ensemble/commits/<sha>/check-runs` (`completed_at - started_at`): `validate` 49 s, `test (22)` 185 s, `test (24)` 160 s. Hosted runs these as parallel jobs, so the workflow takes as long as the slowest, **185 s**, which is the figure used.
- **The verdict depends on that choice.** Against 185 s (what a person actually waits for) the gate is slower. Had hosted been counted as if run one job after another (394 s), the library would call the gate faster. The parallel wall-clock is the fair comparison and is the one recorded.
- Host differences are not controlled: a laptop against GitHub's hosted runners. Other load on the laptop during the runs was not measured.

Verdict: slower

The local gate is slower than hosted CI; the benefit for this repository comes from removing the bot-review wait, not from run time.

No speed target is asserted. Context from `BASELINE.md` (last 30 merged PRs to `dev`): open-to-merge median 105.9 min and hosted CI wait median 2.6 min, so the time a PR spends waiting is review and bots, not CI.

## Fidelity gaps

Not "none". Known differences between the gate and hosted CI:

- **Checkout depth.** The gate clones with full git history; hosted CI checks out with `fetch-depth: 1`. A test that needs history can pass in the gate and fail on hosted. This happened on PR #189: `local-ci-pr-merge-integration.test.js` ran `git show` on an old commit, passed in the gate, and failed both hosted `test` jobs. The test is fixed and the whole development suite passes in a depth-1 clone, but the gate itself still clones deep, so other tests could differ.
- **Hosted-only jobs.** The gate runs the `validate` and `test` workflows (the three checks `dev` requires today). Hosted CI also runs CodeQL, `gitleaks`, `pr-size`, the reviewdog linters (eslint, markdownlint, actionlint), `drift` and the `generate` jobs, which the gate does not run. None is a required check on `dev` today, so enabling the gate leaves them running but not blocking. `gitleaks` is the one that matters: it failed on PR #189 while the gate passed.
- **Same commit, same result.** At the commit above both the gate and the three required hosted checks passed. One commit, one machine: it shows no disagreement at this head, not that none can occur.
