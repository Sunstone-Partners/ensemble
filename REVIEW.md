# Review Rules

What a reviewer of **ensemble-plugins** should care about. This file is prose
and data a maintainer edits directly: change it and the next review reflects
the change — no code change, rebuild or release. Every review reads the copy
on the **base branch**, never the copy on a pull request's head, so a PR
cannot relax its own review by editing this file.

## What every review checks

- **Behaviour is proven, not asserted.** A fix or feature carries a test that
  fails without the change. A claim like "verified" with no command behind it
  is a finding.
- **Nothing is silently dropped.** Errors are handled where they occur;
  fail-closed paths return a named reason instead of a plausible default.
- **No new dependency** without an explicit decision (Constitution §4), and no
  secret, token or credential anywhere in the tree.
- **Editable behaviour stays editable.** Criteria a maintainer tunes belong in
  Markdown (skills, agents, this file); only code that grades a model's claim
  belongs in `packages/*/lib/`.
- **Generated artifacts match their sources.** When a command, agent or skill
  source changes, the generated output is regenerated in the same PR
  (`npm run generate`, `npm run validate`).

## Severity

A review reports findings under exactly three words. The words are a closed
set the tooling enforces; **what each one means is the prose below**, and a
maintainer changes it by editing this section — no code change, rebuild or
release.

- **Important** — the change is wrong, unsafe or unproven: a defect a user or
  another agent would hit, a security or secret exposure, a gate that cannot
  fail, a claim with no command behind it, or a generated artifact that no
  longer matches its source. An Important finding must be answered before
  merge.
- **Nit** — a preference that does not change behaviour: naming, wording,
  ordering, formatting, a comment that could be clearer. A Nit never blocks a
  merge and is never worth a review round on its own.
- **Pre-existing** — a real defect in code this pull request did not
  introduce. It is reported separately, never blocks this PR, and belongs in
  an issue rather than this review.

Older ledgers written as Critical, Major, Minor or Nitpick are read as
Important (Critical, Major) and Nit (Minor, Nitpick); nothing is lost and no
blocking outcome changes. A word outside the set is treated as Important
until a person says otherwise.

## Area rules

Any directory may carry its own `REVIEW.md`. A change is reviewed against this
root file plus the nearest area file above it — for example
`packages/development/REVIEW.md` would govern everything under
`packages/development/`. When two area files conflict, the more restrictive
instruction wins. Policy keys below are read from this **root** file only;
area files carry guidance.

## Sensitive and high-risk areas

An owner declares sensitive areas in the `sensitivePaths` list below. A pull
request touching one of them is treated as sensitive by every review and
approval rule that consults sensitivity. The declared list **adds to** the
built-in floor (CI workflows, release gates, installers, the generation
pipeline and the project constitution); it can never shrink it.

## Policy

The fenced block below is the only place policy keys are read from. Keep
`sourceSha` pointing at the commit this policy takes effect from — refresh it
with `git rev-parse HEAD` after a change to this block lands on the default
branch. While it does not match a review's base commit, the strict defaults
apply (round cap 3, Quick at one reviewer and no verifier, no Low waiver),
which is the safe outcome, never a relaxed one.

```ensemble-review-policy
{
  "sourceSha": "4c1639e25ae0bba09d2dd533ffd9b7c29f9c8aa5",
  "roundCap": 3,
  "maintainerLogins": ["@ldangelo"],
  "botLogins": ["@coderabbitai", "@claude", "@github-actions"],
  "sensitivePaths": [
    ".github/workflows/**",
    ".github/actions/**",
    "scripts/validate-*",
    "scripts/publish-*",
    "scripts/release-*",
    "scripts/install-*",
    "scripts/generate-*",
    "scripts/generate-*/**",
    "docs/standards/constitution.md",
    "REVIEW.md",
    ".github/CODEOWNERS",
    ".github/pull_request_template.md",
    "packages/development/lib/pr-review-*.js"
  ],
  "highPaths": [
    "packages/development/lib/**",
    "packages/agent-core/**",
    "packages/pi-extension/**"
  ],
  "lowWaiverEnabled": false,
  "sliceThreshold": 1500
}
```

| Key | Meaning |
|---|---|
| `sourceSha` | The commit this policy is in force at. A mismatch means strict defaults. |
| `roundCap` | Review rounds before the cycle escalates (1–5; 3 here). |
| `maintainerLogins` | Logins whose approval counts for this repository. |
| `botLogins` | Review bots. A bot approval never satisfies a human-approval requirement. |
| `sensitivePaths` | Owner-declared sensitive areas, added to the built-in floor. |
| `highPaths` | Areas that start at the High risk tier. |
| `lowWaiverEnabled` | Whether a Low-risk PR may waive review with evidence (off here). |
| `sliceThreshold` | Changed-line count above which a PR is reviewed in slices. |

## Ownership

`.github/CODEOWNERS` declares who owns each area. Ownership is read from the
base branch alongside this file.
