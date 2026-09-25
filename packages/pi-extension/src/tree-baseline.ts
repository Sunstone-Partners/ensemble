import { spawnSync } from "node:child_process";

/**
 * The state of the working tree BEFORE a fix provider runs.
 *
 * A fix provider can take minutes, and the session keeps working while it
 * does. Its candidate carries complete file contents computed from what the
 * files held when it started. Applying that candidate to a file that changed
 * in the meantime silently overwrites the newer edit -- and AutofixLoop's own
 * snapshot cannot help, because it is taken at apply time, after the change
 * already happened (observed live: a snapshot captured an already-mutated
 * file and "restored" it to the mutation).
 *
 * The baseline is a git object, not a copy: `git stash create` records the
 * tracked working-tree state as a commit without touching the tree, index or
 * refs, and untracked files are recorded by blob id. Comparison uses
 * `git hash-object --path`, so eol/clean filters are applied the same way on
 * both sides and a CRLF checkout does not read as a change.
 *
 * Deliberately NOT a whole-tree restore point: restoring everything to the
 * baseline would destroy concurrent human edits, which is worse than the
 * failure it prevents (see WorkspaceSnapshot). The baseline only answers
 * "did THESE paths change since the provider started?".
 */
export interface TreeBaseline {
  readonly root: string;
  /** Commit holding the tracked working-tree state at capture time. */
  readonly commit: string;
  /** Untracked, non-ignored files at capture time: repo-relative path -> blob id. */
  readonly untracked: ReadonlyMap<string, string>;
}

function git(root: string, args: string[], input?: string): { status: number; out: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, out: r.stdout ?? "" };
}

/** Returns undefined when `root` is not inside a git work tree with a commit. */
export function captureTreeBaseline(root: string): TreeBaseline | undefined {
  const head = git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (head.status !== 0) return undefined;
  const stash = git(root, ["stash", "create"]);
  if (stash.status !== 0) return undefined;
  const commit = stash.out.trim() || head.out.trim();

  const untracked = new Map<string, string>();
  const paths = git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    .out.split("\0")
    .filter(Boolean);
  if (paths.length > 0) {
    const ids = git(root, ["hash-object", "--stdin-paths"], paths.join("\n")).out.split("\n").filter(Boolean);
    if (ids.length !== paths.length) return undefined;
    paths.forEach((p, i) => untracked.set(p, ids[i] as string));
  }
  return { root, commit, untracked };
}

/** Blob id of the file as it is now, or null when it does not exist as a file. */
function currentBlob(root: string, relPath: string): string | null {
  const r = git(root, ["hash-object", `--path=${relPath}`, "--", relPath]);
  return r.status === 0 ? r.out.trim() : null;
}

/** Blob id of the file at baseline time, or null when it did not exist then. */
function baselineBlob(baseline: TreeBaseline, relPath: string): string | null {
  const untracked = baseline.untracked.get(relPath);
  if (untracked !== undefined) return untracked;
  // `./` makes the path relative to `root`, which need not be the repo top.
  const r = git(baseline.root, ["rev-parse", "--verify", "-q", `${baseline.commit}:./${relPath}`]);
  return r.status === 0 ? r.out.trim() : null;
}

/**
 * The subset of `relPaths` whose content differs from the baseline.
 *
 * A gitignored file that existed at capture time is not recorded, so it reads
 * as changed. That fails closed: a source fix has no business writing
 * ignored paths, and refusing is safer than guessing.
 */
export function changedSinceBaseline(baseline: TreeBaseline, relPaths: readonly string[]): string[] {
  return relPaths.filter((p) => baselineBlob(baseline, p) !== currentBlob(baseline.root, p));
}
