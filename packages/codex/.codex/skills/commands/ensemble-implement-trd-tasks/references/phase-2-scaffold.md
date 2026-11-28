### Phase 2: Scaffold

Step `scaffold` runs `implement scaffold`: the epic, a story per phase, a bead per task, the dependency edges and the work-graph analysis, idempotent by title prefix, for both the beads and the kata tracker. It is skipped on resume and under `--execute`. `implement bead-health` reports and repairs labels, Foreman tags and a reopened task.

#### Judgement in this phase

- Work-graph findings (a cycle, a stale blocker) stop the run until fixed or refined with /ensemble:refine-beads. Unexpected blockers or a priority mismatch ask: continue, refine-beads or abort (not interactive: continue).
- A test bead carries its `Test AC:` scenarios. With BDD mode the specialist follows "TRD commands" in `packages/reqnroll/skills/reqnroll/SKILL.md`; otherwise it writes them in the repo's own framework. They go RED before the paired implementation goes GREEN.
- Scaffolding goes only to @beads-scaffold-specialist, never backend-developer, and no product code is written.
- Under `--plan` the run ends here (EXIT).
