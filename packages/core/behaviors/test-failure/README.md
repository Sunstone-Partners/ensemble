# investigate-test-failure (pilot behavior seed)

Seed for the doc's pilot behavior (§3.1 of
`docs/architecture/ensemble-foreman-behavior-runtime-plan.md`), authored before any
runtime exists. Purpose: probe whether the proposed declarative format can express
what the shipped deterministic hook expresses, and where it cannot.

## What mirrors the hook

- `trigger.predicate.command` = observer `TEST_COMMAND_RE`
  (`packages/core/hooks/test-failure-observer.js`), word-for-word alternation.
- `trigger.predicate.exit_code.not: 0` = observer `FAILURE_RE` in-band proxy —
  the hook only sees tool_response text, the behavior runtime sees real exit status.
  This is an expressiveness **gain**: the schema can state what the hook can only
  approximate.

## Expressiveness verdict (the deliverable)

The hook CANNOT express, and behavior.yaml CAN:

1. **Cooldown / dedup state** — hook logs every failure; 24h cooldown is
   unrepresentable in a stateless PostToolUse handler.
2. **Policy gating** — `mode: propose`, `max_concurrent`, approval requirements
   have no hook analogue; the hook's suggestion is unconditional injection.
3. **Causal graph** — `max_causal_depth` / `max_children` (behavior chains) are
   outside a single-shot hook's model entirely.

The hook CAN express, and this format leaves for the catalog/compiler:

- Per-run session correlation (`dedup_key` in the learning log) — runtime concern,
  not trigger semantics; noted so nobody re-adds it to `predicate`.

Gap found while authoring: `identity.failure_id` schema (used in the fixture) is
underdetermined by §3.1 — the doc never fixes hashing inputs. Filed as a plan
comment (see bead), not a blocker for the seed.

## Files

- `behavior.yaml` — the declaration (propose-mode, conservative defaults)
- `fixtures/events/test-failed.json` — one matching event envelope
- when S3 validation lands: `fixtures/expected-matches/test-failed.match.json`
