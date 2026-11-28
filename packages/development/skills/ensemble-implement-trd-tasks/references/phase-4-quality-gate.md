### Phase 4: Quality Gate

Step `gate-<N>` runs `implement gate` for each complete phase, in order: the whole suite, the result recorded on the phase story, and in single-PR mode the story closed and a checkpoint committed. In stacked mode the story stays open until its pull request exists: step `pr-<N>` runs `implement pr --phase <N>` and the next branch is appended only after the PR is confirmed created.

#### Judgement in this phase

- A red gate under tdd, refactor or bug-fix is the user's decision (`NEEDS_CHOICE`: fix, skip or abort); characterization and flexible strategies record it as information. Never decide it for them.
- The PR's Risk and How to revert prose is yours (`NEEDS_AGENT`, role `pr-prose`): `implement-trd-tasks-reference` section 3. The engine inserts it unedited and refuses a body the grader rejects.
- Local review criteria for the phase: section 3. Only a completed local review passes; anything else blocks with the story still open, no PR and no branch append.
