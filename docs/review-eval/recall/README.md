# Recall guard: did the review lose a known Important finding?

Plan section 5: *a faster run that loses a real Important finding is a regression, not a win.* This directory holds a **reference
set** per reviewed head and the procedure that scores a run against it, so two measurements are comparable (kata `yg7k`).

```sh
node packages/development/lib/review-recall-guard.js \
  --reference docs/review-eval/recall/pr207-48c862c.json \
  --findings  <the run's collect output, or its .ensemble/pr-review/pr-<n>.json state>   # an array, or an object with `ledger` / `findings`
  [--max-false-negative 0]   # default 0: any lost Important finding fails (exit 1); 2 = unreadable input, never a pass
```

Output is one JSON line: per item `found` (an Important finding matches), `downgraded` (the defect was raised, but only as a Nit /
Pre-existing, which the review defers, so for the guard it is lost), `not-raised`; plus `falseNegativeRate` =
(downgraded + not-raised) / items and `notRaisedRate`. The two rates say different things: `notRaisedRate` is a reading failure (the
reviewers never saw or never reported it), the downgraded part is a grading failure.

A reference item gives `terms` (lists of words; a finding matches when its `failureMode`, and `evidence` if the ledger has it, holds
every word of one list) and/or `anchors` (`path`, `startLine`, `endLine`; a finding matches within `--slack` lines, default 3). Pick
words only the defect uses: a finding that merely mentions them is counted. The match is by wording and place, not by understanding, so
read `matchedBy` in the output before trusting a `found`. The fixture check in
`packages/development/tests/review-recall-guard.test.js` pins the measured run's score.

`review-eval-guard.js` is the other guard: it grades CODEOWNERS-confirmed cases from the base commit by location alone. Use this one
to compare two runs on the same head, and that one to gate a change.

## The measurement this reproduces (first Medium run, PR 207, head 48c862c, effort hi, 7 reviewers + lane, 17 verifiers)

`pr207-48c862c.json` lists the six Important findings an earlier multi-reviewer pass confirmed on this head. Scored against the run's
ledger (`tests/fixtures/review-recall/pr207-medium-run-ledger.json`): **1 found (E1), 1 downgraded (E4: three reviewers raised it as a
Nit), 4 not raised (E2, E3, E5, E6): false-negative 5/6, not raised 4/6.**

## Why each was lost (from the run files: briefs, results, verifier votes)

| Item | Where it was reviewed | What the data shows | Cause |
|---|---|---|---|
| E1 | three reviewers, three files | raised 3 times, all verified real 3/3 | found; the duplicates cost nine verifier passes (one root cause, three locations; not mergeable by location) |
| E4 | `lib/spec-writer.js` slice read by two reviewers, whole-range reader, docs slice | raised in five places, always graded `nit` | **grading**: the reviewer brief gave the words `important` and `nit` and no definition; a defect in a new opt-in path read as "not default-on, so a nit" |
| E2, E3, E5 | `lib/spec-writer.js` / `lib/e2e-framework.js`, read by correctness + tests reviewers and the whole-range reader | never raised. Each needs the code **run** (a regex that also matches `[Theory]`, a splice position, a thrown `ENOENT`); the brief allowed **one** snippet per reviewer and the correctness reviewer spent it on a nit (a quote style in a regex) | **budget** (brief): one snippet, 40 tool calls, against the earlier review's 73 to 144 calls and probe-confirmed findings |
| E6 | `agents/playwright-tester.yaml`, docs slice, read under `correctness` + `security` | never raised; a cross-file contract (a request shape documented in one file, consumed in another) | **reviewer effort / lens**: no code path shows it was filtered; the verifiers were never asked about it |

What the data does **not** show: verifiers rejecting a real finding (every raised candidate that returned votes was confirmed), a triage
or dedupe step dropping one, or a runner screen dropping one (nothing was unbriefable). So causes (b), (c) and (d-screens) are ruled out for
this run; the loss is at reading (a) and at the reviewer's own grading.

## What changed, and what it cannot fix

Code (kata `yg7k`): the reviewer and whole-range briefs now state `Tool calls` and `Throwaway snippets` from the policy (defaults 40 and
**3**, was 1) and say to spend snippets on a claim about what code *does*; the reviewer contract carries a severity guide (what a user or caller
gets, not how new or rare the path is; a defect in an opt-in feature is Important when a user who opts in hits it) and asks for one
finding per root cause. Verifier briefs are untouched: independence, the one-claim-per-verifier brief and the vote rules hold.

Not fixable in code, stated plainly: whether a reviewer *thinks* to run `detectE2eFrameworkInDir('/no/such/dir')`, or notices that a
documented option is read nowhere, is the model's depth. The knobs that buy it are operator settings in the `ensemble-review-policy`
block of `REVIEW.md`, each with a cost:

| Knob | Default | Buys | Costs |
|---|---|---|---|
| `reviewerToolCalls` (10-200) | 40 | deeper reading and more probes per reviewer | wall time and tokens up to the cap per reviewer, 7 to 8 reviewers a Medium run; raise `deadlineMinutes.reviewer` with it or a reviewer that uses its budget is reported not reviewed |
| `reviewerSnippets` (1-10) | 3 | the "does it actually throw / match" probes the earlier review made | a few more tool calls only; each is a short read-only command |
| `effort` of the dispatcher's agent call (not a policy key: the dispatcher sets it) | the agent default | more reasoning per reviewer | tokens and time, unmeasured here |
| lenses per slice (`depth.standard.reviewers`) | 2 | a third lens on a slice (another pass over the same paths) | one more reviewer per slice |

None of these is proven to recover E2, E3, E5 or E6: the next measurement is the test. Re-run the same PR with the same reference and
report `falseNegativeRate` and the wall time beside it.
