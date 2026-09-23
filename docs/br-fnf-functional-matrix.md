# br-fnf Functional Matrix — ensemble-as-behaviors @ 71ca738

Run 2026-09-23 from `/Users/ldangelo/Development/Sunstone/ensemble`.
Durable home for the Phase-1 validation evidence cited by beads issue `br-fnf` (epic `br-9yz`).

## Matrix (7 behaviors x 3 layers)

Layers: **[C]** compiled source truth (registry + synced SKILL.md descriptions);
**[R]** router hint path (`node packages/router/hooks/router.js`, deterministic, stdin JSON);
**[P]** Pi runtime activation (pi package registered via `~/.pi/agent/settings.json`
`packages` → live checkout, so a *new* pi session sees branch state; `~/.pi/agent/skills`
hand-copies are belt-and-braces, not authoritative).

| # | Behavior | Phrase probed | [C] | [R] | [P] |
|---|---|---|---|---|---|
| 1 | creating-a-prd → /ensemble:create-prd | "I need to create a PRD for the billing feature" | PASS — 6 phrases, description synced | PASS — block names `"create a prd" → creating-a-prd → run /ensemble:create-prd`; git-town collision listed | PASS — live pi probe listed the skill |
| 2 | creating-a-trd | "create a TRD for the auth service" | PASS (5) | PASS | PASS |
| 3 | merging-a-pr | "please merge the PR" / "the PR is failing, fix CI" | PASS (6) | PASS — both probes → `merging-a-pr → /ensemble:pr-merge` | PASS |
| 4 | refining-a-prd | "refine the PRD based on review" | PASS (5) | PASS | PASS |
| 5 | implementing-a-trd | "implement the TRD" | PASS (4) | PASS | PASS |
| 6 | git-town | "create a feature branch for the login fix" / "set up git-town for this repo" | PASS (17 phrases; no `command:` key by design) | PASS — collision lines without `→ run` segment, correct | PASS — probe echoed NEW synced description prefix ("Git-Town branch workflow: …") |
| 7 | test-failure observer | piped payloads → `packages/core/hooks/test-failure-observer.js` | PASS — 13/13 unit suite | PASS — a) passing: no log/no context; b) failing: exactly 1 row (kind/excerpt/session fields); c) identical retry: still 1 row | N/A — pi package ships `skills` only; hooks fire in Claude Code / full-plugin runtimes |

## Infra checks (all PASS)
- `behavior-phrases.json`: 43 phrases / 6 skills.
- Synced descriptions: `grep -l 'Use when the user says' packages/*/skills/*/SKILL.md` (excluding full/pi mirrors) = 6 files.
- Slash-command path untouched: 45 command YAMLs / 45 generated md (unchanged); all 5 bound commands exist as generated markdown.
- Router exits 0 on no-match; hooks present: router `UserPromptSubmit`, core `PostToolUse`, full all three.

## Discrepancies
- **D1 mechanism (corrected)**: pi loads skills from the live package path registered in
  `~/.pi/agent/settings.json` (`…/ensemble/packages/pi`) — there is no cache pi refreshes,
  so `pi update` cannot fix staleness; `~/.pi/agent/skills` (a real dir of per-skill copies,
  not a symlink target) holds duplicate copies that go stale silently.
- **D1 — pi install staleness — RESOLVED**: hand-synced `~/.pi/agent/skills` copies are NOT
  authoritative; the pi package is registered from the live repo path, so fresh sessions see
  branch state (probe confirmed). The stale copies predate this workstream.
- **D2 — pi hook delivery — OPEN for scope**: pi ships skills only; UserPromptSubmit/PostToolUse
  never run in a pi session. Whether pi gets hooks natively or Foreman's PiOmpAdapter injects
  behavior activation (runtime plan Sprint 4) is the open question; br-fnf evidence: pi sessions
  currently see neither phrase hints nor the learning log.
- **D3 — pi command naming — BY DESIGN (documentation gap only)**: `packages/pi/skills/*`
  carry `command: /ensemble-<cmd>` because pi's runnable invocation IS `/ensemble-<cmd>` —
  prompts are emitted as `prompts/ensemble-<cmd>.md` (`:` illegal on NTFS), and the
  blanket `ensemble:`→`ensemble-` rewrite in `skill-copier.ts`/`command-transformer.ts` is
  deliberate so a skill never points at a non-resolving name. The colon form in the compiled
  registry is equally correct for Claude-family runtimes. Dual-path holds per runtime: pi →
  `/ensemble-<cmd>`, Claude → `/ensemble:<cmd>`, same underlying command. The only gap was
  the registry hint being literal in Claude form — closed in router.js: `buildPhraseBlock`
  appends a one-line pi-invocation note, guarded by `packages/router/tests/pi-runtime.test.js`.
- Probe artifact: "I need a PRD…" (no literal "create a") matches **zero** phrases — substring
  contract as designed; logged for `br-ivv` (false-negative complement of its false-positive sweep).

## Operator hazard (must respect for later matrix tasks: zp8, c6d, rmw)
`~/.pi/agent/extensions/auto-commit-on-exit.ts` runs `git add -A && git commit` on
`session_shutdown` — globally, any repo; produced spurious sweep commit `4f32e0a` in this
checkout (reset+re-committed clean). Renamed → `.disabled` during this work; restore with
`mv` (check `pi config` for a scoped toggle before trusting a rename across pi versions).
Regardless of config state, treat every pi session in this repo as able to sweep: re-check
`git log`/`git status` immediately after each exit; prefer dedicated-worktree probes.

## Follow-up (same day): sweep source pinned — then corrected

- **Source: `auto-commit-on-exit.ts` itself** (per above). The interim note claiming a
  second, unidentified sweeper was a forensic error: an early commit made with `git add -A`
  swept pi's mid-run `tunnel-readiness-probe.js` into the tree; that file being present in
  a later shutdown commit was mistaken for fresh sweeping after the rename. Post-disable,
  every clean-exit probe (including one in the shared checkout) has left log and tree
  untouched. The SIGTERMed probes (exit 143) never ran shutdown handlers — they hung
  stdin-bound without a PTY, they did not sweep.
- **Belt-and-braces for later pi probes (zp8/c6d/rmw)**: run from a dedicated
  `git worktree` regardless; launch with a PTY (no-TTY `pi --print` hangs); verify
  `git log`/`git status` after every exit.
