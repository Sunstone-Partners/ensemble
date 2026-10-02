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

const discovered = discoverBehaviorPackages("<repo root>", { authoring: {} });
const mine = discovered.find((d) => d.behaviorId === "investigate-test-failure");
const { compiled } = compile({ behaviors: [mine.manifest] });
const results = runFixtureConformance(
  "<repo root>/packages/agent-core/behaviors/investigate-test-failure",
  { behaviors: [mine.manifest] },
  // Records this package's first passing run as its authoring completion in
  // <repo root>/.ensemble/state/authoring.json.
  { authoring: { rootDir: "<repo root>" } },
);
```

Authoring timestamps (REQ-029): the first discovery of a package records its
authoring start, and its first passing conformance run records its
completion. Each is written once and never overwritten. In an armed
repository the extension does both on its own at activation. It records the
start of every package it discovers, and runs the fixtures of every loaded
package that has all three fixture directories and no completion yet. Nobody
needs to call anything for the timestamps to exist; a change is seen at the
next session start. Library callers record only when they pass `authoring`,
as above. A run with a failing or unconstructible fixture, or with no
fixtures at all, is not a pass and records nothing.

Capabilities: `read`, `grep`, `glob`, `bash.test`, `git.diff`.
Mutation classes: `artifact.write`, `pr.open`, `constitution.propose`
(distinct from the tool grant above — a tool grant never implies
mutation authority).
