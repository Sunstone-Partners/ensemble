# br-ivv Adversarial Phrase False-Positive Log — ensemble-as-behaviors @ 71ca738+

Run 2026-09-23. 12 prompt-templates x 43 registry phrases = **516 probes** through the
real hook (`node packages/router/hooks/router.js`, stdin JSON), block-parsed for
`→ skill <name>` lines. Scripts: `scripts/adversarial-phrase-sweep.js` (raw rows →
`/tmp/ivv-raw.json`), `scripts/adversarial-phrase-report.js` (precision tables).
Reproducible: `node scripts/adversarial-phrase-sweep.js && node scripts/adversarial-phrase-report.js`.

## Result headline

- **0 unexpected skill activations.** Every firing on every probe is an exact substring
  hit on some phrase, by the documented matching contract.
- **473/473 negative-intent probes fired ≥1 skill** — 100% "false positive" by intent,
  but **462/473 are own-phrase hits** (the negation/question/trap template still contains
  the literal phrase → the owning skill surfaces). That is substring matching working
  exactly as designed; suggestion-only + "act only if it fits" framing absorbs the cost.
- **516/516 positive probes fired correctly**, 12/12 templates per phrase (perfect recall).
- **12 cross-phrase hits, one cause** — the entire precision loss of the registry in one row:

## Ambiguous phrases

| skill | phrase | defect | impact |
|---|---|---|---|
| `git-town` | `create a pr` | prefix of `create a prd` / `create a trd` (all prompts mentioning those phrases also surface git-town) | the ONLY collision: 12/516 probes |

**Recommendation for REQ-BEH-002**: add word-boundary to `create a pr`
(`" … \bcreate a pr\b"`-style — longest-match-wins, or exclude when followed by `d`/`ov`/`o`)
or drop the phrase — git-town is already covered by `create a pull request`.

## Per-phrase precision (all 43: identical shape)

Every phrase: `neg firings 11/11` (own-phrase substring, by design), `pos firings 1/1`,
`extra-skill hits` 0 except the 10 `create a pr*`-family rows. Full table:
`/tmp/ivv-report.md` (session-local; regenerate with the report script).

## False-negative companion note (from br-fnf run)

Prompts that name the artifact WITHOUT a registered verb-phrase — e.g.
"I need a PRD for the billing feature", "we should write requirements for X" — match
**zero** phrases (substring contract has no noun-only patterns). Recall gaps are in verb
phrasing coverage, not false positives. Candidates to seed: `draft the requirements`,
`spec out` (present), `requirements doc` (noun form), `PRD for`, `TRD for`.
Feeds REQ-BEH-002 alongside the collision fix.

## Method limits

- Templates cover 11 negative forms (negation x3, already-done, substring-trap, quoted-meta,
  what/why questions, past-tense, compound-neg, embedded-word) + 1 positive; no typos, no
  non-English, no multi-intent prompts.
- Registry as of 71ca738: 43 phrases / 6 skills. `glob` is a root devDependency; the sweep
  runs from the repo root.
