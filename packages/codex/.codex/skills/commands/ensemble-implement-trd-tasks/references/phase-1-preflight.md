### Phase 1: Preflight

`implement next` derives all of this and returns it as `data.CONTEXT`. A refusal is printed verbatim and HALTs.

| Concern | Engine verb |
|---|---|
| Arguments, early exits, flag conflicts, `max parallel` | `implement args` |
| Capabilities preflight, git-town, branching strategy, PR backend, working tree | `implement env --preflight` |
| TRD selection and validation, resume or fresh run, staleness gate, strategy | `implement resume` |
| Branch intent, feature branch, PR plan, saved choices | `implement branch` |
| Team roster and agent aliases | `implement team` |

#### Judgement in this phase

- **Design readiness**: 3.0 to 3.99 warns and asks to continue (not interactive: continue); below 3.0 stops and suggests /ensemble:refine-trd.
- **Choices** (PR backend, branching strategy, tracker confirmation, TRD selection) come back as `NEEDS_CHOICE`. Ask them as the engine worded them, and pass the answer on every later call. Branch intent is asked only interactively: a non-interactive run takes the proposed branch.
- **Strategy**: `implement-trd-tasks-reference` section 2.
