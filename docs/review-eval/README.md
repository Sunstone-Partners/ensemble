# Review eval set

Escaped-bug cases the review pipeline must keep finding, and the guard that fails
when it does not (kata `cwd4`; plan: `docs/plans/pr-review-speedup-plan.md`
section 5, third bullet: *a faster run that loses a real Important finding is a
regression, not a win*).

| Path | What it is |
|---|---|
| `cases/<id>.json` | One case per file, shape of `packages/development/skills/pr-review-eval/case-template.json`. `change` carries the PR link **and the 40-hex commit the line range is pinned to**, so later drift in the base branch cannot move a case. |
| `baselines/deep-review-reconstructed.json` | The findings the current deep review reports for those cases, in `{ findingsByCase }` form. See "Provenance". |
| `history.jsonl` | One line per guard run: per-case found/not, total, false-negative rate, reviewer label, pass. |

## Running the guard

```bash
node packages/development/lib/review-eval-guard.js \
  --findings <pipeline findings.json> \
  --history docs/review-eval/history.jsonl --reviewer <label>
```

Exit 0 only when every expected Important finding is present; exit 1 otherwise,
with the missed case ids and the false-negative rate in the JSON on stdout. A
pipeline-changing child (`runner`, `verifyassign`, `shard`, `carry`) runs this
before it lands and records the result in its PR. How the guard decides is in
the header of `packages/development/lib/review-eval-guard.js`; the procedure
is `packages/development/skills/pr-review-eval/SKILL.md`, Step R3a.

## Cases

| Case | Where it was found | Pinned at |
|---|---|---|
| `pr228-v1-…` | #228 merge review, V-1 (`scripts/validate-all.js:273-284`) | #228 head `7d4d9d28` |
| `pr233-f01-…`, `-f02-…`, `-f03-…` | #233 fix round 1 (commit `86a8c9b`) | `39674722` (the commit before that fix) |
| `pr233-n01-…`, `-n05-n06-…`, `-n12-…` | #233 fix round 2 (commit `67764f6`) | `86a8c9b5` (the commit before that fix) |
| `pr234-verdict-count-…`, `pr234-slice-sharding-…` | #234 correction commit `8a202c6`: 145 not 180 verdicts, slicing is not two independent passes | `c700622b` (the commit before that correction) |

## Provenance and limits

- The raw review ledgers for #228 and #233 were not persisted. Cases and
  baseline findings are **reconstructed** from the #228 merge-review comment,
  the #233 and #234 fix-commit messages and the code at the pinned commits. The
  line ranges were read from the pinned commits; the guard re-checks that each
  file has those lines at its commit whenever the commit is in the checkout, and
  reports `unverifiable` (not `verified`) when it is not, as in a shallow clone.
- Only V-1 is recorded with the severity the review gave it. The #233 and #234
  findings are treated as Important because the fix commits describe them as
  ways to defeat the approval floor or as real errors found by the review;
  that is an inference the code owner confirms by merging these files.
  `confirmedBy` names the CODEOWNERS owner of each path; `validateCase` checks
  the name against `.github/CODEOWNERS`, it cannot check that the person said so.
- #233 findings F-04 and F-21/F-22 and the #235 review items N2-01, F-04 and
  F-05 are **not** cases: the first are of unrecorded severity, and the #235
  items are a Nit, a Nit and a Pre-existing finding, which the eval library
  never counts as found (only an Important finding anchored inside the range
  does). N-05 and N-06 are recorded as one case because they share one fix and
  one location.
- The baseline is the output of the pipeline as it was, not a captured run of
  today's code. It proves the guard accepts a complete output and rejects an
  incomplete one; a pipeline child proves itself by running its own output
  through the guard.
- A case goes stale when `REVIEW.md` changes (its `rulesHash` is the blob hash of
  `REVIEW.md` when the case was written). The guard lists stale cases for owner
  re-review; a stale case still has to be satisfied.
