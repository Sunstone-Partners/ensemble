# br-rmw collision-order audit + matchPhrases contract reconciliation

Run 2026-09-23, ensemble-as-behaviors @ 71ca738+.
Script: `scripts/collision-order-audit.js` — reproducible via
`node scripts/collision-order-audit.js`; exits non-zero on nondeterminism, sort drift,
or unexpected hit sets. (Superseded doc: `docs/br-rmw-collision-audit.md`, v1.)

## v1 close and why it was reopened

v1 closed the bead by auditing the **as-implemented** contract (`skill|phrase` dedupe,
sorted skill-major then phrase-alpha) against itself — deterministic, 38 probes x5 runs,
byte-stable. That missed the bead's own acceptance and the approved plan Step 4: both
specify **deduped by skill name, sorted by skill name** — one entry per skill. Close was
wrong: redefining the contract instead of reconciling it. Reopened;
reconciliation bead `br-6fb` blocks.

## Contract truth (reconciled)

Authoritative artifact: the `matchPhrases` docstring in `packages/router/hooks/router.js`:
"one entry per skill (deduped by skill name); when several phrases hit the same skill the
longest wins as the label. Sorted by skill name; tie-break by first-match position in the
prompt (stable), so a multi-skill collision renders in a deterministic, run-independent
order." This IS "deduped by skill name, sorted by skill name" — the plan's wording holds.
The `skill|phrase` seen in code is the internal seen-set *key*, not the output shape.

## What the audit establishes

- **Determinism:** 8 compound + 30 pair probes, 5 runs each — byte-identical order every
  time; also verified live for same-skill two-phrase prompts in reversed mention order
  (`merge the PR then get this PR green` vs inverted): identical sequence
  (`get this pr green` then `merge pr` = registry order, not prompt order).
- **Multi-skill collisions:** 3/8 compound probes surface >1 skill, all traceable to
  git-town's `create a pr` being a prefix of `create a prd` / `create a trd` — the br-ivv
  finding. Ordering unaffected; content fix tracked there.
- **Pair probes:** 30/30 skill order strictly alphabetical.
- **v1 evidence (still valid):** 38 x 5 runs deterministic; collisions = known
  `create a pr` prefix; the prefix-collision table carries over.

## Honest scope notes

- The router's OTHER surfaces (`matchSkills` keyword path, `agent_categories`) come from
  `router-rules.json` (46 skills / 10 categories, `source: "generate-router-manifest
  command"`), rendered via `Object.entries` = file order. That file is LLM-authored and
  hand-committed; nothing regenerates it, so drift is only caught if
  `/ensemble:generate-router-rules` is re-run — same audit note applies to `br-ckm`-style
  staleness thinking. Phrase path is independent of it.
- The audit's cross-check (`expected()`) now mirrors the reconciled contract: one
  entry per skill, longest phrase wins, prompt-position tie-break. Exit 0 on current
  code confirms code == contract == plan.
