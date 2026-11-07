# PR review: carrying settled verdicts across heads

After a fix push the next review round used to verify every finding again, even
those the push could not have touched. `carry` decides, per candidate finding,
whether the verdict an earlier head settled still stands. Anything it is not
sure of is verified again: every rule fails toward re-verification, because a
wrong "carry" silently reuses a stale verdict.

```bash
node packages/development/lib/pr-review-cli.js carry < payload.json
```

`carry` is a pure pass-through to `planCarry` (`lib/pr-review-carry.js`). It
never reads a file, runs `git` or hashes anything: the hashes are inputs, made
by `lib/pr-review-carry-hash-cli.js` over git at the head under review.

## Flow

1. `review-range` answers `delta` and the prepare facts' `deltaPlan.mode` is `delta`. Otherwise nothing carries: verify everything.
2. Hash every candidate citation at the current head with `node "$PR_REVIEW_CARRY_HASH_CLI"` (`{ repoRoot?, headSha, citations }`).
3. Run `carry` with the input below.
4. Verify only the `reverify` candidates and the new ones, with independent fresh verifiers; the verification contract and `expectedVerifiers` are unchanged.
5. Record: stamp each `carried` finding `headSha = carried.head` and `carriedFrom = carried.carriedFrom`, append the new verdicts, and write the settled ones to the state report's `verdicts`.
6. Run `clearFixedFindings` explicitly for the `unmatched` and reverify findings.

An unreadable result, a failed hash or any doubt means: verify everything.

## Input

`priorVerdicts` and `candidates` are request parameters and must be arrays: a
missing or misspelt key is an error (exit 1), never read as empty. Every other
fact is graded in band; a missing one means re-verification (exit 0).

| Key | Meaning |
|---|---|
| `headSha`, `lastReviewedSha` | Full object ids: the head under review and the head the previous round reviewed (the delta's start). |
| `deltaPlan` | The `deltaPlan` of `facts.json`; only `mode: 'delta'` carries. |
| `deltaPaths` | The paths changed between the two heads (`facts.delta.changedPaths`). |
| `highPaths` | The High or sensitive paths from `paths`, changed or not. |
| `priorVerdicts` | The state report's `verdicts` of the previous round. |
| `candidates` | Every candidate this round has, hashed at `headSha`. A prior verdict is only ever carried onto one of these. |

## Record shapes

Prior verdict (the state report's `verdicts`):
`{ id?, file, claim, hunkHash, depHashes, head, carriedFrom?, outcome, votes[{ verifier, verdict }], incompleteVerifiers? }`.
Candidate: `{ id?, file, claim, hunkHash, depHashes }`. `hunkHash` is the sha256
of the cited hunk; `depHashes` is `{ path: sha256 }` of the files the cited file
imports (`{}` is "no dependencies"; absent or unreadable is "missing").

Output: `{ ok, carried[], reverify[], unmatched[], reasons[] }`.

- `carried`: the prior verdict and votes, `head` = the current head, `carriedFrom` = the head it was first settled on (kept through any number of carries). Stamping the current head keeps `mergeFindings` from re-opening it and `clearFixedFindings` from clearing it.
- `reverify`: `{ id?, file, claim, reasons[] }`, every reason that applies; the old head stays so `clearFixedFindings` can reconcile it.
- `unmatched`: a prior verdict no current candidate re-presents (`no-current-candidate`); it is never carried.
- `reasons`: the global reasons that apply to every candidate. `ok:false` only for an unreadable request.

A candidate is identified by its file and its claim, normalized (lower case,
punctuation and runs of whitespace flattened).

## Rules

Any one of these forces re-verification; all that apply are listed.

| Reason | When |
|---|---|
| `range-not-delta` | The delta plan is not a readable `delta`: a full range carries nothing. |
| `head-unknown` | The head, the last reviewed head or a verdict's own head is not a full object id. |
| `delta-paths-unreadable` | The delta's changed paths are not a list of paths. |
| `high-paths-unreadable` | The High/sensitive paths are not a list of paths. |
| `high-path-touched` | The delta touched a High or sensitive path: nothing carries, for any candidate. |
| `new-candidate` | No prior verdict for it. |
| `candidate-unreadable` | No file, a claim with no words, or a duplicate of another candidate's key. |
| `ambiguous-prior-verdict` | Two prior verdicts for one key. |
| `head-not-last-reviewed` | The verdict was last confirmed on a head other than the delta's start, so the delta does not cover everything that changed since. |
| `verdict-not-settled` | The outcome is not `present` or `filtered` (`disputed` and `unverified` are not settled), or it has no votes, or an assigned verifier was incomplete. |
| `hash-missing` | A prior or current hunk hash, or either dependency map, is missing or unreadable. |
| `cited-file-in-delta` | The cited file is among the delta's changed paths, whatever the hashes say. |
| `hunk-changed` | The cited hunk's hash differs. |
| `dependency-changed` | A dependency file is among the changed paths, or the dependency set or a hash differs. |

## Honest limits

- Callers and importers of the cited file are not part of the dependency hashes: a change in code that uses the cited file does not invalidate its verdict by itself. A change to a file the cited file imports does.
- Bare npm packages are not hashed, so an upgraded third-party dependency invalidates nothing.
- The transitive dependency closure is capped at 200 files; a larger one is not hashed (the citation gets `hashError`, hence `hash-missing`) rather than truncated.
- The per-vote count is not re-checked: only that the settled outcome has votes and no incomplete verifier. Whether those votes met the depth's quorum was decided when the verdict was settled.
- `carry` trusts the hashes it is given; it cannot tell a wrong hash from a right one.
