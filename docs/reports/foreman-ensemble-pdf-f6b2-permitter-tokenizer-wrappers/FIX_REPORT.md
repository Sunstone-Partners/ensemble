# FIX_REPORT — permitter tokenizer/wrapper hardening (task ensemble-pdf-f6b2-permitter-tokenizer-wrappers)

Status: IN PROGRESS.

## Root cause (verified on this tree, all 4 reproduced)

1. `tokenize()` (packages/permitter/lib/command-parser.js, single-quote branch ~:193): no `#` comment handling. `git status # don't run rm -rf /` → apostrophe inside the comment opens a quote run; result: `[{executable:"git",args:"status # dont run rm -rf /"}]` → matches `Bash(git:*)` and would be auto-allowed.
2. `normalizeSegment()` env wrapper (~:410-420): `env -C /tmp git status` → flag loop drops `-C`, keeps `/tmp`; next WRAPPER loop treats `/tmp` as the command → `{executable:"/tmp",args:"git status"}`. `env -S "git status"` → `{executable:"git status"}` (unparseable smuggle).
3. `normalizeSegment()` leading-assignment strip (~:371): `while (isEnvAssignment(tokens[0])) tokens.shift()` drops ANY `VAR=value`, incl. `PATH=/evil`, `LD_PRELOAD=/evil.so` → classified as plain `git status`.
4. `isEnvAssignment()` (~:332): only literal `NAME=` pattern; `IFS=$x git status` tokenizes to `['IFS=$x','git','status']` and `IFS=$x` does not match `^[A-Za-z_][A-Za-z0-9_]*=` … (it does match actually) — real failure: value with unquoted spaces, e.g. `IFS=$a b git status` classifies only first fragment `IFS=$a b`. Repro: `p.parseCommand('IFS=$a b git status')` → single segment with executable `IFS=$a b`.

## Change
TBD

## Tests
TBD

## Local verification
TBD

## Follow-ups
TBD

## Assumptions
TBD

## PR body
TBD
