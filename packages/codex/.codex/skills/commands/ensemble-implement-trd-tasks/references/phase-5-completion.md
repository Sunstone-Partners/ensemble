### Phase 5: Completion

Steps `review-completion`, `close`, `sync-checkboxes` and `pr-completion` run `review run`, `implement close`, `implement sync-checkboxes` and `implement pr --completion`. `close` verifies completion itself, refuses while a bead is open or the whole-branch review is incomplete for this HEAD, then closes the epic. `implement report` prints it.

#### Judgement in this phase

- **Incomplete verification** is the user's call. Interactive: ask 'Proceed anyway (override)' or 'Stop, fix gaps first'; only an explicit override passes `--override-incomplete`. Not interactive: HALT.
- **Review**: criteria in reference section 3. A completion review that is not `localPhase == 'LOCAL_REVIEW_COMPLETE'` HALTs with the epic open and no completion PR; a later run reviews fresh. Remote review status is informational only.
- **Report**: merge PR 1 first (it targets the default branch); git-town retargets the rest, plain-git needs manual retargeting. Archive only after every PR has actually merged, by a person: `mv <trd_file> docs/TRD/completed/`; never while a PR is open.
