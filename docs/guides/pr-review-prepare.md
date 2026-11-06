# PR review: preparing a head once

Every reviewer and verifier of a PR head used to rebuild the same things on its
own: a frozen copy of the head, the diffs, the changed-path list, the policy
facts and a baseline test run. `pr-review-prepare` builds them once per head
and hands every agent the same files and hashes.

It lives outside `pr-review-cli.js` on purpose: that CLI's modules are pure (no
shell, no file reads), and preparing a head runs `git` and writes files.

```bash
node packages/development/lib/pr-review-prepare-cli.js < payload.json
```

## Input

One JSON object on stdin.

| Key | Meaning |
|---|---|
| `runId` | Names the persistent run directory (required). |
| `baseSha`, `headSha` | Full object ids (required). `mergeBaseSha`, `prBaseSha` and `parentPhaseTipSha` are accepted and resolved by the same `review-range` rules, so prepare and review cannot disagree on the base. |
| `repoRoot` | The git repository holding both commits. Default: the current directory. |
| `headRef` | A ref that must still resolve to `headSha` when the step starts and right before anything is published. A head that moved is `head-moved`. |
| `lastReviewedSha`, `remediationShas` | Decide, through `chooseReviewRange`, whether `delta.diff` is produced. |
| `testFiles`, `testCommand` | Baseline test files (default: tests the PR changed, plus tests named after a changed source file) and the argv prefix to run them with (default: the repository's `jest`). |
| `stateRoot` | Default `<repoRoot>/.ensemble/pr-review/prepare`, which is git-ignored. Never a temp directory. |

## Output

`<stateRoot>/<runId>/<headSha>/` holds:

| Path | Content |
|---|---|
| `snapshot/` | The head's tree from `git archive`, checked against `git ls-tree` object for object (every file, symlink and executable bit, and nothing extra), then made read-only. Nothing is ever written inside it. |
| `range.diff` | `BASE...HEAD`. |
| `delta.diff` | `lastReviewedSha..HEAD`, only when `review-range` says `delta`. Otherwise absent, with the reason under `absent` in the manifest (`first-round`, `unvouched-history`, ...). |
| `facts.json` | Policy and CODEOWNERS as the **base** commit states them, the `paths` classification (inputs and result), tier inputs, and `changedPaths` from `git diff --numstat -z --no-renames`. |
| `probe.js` | A runner agents `require()`: `load(rel)` a module of the head, `read`, `readAtBase`, `run(argv)` (no shell, read-only snapshot as cwd) and `chain(steps)`. |
| `baseline.json`, `baseline.log` | The baseline test run: files and why each was picked, command, exit code, redacted output. The baseline runs on a scratch copy, never in `snapshot/`. |
| `manifest.json` | The inputs and the sha256 of every artifact. |

The result printed on stdout carries the same paths and `hashes`, plus `reused`
and `wallMs`. `hashes.snapshot` is a digest of the tree listing; the other
hashes are sha256 of the file bytes. `baseline.log` includes the test runner's
own timings, so key carry-over on the other hashes.

## Guarantees

- **Fail closed.** An unreadable base or head, a head that moved, a snapshot that
  is not exactly the head tree (an `export-ignore` or eol attribute, a
  case-folding checkout), an unreadable guidance file or a baseline that could
  not be started returns `{ ok: false, status: "PREPARE_FAILED", reason, stage,
  detail }`. Nothing is published: artifacts are built in a staging directory and
  renamed into place after every check passed.
- **Idempotent.** The same head and inputs return the published directory after
  re-verifying every hash and the snapshot, without running anything
  (`reused: true`). A directory that no longer verifies is rebuilt.
- **Read-only snapshot.** Remove a run with `removePrepared(dir)` from
  `pr-review-prepare.js`; a plain `rm -rf` stops at the read-only directories.
- A failing baseline is data, not an error: it is recorded with its exit code. A
  baseline that timed out is recorded with `timedOut: true` and a `null` exit code.
