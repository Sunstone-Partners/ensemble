---
name: pr-review-explainer
description: Produce a short explainer for a named module from the code as it is now, naming every file it was derived from, and refuse (with a reason, and no explainer) when the named module has no readable source. Use when a maintainer asks "explain <module>" or accepts the High-tier explainer offer on a review report; do not use to explain a diff or a finding (that is `pr-review-cycle` / `pr-review-remediation`).
---

# PR Review Explainer

Answer one request: *"explain `<module>`"*. The answer is derived from the
working tree's current source, never from memory, never from documentation
alone, and it always ends with the list of files it was read from, so a reader
can check it (REQ-022, AC-022-1, AC-022-2).

This skill owns editable prose only (Constitution Rule 8): what an explainer
contains, how a module name is resolved to files, and how the High-tier offer
is served. It computes no gate and holds no timer. Sensitivity facts come
from `pr-review-cli.js paths`, which is the one place that knows the
repository's sensitive and High paths.

---

## Inputs

| Variable | Type | Description |
|---|---|---|
| `MODULE` | string | What the requester named: a path (`packages/development/lib/pr-review-votes.js`), a directory (`packages/development/lib`), or a bare name (`pr-review-votes`, `vote tally`). |
| `REPO_ROOT` | string | Repository root the resolution runs in. Resolution never leaves it. |
| `REQUESTED` | boolean | True only when a person asked. The High-tier offer (Step 5) produces **no** explainer until this is true. |
| `TIER` | `'low'` \| `'medium'` \| `'high'` (optional) | Recorded tier of the PR whose report carried the offer. Used by Step 5 only. |
| `SENSITIVE_PATHS` | string[] (optional) | Touched paths the caller already classified, so Step 5 does not re-run classification. |

## Outputs

Exactly one of:

- **`EXPLAINER_READY`** — the explainer text, ending with its `Derived from:` list.
- **`EXPLAINER_UNAVAILABLE`** — a one-line reason and **no explainer text**. This
  is the only honest answer when there is no readable source; a plausible
  summary written without reading code would be a fabrication (AC-022-2 is
  unmeetable without the file list).

Never both, and never an explainer with an empty or guessed `Derived from:` list.

---

## Step 1 -- Resolve `MODULE` to files

Resolve inside `REPO_ROOT` only, in this order; stop at the first that yields
at least one readable file:

1. `MODULE` is an existing file → that file.
2. `MODULE` is an existing directory → the source files directly in it (not
   recursively; a directory of directories resolves to nothing and falls
   through to 3).
3. Basename match: files whose name without extension equals `MODULE`
   (`pr-review-votes` → `lib/pr-review-votes.js`, plus its test file when one
   exists with a matching name).
4. Word match on file names, then on exported symbol names
   (`vote tally` → `tallyVotes` in `lib/pr-review-votes.js`).

Rules:

- A path that escapes `REPO_ROOT` (`..`, absolute path outside it) resolves to
  nothing. Untrusted text names the module; it never selects the file (REQ-024).
- Generated or vendored copies (`packages/pi/skills/**`, `packages/full/**`
  mirrors, `dist/`, `node_modules/`) are never the source of an explainer. If
  only a mirror matched, resolve to the file it mirrors.
- A file that cannot be read (missing, unreadable, or not text) is dropped from
  the set, and the drop is reported in Step 4's reason if nothing survives.

## Step 2 -- Stop when there is no readable source

If Step 1 resolved **no** readable file, return `EXPLAINER_UNAVAILABLE` with the
reason and stop:

```
EXPLAINER_UNAVAILABLE: no readable source for "<MODULE>" under <REPO_ROOT>
(<what was tried: no such path; no basename match; only generated mirrors matched; file unreadable>).
No explainer was produced.
```

Do not substitute documentation, a commit message, a test file alone, an older
revision, or prior knowledge of the module. "I cannot" is the required answer
here, and it is cheap: it costs one failed resolution, not a review round.

## Step 3 -- Read the current code

Read every resolved file **from the working tree as it is now** — not from a
base commit, not from an earlier review, not from a cached summary. If the
module's behaviour depends on a sibling it requires, read that sibling too and
add it to the derived-from list; do not describe a dependency you did not read.

Record, per file: its repo-relative path and the revision the tree is at
(the abbreviated HEAD commit id, plus `-dirty` when the file has uncommitted
changes). That pair is what makes "reflects the code as it is now" checkable.

## Step 4 -- Write the explainer

Keep it short enough to be produced and read in minutes (AC-022-1). Structure:

```
# <module name>

**What it is for** — one or two sentences, in the vocabulary of the repository.

**Entry points** — the exported functions/commands a caller actually uses, each
with its inputs and its one-line contract.

**How it decides** — the rules that matter: thresholds, defaults, ordering, and
what it refuses. Name the failure mode each rule exists to prevent.

**What it does not do** — the neighbouring responsibility a reader will expect
here and will not find, with the file that owns it instead.

Derived from:
- <repo-relative path> (<short-sha>[-dirty])
- ...
```

Constraints:

- Every claim traces to a line in a listed file. Where the code and a comment
  or a document disagree, the code wins and the disagreement is stated.
- Secrets and credential-shaped values are never reproduced, exactly as in the
  ledger's redaction rule (AC-024-2).
- `Derived from:` lists every file read and nothing else. A file listed but not
  read, or read but not listed, makes the explainer wrong even when the prose
  is right.

Return `EXPLAINER_READY` with that text.

## Step 5 -- The High-tier offer (skill side)

The review report decides *whether* to offer (that is TRD-043's half, in the
report). This skill defines what the offer means and what it does:

- The offer names one touched **sensitive** module per line, as classified by
  `pr-review-cli.js paths` (`sensitive: true`), using `SENSITIVE_PATHS` when the
  caller already computed it.
- An offer is an invitation, never a job. With `REQUESTED = false` this skill
  produces nothing: no explainer text, no file reads, no cost on the review.
- When a person accepts, run Steps 1–4 for the accepted module only, with
  `MODULE` set to that module's path, and attach the result to the review
  thread that offered it.
- A `TIER` other than `high` is not an error here; it simply means no offer was
  made, so there is nothing to accept. If this skill is invoked anyway with
  `REQUESTED = true`, it still answers — a maintainer may always ask directly.

---

## Reachability

Invoked by name from a review report's accepted offer, or directly by a
maintainer ("explain `<module>`"). No YAML caller references the CLI; the CLI
is reached through this skill, as the parity tests require.
