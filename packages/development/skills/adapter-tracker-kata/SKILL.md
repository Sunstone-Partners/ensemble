---
name: adapter-tracker-kata
description: kata issue tracker adapter for the toolchain `tracker` and `work-graph` categories (TRD-2026-6995dc96 TRD-002, PRD AC-001-1/AC-001-2/AC-001-4). Explicitly selected only, never auto-detected; loaded by the toolchain resolver, not invoked directly by name.
---

# Kata Tracker Adapter

Adapter (`adapter: kata`) for the toolchain `tracker` and `work-graph` categories, backing both with
the [`kata`](https://kata.sh) issue tracker daemon CLI. It is a skill directory, not a command: the
toolchain resolver (`packages/development/lib/toolchain/adapters.js#loadAdapter`) loads its
`adapter.yaml` manifest and runs its capabilities through
`packages/development/lib/toolchain/runner.js#runCapability`. Nothing in the repo invokes `kata`
directly through this skill's prose; the manifest is the contract.

Unlike the beads adapter, this one is **never selected automatically**. `toolchain.default.yaml`
keeps `tracker: beads`, and this manifest's `detect: []` is empty, so kata is reachable only when a
project's configuration names it explicitly (`tracker: kata`, or an explicit `work-graph: kata`).
AC-001-1 is the point of the manifest: naming kata in a project's configuration resolves **both**
categories to it, with no beads binary installed and no beads fallback path taken. See
"Selecting this adapter" below.

## Vocabulary

- `tracker.show`: read one kata issue, its comments, labels and links (`kata show <ref> --json`)
- `tracker.list`: list the project's open issues, uncapped (`kata list --limit 0 --json`)
- `tracker.create`: create one kata issue (`kata create <title> --body <description> --json`)
- `tracker.create-detailed`: create with priority plus the external dedupe key, as `--meta ext_key=...` and `--idempotency-key`
- `tracker.find-by-key`: list the whole project including closed (`--status all`), filtered by `--meta ext_key=${key}`; `lib/tracker-findings.js` picks the exact match
- `tracker.update`: REPLACE an issue's body (`kata edit <ref> --body <fields> --json`)
- `tracker.update-detailed`: title/body/priority in one call, note APPENDED via `--comment`
- `tracker.close`: id-only close, which kata refuses without a reason -- see "Known limits"
- `tracker.close-with-reason`: `kata close <ref> --done -m <reason> --commit <sha> --json`
- `tracker.comment`: append a comment (`kata comment <ref> -m <text> --json`)
- `tracker.comments`: the same `kata show <ref> --json` read -- kata has no comment-list subcommand
- `tracker.dep-add`: blocking edge (`kata edit <ref> --blocked-by <ref> --json`), keyed on `type`
- `tracker.dep-remove`: remove a blocking edge (`kata edit <ref> --remove-blocked-by <ref> --json`)
- `tracker.label`: attach ONE label to ONE issue (`kata label add <ref> <label> --json`)
- `tracker.set-status`: `in_progress` -> `kata claim`, `open` -> `kata unassign`; `closed` is not a variant, so closing through status is refused
- `tracker.sync`: `kata doctor --json`, the read-only state and connectivity check
- `tracker.stage-export`: `kata export --allow-running-daemon --output .kata-export.jsonl` -- kata's unscoped JSONL dump, written to a fixed relative path instead of a timestamped one
- `work-graph.ready`: unblocked open issues in kata's own order (`kata ready --limit 0 --json`)
- `work-graph.plan`: `kata next --json`, kata's highest-priority ready pickup
- `work-graph.graph-health`: `kata ready --limit 0 --json`; kata has no graph-health command

Required environment variables (`env: []` in `adapter.yaml`, NAMES only, never values):
`KATA_SERVER` (remote daemon URL), `KATA_AUTH_TOKEN` (its bearer token), `KATA_HOME` (local daemon
state), `KATA_AUTHOR` (acting actor), `KATA_TEAMMATE` (teammate attribution on comments and
events). None of their values appears in this file or in `adapter.yaml`; a `KATA_SERVER` pointing at
a real daemon means every capability below can write real work items to real infrastructure.

## Manifest

`adapter.yaml` declares each capability's exact `run[]` argv template and its `parse` output-mapping
block (the reasoning per entry is in that file's comments, not repeated here). `binaries: [kata]`
with one per-binary `allowlist[].sub` block listing the kata subcommands the runner will ever
execute (`validate.js#validateAllowlist` / `runner.js#denyRuntimeAllowlist`). The allowlist
distinguishes by subcommand words, so `label add` and `label rm` are each entries and bare `label`
is not.

Health is `kata --version` (PRD AC-001-2: that probe's output is the version source preflight
reports) plus `kata doctor --json`. `contract` pins `tracker: "1.0"` and `work-graph: "2.0"`.
`detect: []` is empty by design.

## Selecting this adapter

```console
$ cat .toolchain.yaml
tracker: kata
```

That one line resolves both categories to kata: `tracker.*` and `work-graph.*` alike, with beads
never consulted. A work-graph override narrows only its own category, so a project that wants kata
issues with a different dependency source says both things explicitly:

```console
$ cat .toolchain.yaml
tracker: kata
work-graph: beads
```

An empty or absent override resolves to the same adapter as `tracker`, never to a per-capability
mix of the two -- one issue system's ids are not valid refs in the other.

## Known limits

- **`tracker.close` is a refusal, not a close.** kata closes only with a reason and a substantive
  message; a bare `kata close <ref>` exits 2 with
  `{"error":{"kind":"usage","message":"close needs reason: --done (with --commit, --pr, --test, or
  --reviewed), --wontfix, --duplicate-of <ref>, --superseded-by <ref>, or --audit-no-change"}}`
  (captured live against kata 0.23.0). The contract's `tracker.close` inputs are `[id]` alone, so
  the reason and evidence cannot be carried, and `tracker.close-with-reason` is the capability that
  can close something. A caller-side `INVALID_ARG` naming that capability is TRD-011's; it cannot be
  expressed from this manifest without changing the category contract, and the existing validator is
  reused unchanged.

- **`tracker.close-with-reason` messages are length-checked by kata, not by the contract.**
  `--done -m "short"` is refused with "message too short for reason=done (need >=40 chars after
  normalization, got 14)" while the identical call with a longer message closes the item. So a
  placeholder reason fails loudly rather than closing work, but the threshold is kata's and is not
  part of any contract; callers must pass a real verification note.

- **`tracker.label` labels one issue with one label.** kata's `label add` takes exactly one ref and
  one label and answers with a singular `label` key; there is no bulk or multi-id form anywhere in
  the CLI. The contract's `ids`/`labels` inputs are each substituted into a single argv element by
  `runner.js#resolveArg`, so a comma-joined list arrives as one invalid ref or one invalid label and
  kata rejects the whole call rather than applying a subset. The contract's own answer for this
  shape is `tracker.label-one`, which says such adapters "MUST declare this rather than
  `tracker.label`" -- but it carries `addedInMinor: 1` and this manifest pins `tracker: "1.0"`, so
  `contracts.js#checkCompat` reports it unavailable and it is not declared here. TRD-012 owns raising
  the pin to `"1.1"`, declaring `tracker.label-one`, and the per-id sweep. `tracker.label` stays
  declared in the meantime because its contract entry names the `title-prefix-scoping` fallback and
  PRD AC-001-4 requires fallback-bearing capabilities to be declared.

- **No capability maps to an in-progress STATUS.** kata has no such status: an owned-but-open item
  IS in-progress, so `tracker.set-status` writes ownership (`claim`/`unassign`) and the reading is
  derived from a non-empty `owner` field (TRD-012, TRD-034). `closed` is absent from the variants and
  the base template is the `in_progress` one, so an unlisted `status` is rejected by
  `runner.js#selectTemplate` with `NOT_ALLOWED` listing the allowed values instead of falling
  through to a close.

- **Only `tracker.create` and `tracker.create-detailed` declare a `parse` block.** `runner.js`'s
  `CATEGORY_NORMALIZED_SCHEMA` Ajv-validates every *mapped* `tracker.*` result against the single
  work-item schema (`work-item.json`, `required: ["id"]`), keyed per CATEGORY rather than per
  capability, so a list, comment, label or status-shaped result mapped through it fails
  `BAD_OUTPUT: missing required property 'id'` -- the exact failure beads documents for its own
  `br list` mapping, after an inferred root made real creates fail *after* the write had landed.
  Captured shapes for kata 0.23.0: create returns `{kata_api_version, issue, event, ...}` with the
  id at `.issue.short_id`; `list` returns `{issues, complete, truncated, kata_api_version}`; `ready`
  returns `{issues, kata_api_version}`; `show` returns `{issue, comments, comments_truncated, labels,
  links, web_url}`; `next` returns `{issue}`; `doctor` returns `{checks, ...}`. Everything else keeps
  real argv and no `parse` block, leaving `data` as raw stdout for the caller. TRD-033 owns the
  normalized schema entries for the non-entity results, at which point these entries gain mappings.

- **`work-graph.plan` returns one issue, not a plan.** `kata next` is kata's sequential-pickup
  command and answers with a single highest-priority ready issue; the contract's
  `work-graph.plan` outputs are `[items, orderingSource, dependencyAware]`. The dotted-path mapping
  engine (`lib/toolchain/mapping.js`) has no wrap-into-array operator and no constant values, so
  `items` cannot be produced from `next` honestly and `orderingSource`/`dependencyAware` cannot be
  synthesised at all. The entry is declared because its contract entry names
  `work-graph-links-fallback` (AC-001-4), and the real plan is computed by the work-graph analyzer
  over the blocking edges `tracker.dep-add` writes. TRD-016 and TRD-018 own that.

- **`work-graph.graph-health` has no kata command.** No kata command computes cycles or stale
  blockers. `kata health` is *daemon* health and is deliberately not mapped here, since reporting
  daemon liveness as graph health would answer a different question than the one asked. The argv is
  the dependency-bearing `kata ready` listing, the cheapest call that reflects the edge set, and the
  findings come from the analyzer's per-item link reads. TRD-018 owns the computation; TRD Open
  Question 9 owns the honest `status`/`findings` semantics for trackers exposing no dependency data.

- **`tracker.sync` is not a flush.** kata keeps issue state in its daemon's database and has no
  flush command, so `kata doctor --json` stands in: read-only, no daemon start, no state change, and
  it reports whether the configured database is reachable. The contract declares `tracker.sync` as
  optional with NO fallback, so an adapter that does not declare it answers `NOT_ALLOWED`; declaring
  the closest real read-only check was the honest option. TRD-014 owns the final form.

- **`tracker.stage-export` writes a file; its `text` is NOT on stdout yet.** `kata export` dumps the
  whole database as JSONL to `--output <path>` rather than printing it, and refuses to read a live
  database without the flag (captured: exit 3, "daemon is running for this database; stop it or pass
  --allow-running-daemon"). The flag is part of the argv precisely because the capability must not
  disturb a working tracker, and no `--project-id` is sent, so it is the unscoped full dump the
  contract's `full-export-unscoped` fallback id names.
  `--output .kata-export.jsonl` is pinned so the destination is deterministic and local: left out,
  kata writes `kata-export-<UTC timestamp>.jsonl` into the child's cwd on every call (captured: 44
  stdout bytes, a 21707-byte file), accumulating one new file per call; with a fixed path the same
  file is rewritten in place (captured twice, rc=0). The path is relative to the child cwd, which
  `runner.js` inherits from the caller, and `beads-stage.js#stageBeadsExport` passes the git root,
  so the dump lands at `<git root>/.kata-export.jsonl`.
  **The remaining gap, stated plainly:** the contract declares `outputs: [text, status]`, and
  `runner.js` returns raw stdout as `data`, so this capability's `text` is currently just the
  confirmation line `exported .kata-export.jsonl` (captured), not the JSONL body. `--json` makes
  that strictly worse -- captured: it prints ZERO bytes while still writing the file -- so it is
  deliberately absent. Stdout cannot be the destination at all: `--output -` creates a file
  literally named `-`, and `/dev/stdout`, `/dev/fd/1` and `/dev/tty` all exit 1
  ("atomicfile: … is a symlink or junction" / "operation not permitted" / "no such file or
  directory") because kata writes through an atomic temp-file rename. TRD-014 owns closing this by
  reading `<git root>/.kata-export.jsonl` at the call site (the same file read `beads-stage.js`
  already does for a non-default `file` argument); TRD-033 owns the normalized-schema entry a
  mapped `text` result would need. Until then, `staged:false` semantics are unaffected: the
  capability succeeds and its `data` simply names where the export went.

- **`--priority` is an integer or `none`, not a letter.** `--priority p2` is rejected with "must be
  an integer or none" (captured). Callers passing the tracker contract's priority vocabulary must be
  normalized before the argv is built; `-` clears a priority. TRD-014 owns that mapping.

- **`tracker.list` does not use `--all`.** For kata, `--all` widens the *scope* to every active
  project instead of widening the current one (`kata list --help`), which would read another
  project's work. `--limit 0` lifts the 200-row cap within the current project. An uncapped listing
  on a large project is bounded only by the runner's `DEFAULT_MAX_BUFFER_BYTES` floor.

- **`tracker.show`/`tracker.comments` truncation is kata's, and it is visible.** `kata show` returns
  a `comments_truncated` flag alongside `comments`. Callers must read that flag rather than treat
  the array as complete (REQ-016 honesty, TRD-008 ordering).

- **A remote `KATA_SERVER` writes to real infrastructure.** Every mutating capability -- `create`,
  `create-detailed`, `update`, `update-detailed`, `close`, `close-with-reason`, `comment`,
  `dep-add`, `dep-remove`, `label`, `set-status` -- acts on whatever daemon `KATA_SERVER` and
  `KATA_AUTH_TOKEN` point at. Probe against an isolated `KATA_HOME` and a scratch project
  (`kata init --project <name>`) before pointing a run at a real one.

- **`kata` prints its errors on stdout as JSON, and the exit code is the signal.** Usage errors exit
  2 and validation errors exit 3, both with `{"error":{...}}` on stdout and nothing on stderr, so
  the runner's `TOOL_FAILED` envelope carries the message. Availability is decided by the health
  probe, never by parsing an error string.
