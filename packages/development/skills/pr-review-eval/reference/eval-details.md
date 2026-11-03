# PR Review Eval -- reference detail

Companion to `SKILL.md`. Read the section you need; every normative rule stays in `SKILL.md`.

## A1 -- Case record fields

| Field | What it is | Refusal when missing |
|---|---|---|
| `id` | Short, file-safe identifier (`^[A-Za-z0-9][A-Za-z0-9._-]*$`). It becomes the file name. | `missing-field` / `invalid-case-id` |
| `change` | The change that escaped review: PR number or commit SHA, with a link. | `missing-field` |
| `bug` | What was actually wrong, in one or two sentences -- the defect, not the symptom. | `missing-field` |
| `location.path` | The repo-relative file the bug lived in. | `invalid-location` |
| `location.startLine`, `location.endLine` | The line range the bug lived in, as of the escaping change. Both integers >= 1 and `endLine >= startLine`. | `invalid-location` |
| `confirmedBy` | Login of the code owner who confirmed this is a real escaped bug in their area. | `missing-confirmation` |

## A3 -- Computing the rules file and hash

```bash
RULES_FILE="$(dirname "$CASE_PATH")/REVIEW.md"      # the area rules file, when one exists
[ -f "$REPO_ROOT/$RULES_FILE" ] || RULES_FILE="REVIEW.md"   # otherwise the root rules
RULES_HASH="$(git hash-object "$REPO_ROOT/$RULES_FILE")"
```

When the area rules for a path are not obvious, `pr-review-cli.js rules` returns `applied[]`: the rule files governing that path, most specific first.

## A4 -- Case file shape

```json
{
  "id": "2026-10-auth-token-expiry",
  "change": "https://github.com/<org>/<repo>/pull/1234",
  "bug": "The refresh path compared expiry in seconds against a millisecond timestamp, so every token read as expired.",
  "location": { "path": "packages/development/lib/pr-review-approvals.js", "startLine": 118, "endLine": 131 },
  "confirmedBy": "ldangelo",
  "rulesFile": "REVIEW.md",
  "rulesHash": "0d1e2f3a4b5c6d7e8f90a1b2c3d4e5f607182930"
}
```

Also: one case per file; never edit an existing case to describe a different bug (add a new one, so previous runs that scored the old case stay meaningful); no credentials, customer data or incident-report text beyond the two sentences `bug` needs.

## A5 -- Verifying the written case

```bash
jq -n --slurpfile c "<evalCasesDir>/<id>.json" \
  '{cases: $c, findingsByCase: ($c[0].id | {(.): []})}' \
  | node "$PR_REVIEW_CLI" eval-score
```

`cases[0].reason` must be `no-important-finding-at-location`: the record is readable, its `id` is the key a run scores it under, and its location anchors. `invalid-case` means the file is not a usable case; `no-findings-recorded` means the id did not round-trip. Fix it, or delete the file and refuse. Report `EVAL_CASE_ADDED` only after this passes.

## R3 -- Rules hashes

Build `rulesHashes` by computing the git blob hash of every distinct `rulesFile` the cases name, keyed by that path. A rules file left out of the map makes its cases stale: an unknown rules state is never "unchanged".

```bash
# R3.2 Compare with the previous run; a lower total is a regression, by name.
jq -n --slurpfile previous "$PREVIOUS_RUN" --slurpfile current /tmp/eval-run-today.json \
  '{previous: $previous[0], current: $current[0]}' \
  | node "$PR_REVIEW_CLI" eval-compare

# R3.3 Which cases need owner re-review because their rules file moved.
jq -n --slurpfile cases /tmp/eval-cases.json \
  --argjson hashes "$(jq -n '{}')" '{cases: $cases[0], rulesHashes: $hashes}' \
  | node "$PR_REVIEW_CLI" eval-stale
```
