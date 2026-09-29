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

/**
 * Runtime state the session writes itself (runtime log, beads export).
 * Changes here are expected and prove nothing about a fix.
 */
const RUNTIME_OWNED = [".ensemble/", ".beads/"];

const runtimeOwned = (rel: string): boolean => RUNTIME_OWNED.some((prefix) => rel.startsWith(prefix));

/**
 * True when the tree held no human work-in-progress at snapshot time.
 *
 * This is what makes a hold safe WITHOUT a baseline (br-dowt). A baseline
 * exists to tell the fix's edits from the user's; when it is missing, that
 * question is normally unanswerable. But if nothing was modified or newly
 * created when the fix began, then everything that differs now is the fix's,
 * and `policy.mode: propose` can still be honoured exactly.
 *
 * Deliberately conservative: a single pre-existing edit makes this false, and
 * the caller must escalate rather than guess. Being wrong here means reverting
 * a human's in-flight work into memory-only quarantine, which is worse than
 * the unreviewed change it would prevent.
 */
export function snapshotWasClean(snapshot: WorkingTreeSnapshot): boolean {
  if (snapshot.patch.trim() !== "") return false;
  return snapshot.untracked.filter((rel) => !runtimeOwned(rel)).length === 0;
}

/**
 * Every path that differs from HEAD right now, excluding runtime-owned state.
 *
 * Only meaningful together with `snapshotWasClean`: on its own it cannot
 * distinguish a fix's edit from anything else.
 */
export function changesSinceCleanSnapshot(snapshot: WorkingTreeSnapshot): string[] {
  const { root } = snapshot;
  const status = git(root, ["status", "--porcelain", "-z", "--untracked-files=all"]).out;
  const paths: string[] = [];
  for (const entry of status.split("\0")) {
    if (!entry) continue;
    // Porcelain v1: two status characters, a space, then the path.
    const rel = entry.slice(3);
    if (!rel || runtimeOwned(rel)) continue;
    paths.push(rel);
  }
  return [...new Set(paths)].sort();
}

/**
 * What to do with a verified fix under `policy.mode: propose` (br-dowt).
 *
 * Separated from the IO around it because this decision is the whole policy,
 * and it had never been tested: the hold lived inside `activate()` where no
 * test could reach it, which is how "no baseline means leave it applied"
 * survived as the behaviour of a system that fails closed everywhere else.
 *
 *   paths   -> revert the tree and hold these for /ensemble-approve
 *   unheld  -> propose could NOT be honoured; say so loudly
 */
export type HoldPlan = { readonly paths: readonly string[]; readonly unheld?: string };

export function planHold(
  snapshot: WorkingTreeSnapshot,
  changedFromBaseline: readonly string[] | undefined,
): HoldPlan {
  // The normal path: a baseline told us exactly which files the fix touched.
  if (changedFromBaseline) return { paths: changedFromBaseline };

  // No baseline. If the tree held work-in-progress, the fix cannot be told
  // apart from it, and reverting would sweep a human's edits into memory-only
  // quarantine -- worse than the unreviewed change it would prevent.
  if (!snapshotWasClean(snapshot)) {
    return {
      paths: [],
      unheld:
        "no tree baseline, and uncommitted edits were already in flight when the fix began; " +
        "the fix cannot be told apart from your work, so it was left applied",
    };
  }

  // Clean tree: everything that differs now IS the fix, so propose is
  // honoured exactly, with no baseline needed.
  return { paths: changesSinceCleanSnapshot(snapshot) };
}
