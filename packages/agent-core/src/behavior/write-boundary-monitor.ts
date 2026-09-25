import { execFileSync } from "node:child_process";
import { WorkspaceSnapshot } from "./workspace-snapshot";
import { classifyPath, ProtectedPathReason } from "./protected-paths";

/**
 * Detects and reverts writes to protected paths, whatever produced them.
 *
 * The preventive design this replaces did not work. Tool grants are
 * enforced by name and deliberately never inspect arguments, so a
 * granted `bash` is an unrestricted write grant: asked to make a
 * failing test pass, a live model ran
 * `printf ... > livetest/math.test.js` and gutted the assertion, with
 * MutationGuard, ProtectedPathPolicy and WorkspaceSnapshot all in
 * place and all bypassed. They only ever saw writes routed through
 * them, and a shell routes around them.
 *
 * Inspecting shell text was rejected: `cd` plus a relative path, tee,
 * dd, `python -c`, heredocs, base64 round trips, `sed -i`, variable
 * indirection and helper scripts all defeat it. Enumerating commands
 * does not scale either -- a tool per command is a shell rebuilt badly.
 *
 * So this checks effects rather than intentions. It asks git what
 * changed and reverts anything protected. It is identical for every
 * mechanism because it never looks at the mechanism.
 *
 * Corrective, not preventive: the write lands and is then undone. That
 * is acceptable for files, which are revertible byte-for-byte, and
 * useless for non-file effects (network, `rm -rf ~`, a push), which
 * belong to sandboxing rather than to this layer.
 */

export interface WriteViolation {
  path: string;
  reason: ProtectedPathReason;
  restored: boolean;
}

export interface MonitorResult {
  checked: number;
  violations: WriteViolation[];
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/** Paths changed vs HEAD, including untracked files. */
export function changedPaths(rootDir: string): string[] {
  const porcelain = git(rootDir, ["status", "--porcelain", "--untracked-files=all"]);
  const paths: string[] = [];

  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    // "XY path" or "XY orig -> path" for renames.
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    paths.push(arrow >= 0 ? rest.slice(arrow + 4) : rest);
  }

  return paths.map((p) => p.replace(/^"|"$/g, ""));
}

export class WriteBoundaryMonitor {
  private readonly snapshot: WorkspaceSnapshot;
  private readonly captured = new Set<string>();
  private readonly seen: WriteViolation[] = [];

  constructor(private readonly rootDir: string) {
    this.snapshot = new WorkspaceSnapshot(rootDir);
  }

  get violations(): readonly WriteViolation[] {
    return this.seen;
  }

  /**
   * Captures the pristine state of a protected path.
   *
   * Called before the model gets a turn, so a later revert has
   * something to restore to. Capturing lazily at violation time would
   * be too late: the damage is already on disk.
   */
  protect(relPath: string): void {
    if (this.captured.has(relPath)) return;
    this.captured.add(relPath);
    this.snapshot.capture(relPath);
  }

  /** Captures every currently-protected file under the repo. */
  protectAll(paths: readonly string[]): void {
    for (const p of paths) {
      if (classifyPath(p).protected) this.protect(p);
    }
  }

  /**
   * Checks what changed and reverts protected paths.
   *
   * Intended to run after every tool call, not at some later accept
   * step: the bypass this exists for happened in an ordinary
   * conversational turn with no accept boundary anywhere.
   */
  check(): MonitorResult {
    const changed = changedPaths(this.rootDir);
    const violations: WriteViolation[] = [];

    for (const path of changed) {
      const verdict = classifyPath(path);
      if (!verdict.protected) continue;

      // Only revert what we hold a pristine copy of. Reverting a file
      // we never captured would destroy content rather than restore it.
      const restored = this.captured.has(path);
      if (restored) {
        this.protect(path);
        this.snapshot.restore();
      }

      const violation: WriteViolation = {
        path,
        reason: verdict.reason as ProtectedPathReason,
        restored,
      };
      violations.push(violation);
      this.seen.push(violation);
    }

    return { checked: changed.length, violations };
  }
}
