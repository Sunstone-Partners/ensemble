### Phase 5: Completion

Steps `review-completion`, `close`, `sync-checkboxes` and `pr-completion` run `review run`, `implement close`, `implement sync-checkboxes` and `implement pr --completion`. `close` verifies completion itself, refuses while any bead is open or the whole-branch review is not complete for this HEAD, then closes the epic. `implement report` prints the completion report; `implement pr-review` reads the recorded review.

#### Judgement in this phase

- **Incomplete verification** is the user's call. Interactive: ask 'Proceed anyway (override)' or 'Stop, fix gaps first'; only an explicit override passes `--override-incomplete`. Not interactive: HALT before closure.
- **Review**: criteria in `implement-trd-tasks-reference` section 3. A blocked completion review HALTs with the epic open and no completion PR; a later run reviews fresh. Remote review status is informational and never blocks closure.
- **Report**: say to merge PR 1 first (it targets the default branch); git-town retargets the rest, plain-git needs manual retargeting. After every PR merges, `mv <trd_file> docs/TRD/completed/`.
