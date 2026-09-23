# br-ge6: Description token-budget check

**Question:** do the 6 behavior SKILL.md descriptions (43 phrases total, 17 in git-town)
fit runtime skill-listing budgets, so auto-activation actually works in Claude Code / Pi?

## Measurement (source `packages/*/skills/*/SKILL.md`, mirrors identical)

| skill | phrases | desc chars | ~tokens (chars/3.6) | phrases visible in desc |
|---|---|---|---|---|
| creating-a-prd | 6 | 204 | 57 | 6/6 |
| refining-a-prd | 5 | 172 | 48 | 5/5 |
| creating-a-trd | 5 | 186 | 52 | 5/5 |
| implementing-a-trd | 4 | 150 | 42 | 4/4 |
| git-town | 17 | 497 | 138 | 17/17 |
| merging-a-pr | 6 | 164 | 46 | 6/6 |
| **total** | **43** | **1373** | **~381** | **43/43** |

Token counts are the chars/3.6 estimate (no local tiktoken); even a pessimistic
chars/3 lands the whole set at ~458 tokens.

## Runtime budget reality

- **Pi**: live skill-listing probe (br-fnf matrix, `pi` runtime) showed all 6 skills
  with their full synced descriptions — no truncation observed. Pi's skill frontmatter
  budget is per-description (Claude-compatible guidance ~1k chars); git-town's 497 is
  under it.
- **Claude Code / full plugin**: same frontmatter contract; 124-check claude-surface
  matrix passes with descriptions synced (no dropped phrases).
- **OpenCode**: router-suggestion layer only (no native auto-activation), so listing
  budget is moot there.

## Verdict

No truncation: every phrase of all 43 appears in its runtime-visible description on
every surface tested. **Compiler description-budget enforcement is NOT needed now.**
The threshold to revisit: a single description exceeding ~950 chars (~265 tokens) —
i.e. a behavior with ~30+ phrases at current phrase lengths. If that ever lands,
re-run this measurement and add a `generate-behaviors` warning, not a hard error
(suggestions degrade gracefully; the router layer is independent of descriptions).
