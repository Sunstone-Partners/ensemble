# br-rmw collision-order audit — v2 (code fixed to plan Step 4)

Run 2026-09-23, ensemble-as-behaviors. Scripts: `scripts/collision-order-audit.js`
(determinism/ordering guard, exits non-zero on drift), `scripts/adversarial-phrase-sweep.js`
(br-ivv regression re-run).

## History

- **v1** closed the bead auditing the as-implemented `skill|phrase` dedupe against itself —
  deterministic but NOT the plan Step 4 contract the bead demanded. Wrong close.
- **v2 doc** then asserted code parity without any code change — fabricated; withdrawn
  (commit 55d485b note, reopen via `br reopen br-rmw`).
- **This commit** contains the actual fix.

## Contract now in code (`packages/router/hooks/router.js` `matchPhrases`)

One entry per skill (skill-name dedupe); longest matching phrase wins as the label;
sorted by skill name, stable prompt-position tie-break. Docstring states it; the audit
script's `expected()` encodes the same rule independently.

## Evidence after the fix

- Router Jest suites: **130/130 pass** (`phrases.test.js` untouched — its fixtures are
  single-phrase-hit cases; no test pinned the old per-phrase listing).
- `collision-order-audit.js`: **exit 0**; 8 compound + 30 pair probes x5 runs deterministic
  and contract-matching; multi-skill collision probes 3/8 (unchanged — `create a pr`
  prefix, tracked by br-ivv); per-skill hit lines collapsed from 3 to 1 on same-skill
  compound prompts.
- Live check: `merge the PR and get this PR green and land the PR` -> exactly one line,
  `get this pr green → merging-a-pr → run /ensemble:pr-merge` (longest-phrase label).
- br-ivv re-sweep (516 probes): identical totals (0 unexpected activations, 12 cross-hits
  = the known prefix collision).

## Notes

- Phrase-block shape change: users see ONE line per matching skill instead of per phrase.
  Suggestion semantics unchanged; `pi`-invocation note (router.js) still emitted when any
  `/ensemble:` command is present.
- Ordering is skill-name-major, NOT prompt order — deliberate per plan Step 4.
- Router's keyword surfaces (`matchSkills`, `agent_categories`) still come from the
  hand-committed, LLM-authored `router-rules.json` (`source: "generate-router-manifest
  command"`; nothing regenerates it on schedule — staleness only caught by re-running
  `/ensemble:generate-router-rules`). Phrase path is independent of it; relevant to
  br-ckm-style staleness audits.
