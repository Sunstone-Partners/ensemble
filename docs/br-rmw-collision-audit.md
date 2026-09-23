# br-rmw Multi-Skill Collision Ordering Audit — ensemble-as-behaviors

Run 2026-09-23. Script: `scripts/collision-order-audit.js` (reproducible:
`node scripts/collision-order-audit.js`; exits non-zero on any nondeterminism, sort
violation, or unexpected hit set).

## Contract under audit

`matchPhrases` as implemented: dedupe key `skill|phrase`, output sorted by skill name then
phrase-alphabetical. The approved plan Step 4 and this bead's original acceptance instead
specify **dedupe by skill name, sorted by skill name** — one entry per skill. This
spec-vs-implementation drift is why the bead is reopened; the audit below is valid for the
implemented contract and must be re-run against whichever side wins reconciliation.

## Method

- 8 hand-built compound probes (multi-skill prompts: PRD+git-town, TRD+pull-request,
  three merging-a-pr phrases in one prompt, etc.)
- 30 exhaustive pair probes: first phrase of every skill pair, both orderings.
- Each probe run 5x through the REAL hook (`execFileSync` + stdin JSON); outputs
  compared for byte-identity AND against the independently-computed expected hit set
  (substring test against the full registry).

## Results

- **Determinism: 38/38 probes × 5 runs byte-identical.** No ordering jitter.
- **Sort contract: PASS on every probe** — skill-major, phrase-alpha within skill, e.g.
  `creating-a-prd/create a prd` → `git-town/create a feature branch` →
  `git-town/create a pr`.
- **3/8 compound probes surface multi-skill collisions** (`create a prd` ∋
  `create a pr`, `create a trd` ∋ …): identical root cause as the `br-ivv` finding —
  git-town's `create a pr` phrase is a strict prefix of `create a prd`/`create a trd`.
  Ordering itself stays deterministic; the collision is a registry-content issue, not a
  comparator bug. Fix belongs with br-ivv's recommendation (word-boundary or drop).
- All 30 pair probes: skill order strictly alphabetical regardless of phrase order in
  the prompt.

## Verdict

Ordering is correct and deterministic; the audit script is a permanent regression guard
(exit≠0 on drift). Recorded: collisions observed == predicted from the prefix overlap;
no additional ambiguous pairs beyond `br-ivv`'s table.
