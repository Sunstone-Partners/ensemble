### Phase 1: Preflight

`implement next` derives all of this and returns it as `data.CONTEXT`. A refusal is printed verbatim and HALTs.

| Concern | Engine verb |
|---|---|
| Arguments, early exits, `max parallel` | `implement args` |
| Preflight, git-town, branching strategy, PR backend, working tree | `implement env --preflight` |
| TRD validation, resume, staleness gate, strategy | `implement resume` |
| Branch intent, feature branch, PR plan | `implement branch` |
| Team roster, agent aliases | `implement team` |

#### Judgement in this phase

- **Design readiness**: 3.0 to 3.99 warns and asks to continue (not interactive: continue); below 3.0 stops and suggests /ensemble:refine-trd.
- **Choices** (PR backend, TRD selection, a red gate) come back as `NEEDS_CHOICE`. Ask them as the engine worded them, and pass the answer on every later call. Branch intent is asked only interactively: a non-interactive run takes the proposed branch. A toolchain gate (a preflight or tracker confirmation not given) comes back as a refusal: print it and HALT.
- **Strategy**: `implement-trd-tasks-reference` section 2.
