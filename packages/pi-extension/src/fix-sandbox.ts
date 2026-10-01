import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * A disposable copy of the working tree for the fix-provider child to run in.
 *
 * WHY (br-r3om, observed live). agent-fix-provider spawns
 * `omp -p --no-session --no-extensions --cwd=<rootDir>` -- a full agent with
 * its own write tools -- pointed at the LIVE repository. `--no-extensions`
 * means none of the governance exists inside that process: no tool-grant
 * enforcement, no MutationGuard, no WriteBoundaryMonitor, no runtime log.
 * `--no-session` means no transcript either.
 *
 * The result was a behavior whose manifest grants [read, grep, glob] and runs
 * in `policy.mode: propose` writing to the repo anyway: package.json gained a
 * "pretest" hook that no tool call in any transcript accounts for, and the
 * proposal carrying that exact content was REJECTED moments later -- rejected
 * and applied at once, because the guard binds the patch, not the process
 * that produced it. It happened again on 2026-09-28: 24 invocations, and
 * children caught mid-edit rewriting jest.config.js, tsconfig.json and
 * package.json in a worktree they were never pointed at.
 *
 * Grants cannot be enforced inside a process we do not control, so the fix is
 * not more rules for the child: it is giving it nothing of value to write to.
 * The child gets a throwaway git worktree that mirrors the live tree; its
 * candidate still returns through AutofixLoop, which authorizes and applies
 * it under MutationGuard exactly as before. Writes it makes directly land in
 * a directory that is deleted.
 *
 * The mirror must include UNCOMMITTED work. The failing test is usually the
 * thing just written, so a sandbox at HEAD would not reproduce the failure
 * and the child would be debugging a repository where nothing is wrong.
 */
export interface FixSandbox {
  dir: string;
  cleanup(): void;
}

/**
 * Why the sandbox could not be built, or why part of the mirror is missing.
 *
 * Reported rather than swallowed. A sandbox that fails silently makes the fix
 * provider return "no fix candidate offered", which reads as "the model had
 * nothing to suggest" when the truth is that the model was never asked. That
 * cost two full live runs to diagnose (br-boam), because the log for "the
 * step ran and found nothing" and "the step could not run" was identical --
 * the same defect class as br-zcxb.
 */
export type SandboxProblem = (reason: string) => void;

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Builds the sandbox, or returns undefined when it cannot be built.
 *
 * Fail-CLOSED on purpose: the caller must refuse to spawn the child rather
 * than fall back to the live repository. Falling back would restore exactly
 * the ungoverned behaviour this exists to remove, and it would do it
 * silently, at the moment something is already going wrong.
 */
export function createFixSandbox(rootDir: string, onProblem?: SandboxProblem): FixSandbox | undefined {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "ensemble-fix-"));
    const tree = join(dir, "work");

    // --detach: never checks out a branch, so the sandbox cannot move a ref
    // the live repository is using. The files ARE checked out here;
    // --no-checkout leaves an empty index and the later `apply` has nothing
    // to apply against.
    git(rootDir, ["worktree", "add", "--detach", tree, "HEAD"]);

    // Tracked modifications. Applied as a patch rather than copied so that
    // file modes and deletions come across too.
    const diff = git(rootDir, ["diff", "HEAD", "--binary"]);
    if (diff.trim()) git(tree, ["apply", "--allow-empty", "-"], diff);

    // Untracked-but-not-ignored files: usually the new failing test itself.
    const untracked = git(rootDir, ["ls-files", "--others", "--exclude-standard"])
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean);
    for (const rel of untracked) {
      const from = resolve(rootDir, rel);
      const to = resolve(tree, rel);
      if (!existsSync(from)) continue;

      // node_modules is linked below, wholesale. Copying it is redundant --
      // and when it is a symlink, fatal (see below).
      if (rel === "node_modules" || rel.startsWith("node_modules/")) continue;

      try {
        mkdirSync(dirname(to), { recursive: true });

        // lstat, NOT stat: a symlink must be recreated as a symlink. git
        // reports a symlinked DIRECTORY as a single entry, and copyFileSync
        // on it throws ENOTSUP -- which used to abandon the entire sandbox
        // and silently disable the whole governed path (br-boam). A
        // symlinked node_modules is not exotic; it is what workspace layouts
        // and this project's own worktree instructions produce.
        const info = lstatSync(from);
        if (info.isSymbolicLink()) {
          symlinkSync(readlinkSync(from), to);
        } else if (info.isFile()) {
          copyFileSync(from, to);
        } else {
          onProblem?.(`skipped untracked ${rel}: not a regular file or symlink`);
        }
      } catch (error) {
        // One uncopyable entry must not cost the whole sandbox. The mirror
        // is a convenience for the child's reading; the fix candidate still
        // comes back through AutofixLoop and is applied against the live
        // tree under MutationGuard either way.
        onProblem?.(`could not mirror untracked ${rel}: ${(error as Error).message}`);
      }
    }

    // Dependencies are shared, not copied: an install would take minutes and
    // node_modules is not what the child is allowed to change anyway. A
    // symlink pointing at the live tree is acceptable because nothing the
    // child is asked to do involves writing there -- and if it did, that is
    // a build artifact directory, not source.
    linkNodeModules(rootDir, tree);

    return {
      dir: tree,
      cleanup: () => {
        try {
          git(rootDir, ["worktree", "remove", "--force", tree]);
        } catch {
          // Fall through to rm: a half-registered worktree must not leave
          // the directory behind.
        }
        try {
          rmSync(dir as string, { recursive: true, force: true });
        } catch {
          // Best effort. A leftover temp dir is noise, not a hazard.
        }
        try {
          git(rootDir, ["worktree", "prune"]);
        } catch {
          // Likewise.
        }
      },
    };
  } catch (error) {
    if (dir) rmSync(dir, { recursive: true, force: true });
    // Fail closed, but SAY SO. Returning a bare undefined is what made this
    // indistinguishable from "the model had no suggestion".
    onProblem?.(`fix sandbox could not be built: ${(error as Error).message}`);
    return undefined;
  }
}

/** Links top-level and per-package node_modules, when they exist. */
function linkNodeModules(rootDir: string, tree: string): void {
  const candidates = ["node_modules"];
  try {
    const pkgs = execFileSync("ls", [join(rootDir, "packages")], { encoding: "utf8" })
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean);
    for (const p of pkgs) candidates.push(join("packages", p, "node_modules"));
  } catch {
    // No packages directory; the top-level link is enough.
  }

  for (const rel of candidates) {
    const from = resolve(rootDir, rel);
    const to = resolve(tree, rel);
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      mkdirSync(dirname(to), { recursive: true });
      symlinkSync(from, to, "dir");
    } catch {
      // A missing link costs the child a working install, not correctness.
    }
  }
}
