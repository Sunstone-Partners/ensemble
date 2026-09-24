# investigate-test-failure

A real, working example behavior package (source:
`docs/architecture/ensemble-behavior-runtime-plan.md` §7's worked
example) demonstrating the full pipeline built in TRD-2026-0fc1c1d0:

- `behavior.yaml` — the manifest, with an immutable digest stamped by
  `computeManifestDigest()` from `@sunstone-partners/ensemble-agent-core`.
- `constitution-rules.yaml` — policy context for this behavior's local
  execution (does not itself grant capabilities).
- `fixtures/events/` — sample raw events, one matching the trigger
  (`pytest-nonzero-exit.json`) and one that should not match
  (`pytest-passed.json`, exit code 0).
- `fixtures/expected-matches/` / `fixtures/expected-outcomes/` — the
  conformance fixtures `runFixtureConformance()` checks the compiled
  package against, structurally, for each event fixture.

## Verifying this package

```js
const { discoverBehaviorPackages, compile, runFixtureConformance } = require("@sunstone-partners/ensemble-agent-core");

const discovered = discoverBehaviorPackages("<repo root>");
const mine = discovered.find((d) => d.behaviorId === "investigate-test-failure");
const { compiled } = compile({ behaviors: [mine.manifest] });
const results = runFixtureConformance(
  "<repo root>/packages/core/behaviors/investigate-test-failure",
  { behaviors: [mine.manifest] },
);
```

Capabilities: `read`, `grep`, `glob`, `bash.test`, `git.diff`.
Mutation classes: `artifact.write`, `pr.open`, `constitution.propose`
(distinct from the tool grant above — a tool grant never implies
mutation authority).
