### Phase 4: Quality Gate

`gate-<N>` runs `implement gate` per complete phase: the whole suite, the result recorded on the story, and in single-PR mode the story closed and a checkpoint committed. Stacked, the story stays open until its PR exists: `pr-<N>` runs `implement pr --phase <N>`, and the next branch is appended only after the PR is confirmed created.

#### Judgement in this phase

- A red gate under tdd, refactor or bug-fix is the user's decision (`NEEDS_CHOICE`: fix, skip or abort); characterization and flexible strategies record it as information. Never decide for them.
- The PR's Risk and How to revert prose is yours (`NEEDS_AGENT`, role `pr-prose`): reference section 3. The engine inserts it unedited and refuses a body the grader rejects.
- Review procedure: packages/development/skills/pr-review-cycle/SKILL.md (via tool-path-resolution); criteria: reference section 3. Only `localPhase == 'LOCAL_REVIEW_COMPLETE'` passes; anything else blocks with the story open, no PR and no branch append.
