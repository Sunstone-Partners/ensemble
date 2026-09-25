import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
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

/** On-disk state of a path, compact enough to keep for every protected file. */
interface Fingerprint {
  existed: boolean;
  digest?: string;
  mode?: number;
}

function fingerprint(rootDir: string, relPath: string): Fingerprint {
  const abs = resolve(rootDir, relPath);
  if (!existsSync(abs)) return { existed: false };
  return {
    existed: true,
    mode: statSync(abs).mode,
    digest: createHash("sha256").update(readFileSync(abs)).digest("hex"),
  };
}

export class WriteBoundaryMonitor {
  // One snapshot per path so a violation restores exactly that path,
  // not every protected file in the repo.
  private readonly snapshots = new Map<string, WorkspaceSnapshot>();
  private readonly baselines = new Map<string, Fingerprint>();
  private readonly enumerated = new Set<string>();
  private readonly captureFailures: string[] = [];
  private enumerationComplete = false;
  private readonly seen: WriteViolation[] = [];

  constructor(private readonly rootDir: string) {}

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
    if (this.snapshots.has(relPath)) return;
    // Record nothing unless both steps succeed: a half-recorded path
    // would be "restored" from a snapshot that holds no state for it.
    const snapshot = new WorkspaceSnapshot(this.rootDir);
    snapshot.capture(relPath);
    const baseline = fingerprint(this.rootDir, relPath);
    this.snapshots.set(relPath, snapshot);
    this.baselines.set(relPath, baseline);
  }

  /** True when a captured path no longer matches its activation state. */
  private changedSinceActivation(relPath: string): boolean {
    const baseline = this.baselines.get(relPath)!;
    let current: Fingerprint;
    try {
      current = fingerprint(this.rootDir, relPath);
    } catch {
      // Unreadable now (e.g. replaced by a directory): certainly not
      // the captured file.
      return true;
    }
    return (
      current.existed !== baseline.existed ||
      current.mode !== baseline.mode ||
      current.digest !== baseline.digest
    );
  }

  /** Captures every currently-protected file under the repo. */
  protectAll(paths: readonly string[]): void {
    // Per-path isolation. A single unreadable file (permissions, an
    // odd symlink) must not abort the pass: an aborted pass leaves
    // later protected files uncaptured, and uncaptured is the
    // condition under which check() would otherwise delete them as
    // "created after activation". One bad file would become data loss.
    for (const p of paths) {
      if (!classifyPath(p).protected) continue;
      this.enumerated.add(p);
      try {
        this.protect(p);
      } catch {
        this.captureFailures.push(p);
      }
    }
    this.enumerationComplete = this.captureFailures.length === 0;
  }

  /** True when every protected path on disk was captured successfully. */
  get canInferNonExistence(): boolean {
    return this.enumerationComplete;
  }

  /**
   * Reports protected paths that changed, WITHOUT reverting anything.
   *
   * `check()` reverts as it detects, which makes "ask the user first"
   * impossible: by the time there is something to ask about, the edit is
   * already gone. Separating detection from reversion is what lets a human
   * turn offer consent instead of being silently overruled.
   *
   * This is deliberately NOT a softer `check()`. Nothing here decides that a
   * write is allowed; it only reports. The caller must either accept() a
   * path explicitly or call check() to revert it.
   */
  pending(): readonly WriteViolation[] {
    const candidates = new Set([...changedPaths(this.rootDir), ...this.snapshots.keys()]);
    const out: WriteViolation[] = [];
    for (const path of candidates) {
      const verdict = classifyPath(path);
      if (!verdict.protected) continue;
      if (this.snapshots.has(path)) {
        if (!this.changedSinceActivation(path)) continue;
      } else if (!this.enumerationComplete || this.enumerated.has(path)) {
        // Same caution as check(): without a completed enumeration, absence
        // from `snapshots` proves nothing about whether the file pre-existed.
        continue;
      }
      out.push({ path, reason: verdict.reason as ProtectedPathReason, restored: false });
    }
    return out;
  }

  /**
   * Accepts one already-approved change: the current on-disk state becomes
   * the new pristine baseline, so a later check() no longer reverts it.
   *
   * Scoped to a single path and re-baselined immediately, on purpose. A
   * longer-lived "edits allowed" mode would let everything after the
   * approval write freely, which is the protection this boundary exists to
   * provide. A SECOND edit to the same path is a new change against the new
   * baseline, and needs its own approval.
   */
  accept(relPath: string): void {
    const snapshot = new WorkspaceSnapshot(this.rootDir);
    snapshot.capture(relPath);
    this.snapshots.set(relPath, snapshot);
    this.baselines.set(relPath, fingerprint(this.rootDir, relPath));
    this.enumerated.add(relPath);
  }

  /**
   * Checks what changed since activation and reverts protected paths.
   *
   * Intended to run after every tool call, not at some later accept
   * step: the bypass this exists for happened in an ordinary
   * conversational turn with no accept boundary anywhere.
   *
   * "Changed vs git HEAD" is not "changed since activation": protected
   * files that were already untracked or dirty when the monitor started
   * (the common case -- a just-written failing test) always appear in
   * `git status`. Captured paths are therefore judged against their
   * activation baseline, and are checked even when git no longer lists
   * them (an untracked file that was deleted vanishes from status).
   * git status is still what discovers protected files created later.
   */
  check(): MonitorResult {
    const candidates = new Set([...changedPaths(this.rootDir), ...this.snapshots.keys()]);
    const violations: WriteViolation[] = [];

    for (const path of candidates) {
      const verdict = classifyPath(path);
      if (!verdict.protected) continue;

      const snapshot = this.snapshots.get(path);
      let restored = false;
      if (snapshot) {
        if (!this.changedSinceActivation(path)) continue;
        restored = snapshot.restore().failed.length === 0;
      } else if (this.enumerationComplete && !this.enumerated.has(path)) {
        // Deleting is only safe when the capture pass completed AND
        // this path was never enumerated -- together those establish
        // that it did not exist at activation, so its pristine state
        // is "absent". If any capture failed, absence from `snapshots`
        // proves nothing and deletion could destroy a pre-existing
        // file, so the violation is reported unreverted instead.
        try {
          rmSync(resolve(this.rootDir, path), { force: true });
          restored = true;
        } catch {
          restored = false;
        }
      }

      const violation: WriteViolation = {
        path,
        reason: verdict.reason as ProtectedPathReason,
        restored,
      };
      violations.push(violation);
      this.seen.push(violation);
    }

    return { checked: candidates.size, violations };
  }
}
