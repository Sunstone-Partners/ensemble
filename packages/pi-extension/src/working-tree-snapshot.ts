import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface WorkingTreeSnapshot {
  /** Unified diff of tracked files at snapshot time, or "" if clean. */
  readonly patch: string;
  /** Untracked files present at snapshot time (repo-relative). */
  readonly untracked: readonly string[];
  readonly root: string;
}

function git(root: string, args: string[]): { status: number; out: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}` };
}

/**
 * Captures enough of the working tree to undo an autofix.
 *
 * Snapshotting only the files we EXPECT to change would be wrong: we cannot
 * know in advance what a behavior will edit, and a fix that touches an
 * unanticipated file is exactly the case rollback exists for.
 *
 * `git diff` is taken against the index rather than a copy of the tree so the
 * snapshot is cheap and captures renames/modes correctly. Untracked files are
 * listed separately because a diff cannot represent them -- and untracked
 * files created by a rejected fix must not survive the rollback.
 */
export function snapshotWorkingTree(root: string): WorkingTreeSnapshot {
  const patch = git(root, ["diff", "HEAD", "--binary"]).out;
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]).out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return { patch, untracked, root };
}

export interface RestoreResult {
  readonly restored: boolean;
  readonly removed: readonly string[];
  readonly detail: string;
}

/**
 * Returns the working tree to its snapshot state.
 *
 * Deliberately NOT called on an "inconclusive" verdict: inconclusive means we
 * could not tell whether the fix worked, and destroying a possibly-good fix on
 * a non-verdict is worse than leaving it in place and reporting uncertainty.
 */
export function restoreWorkingTree(snapshot: WorkingTreeSnapshot): RestoreResult {
  const { root, patch } = snapshot;

  // Discard every tracked modification made since the snapshot.
  const reset = git(root, ["checkout", "--", "."]);
  if (reset.status !== 0) {
    return { restored: false, removed: [], detail: "git checkout failed; tree left untouched" };
  }

  // Re-apply whatever was already modified BEFORE the fix began. Skipping this
  // would silently destroy the user's own uncommitted work.
  if (patch.trim()) {
    const r = spawnSync("git", ["apply", "--whitespace=nowarn", "-"], {
      cwd: root,
      input: patch,
      encoding: "utf8",
    });
    if ((r.status ?? 1) !== 0) {
      return {
        restored: false,
        removed: [],
        detail: `pre-existing changes could not be re-applied: ${r.stderr ?? ""}`.trim(),
      };
    }
  }

  // Remove files the fix created. Files that were already untracked at
  // snapshot time are left alone.
  const nowUntracked = git(root, ["ls-files", "--others", "--exclude-standard"]).out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const preexisting = new Set(snapshot.untracked);
  const removed: string[] = [];
  for (const rel of nowUntracked) {
    if (preexisting.has(rel)) continue;
    const abs = join(root, rel);
    if (existsSync(abs)) {
      rmSync(abs, { force: true });
      removed.push(rel);
    }
  }

  return {
    restored: true,
    removed,
    detail: removed.length ? `restored; removed ${removed.length} new file(s)` : "restored",
  };
}
