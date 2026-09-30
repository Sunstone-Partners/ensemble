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
/**
 * Reflog actions that move HEAD by importing history someone else wrote.
 *
 * `commit`, `commit (amend)`, `reset` and `cherry-pick` are deliberately
 * absent. They publish content that originated HERE, so treating them as
 * external would hand any process with a shell a one-command bypass: edit a
 * protected file, commit it, and the boundary adopts the tainted content as
 * its new pristine state. That defeats the entire boundary, so a local
 * commit never re-baselines anything.
 */
const EXTERNAL_HISTORY_ACTIONS = new Set([
  "pull",
  "merge",
  "fetch",
  "rebase",
  "checkout",
  "switch",
  "clone",
]);

function headOid(rootDir: string): string {
  try {
    return git(rootDir, ["rev-parse", "HEAD"]).trim();
  } catch {
    return "";
  }
}

/** Content of a path as committed at some revision, or undefined when absent there. */
function blobFingerprintAt(rootDir: string, oid: string, relPath: string): Fingerprint | undefined {
  try {
    const blob = execFileSync("git", ["show", `${oid}:${relPath}`], {
      cwd: rootDir,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { existed: true, digest: createHash("sha256").update(blob).digest("hex") };
  } catch {
    return undefined;
  }
}

/** True when the path is tracked at HEAD, distinguishing deletion from error. */
function pathExistsAtHead(rootDir: string, relPath: string): boolean {
  try {
    return git(rootDir, ["ls-tree", "-r", "--name-only", "HEAD", "--", relPath]).trim() !== "";
  } catch {
    // Unknown, so claim nothing: the caller keeps the existing baseline.
    return true;
  }
}

/**
 * How HEAD got from `fromOid` to now, per the reflog.
 *
 * Returns false when the move cannot be fully accounted for -- an unfound
 * starting point, an unreadable reflog, or any local-authorship action in
 * the range. Unexplained history is treated as suspicious rather than
 * external, because the failure mode of guessing "external" is silent
 * adoption of an attacker's content.
 */
function movedByExternalHistory(rootDir: string, fromOid: string): boolean {
  let lines: string[];
  try {
    lines = git(rootDir, ["reflog", "--format=%H%x09%gs", "-n", "200"]).split("\n");
  } catch {
    return false;
  }

  for (const line of lines) {
    const [oid, subject = ""] = line.split("\t");
    if (oid === fromOid) return true; // Walked the whole range cleanly.
    if (!oid.trim()) continue;
    const action = subject.split(":")[0].trim().split(" ")[0];
    if (!EXTERNAL_HISTORY_ACTIONS.has(action)) return false;
  }

  return false; // Starting point not in the window.
}

/**
 * Commit oids reachable from `fromOid` that changed this path, newest
 * first.
 *
 * Bounded like the reflog scan above: real revert distances are shallow,
 * and an unbounded walk on a long-lived guardrail file is an unforced
 * cost for no correctness gain.
 */
function historyOidsForPath(rootDir: string, fromOid: string, relPath: string): string[] {
  return git(rootDir, ["log", "--format=%H", "-n", "200", fromOid, "--", relPath])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * True when a protected path's current content byte-for-byte matches some
 * commit reachable from `fromOid` already committed for this path -- a
 * RESTORATION, not new content (br-suoh).
 *
 * This is the file-content analogue of EXTERNAL_HISTORY_ACTIONS above. A
 * `git checkout <good-sha> -- <path>` never moves HEAD, so
 * syncExternalHistory's reflog walk cannot see it, and without this the
 * guard reverts a legitimate restoration straight back to the bad content
 * it was restoring away from -- with no agent-reachable way out, because
 * the correction is itself a write to a protected path.
 *
 * `fromOid` MUST be the monitor's `trustedHead`, never live HEAD. Live
 * HEAD would match a bypass against ITS OWN just-made commit: edit a
 * protected file, `git commit -am`, and the laundered content is now "in
 * HEAD's history" by definition -- the exact one-command bypass
 * EXTERNAL_HISTORY_ACTIONS already excludes `commit`/`reset` to prevent.
 * `trustedHead` only ever advances on a CONFIRMED external move, so a
 * local commit -- however many are chained -- never becomes a trusted
 * anchor. Still an accepted, narrower risk: a blob that predates this
 * guard's own hardening remains a legitimate ancestor of `trustedHead` and
 * would still match. Closing that fully would mean tracking which
 * historical commits were themselves approved, which this does not do.
 */
function isRestorationToHistory(rootDir: string, fromOid: string, relPath: string, digest: string): boolean {
  for (const oid of historyOidsForPath(rootDir, fromOid, relPath)) {
    if (blobFingerprintAt(rootDir, oid, relPath)?.digest === digest) return true;
  }
  return false;
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
  private knownHead: string;
  // Anchor for isRestorationToHistory. Deliberately separate from
  // knownHead, which advances on EVERY HEAD move including a rejected
  // (local) one -- using it here would let a local commit launder its own
  // content one call later. Advances ONLY inside syncExternalHistory's
  // `external` branch, so it can never point past a commit this session
  // made itself.
  private trustedHead: string;

  /**
   * `inScope` narrows WHICH protected paths this monitor governs.
   *
   * Defaults to every protected path. A narrower scope is not cosmetic:
   * check() treats a protected path it never enumerated as "created after
   * activation" and DELETES it. Enumerating a subset while still judging
   * every protected path would therefore destroy the user's own test files
   * the moment they edited one outside a behavior window -- found exactly
   * that way. Scope is applied at judgement time, not just capture time.
   */
  constructor(
    private readonly rootDir: string,
    private inScope: (path: string) => boolean = () => true,
  ) {
    this.knownHead = headOid(rootDir);
    this.trustedHead = this.knownHead;
  }

  get violations(): readonly WriteViolation[] {
    return this.seen;
  }

  /**
   * Changes which protected paths this monitor governs, IN PLACE.
   *
   * Replacing the monitor instead would re-baseline everything to whatever
   * is on disk at that moment. Proved by probe: tamper with the
   * constitution while the boundary is narrow, then widen by constructing a
   * fresh monitor, and the tampered text becomes the new pristine state --
   * the laundering the boundary exists to prevent, performed by the
   * boundary itself. Existing baselines are kept here precisely so a
   * pending violation survives the transition.
   *
   * Paths leaving scope are FORGOTTEN, not merely ignored. A stale snapshot
   * from an earlier window would otherwise revert the user's own later
   * edits back to a state they never asked for.
   */
  setScope(inScope: (path: string) => boolean): void {
    this.inScope = inScope;
    for (const path of [...this.snapshots.keys()]) {
      if (inScope(path)) continue;
      this.snapshots.delete(path);
      this.baselines.delete(path);
      this.enumerated.delete(path);
    }
  }

  /**
   * Re-baselines protected paths when HEAD moved because history arrived
   * from outside this session.
   *
   * Without this, a long session is a live hazard to the checkout it is
   * running in. The baseline is captured once at activation; when someone
   * else pulls or merges, every protected file the merge touched now differs
   * from that baseline, so the NEXT tool call -- including a read-only one --
   * "detects a violation" and reverts freshly merged work to activation-time
   * content. Observed for real: an external `pull --ff-only` landed mid
   * session and four files were reverted, deleting ~175 lines of merged
   * tests, triggered by an `ls`.
   *
   * Adoption needs BOTH conditions, and each blocks a different attack:
   *
   *  1. the reflog range contains no locally-authored move, so an agent
   *     cannot launder an edit by committing it; and
   *  2. the file on disk matches HEAD exactly, so uncommitted changes
   *     riding along with a legitimate pull are not adopted.
   *
   * Either alone is bypassable. Condition 1 alone would adopt a dirty tree
   * after any pull; condition 2 alone falls to `edit && git commit` in one
   * shell call.
   */
  private syncExternalHistory(): void {
    const current = headOid(this.rootDir);
    if (!current || current === this.knownHead) return;

    const external = movedByExternalHistory(this.rootDir, this.knownHead);
    // Recorded either way: a rejected move must not be re-examined on every
    // subsequent call, and its paths stay pinned to their old baselines.
    this.knownHead = current;
    if (!external) return;
    this.trustedHead = current;

    for (const path of [...this.snapshots.keys()]) {
      const committed = blobFingerprintAt(this.rootDir, "HEAD", path);
      if (!committed) {
        // Two very different reasons `git show HEAD:path` can fail, and
        // treating them alike resurrects deleted files. When the pull
        // legitimately REMOVED the path and it is gone from disk, the
        // pristine state is now "absent" -- re-baseline to that, or the next
        // check() restores a file upstream deliberately deleted. Any other
        // failure (unreadable object, odd ref state) keeps the old baseline.
        if (!pathExistsAtHead(this.rootDir, path) && !existsSync(resolve(this.rootDir, path))) {
          this.accept(path);
        }
        continue;
      }
      const disk = fingerprint(this.rootDir, path);
      if (!disk.existed || disk.digest !== committed.digest) continue;
      this.accept(path);
    }
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
  /** Current fingerprint, when it differs from the activation baseline. */
  private changedSinceActivation(relPath: string): Fingerprint | undefined {
    const baseline = this.baselines.get(relPath)!;
    let current: Fingerprint;
    try {
      current = fingerprint(this.rootDir, relPath);
    } catch {
      // Unreadable now (e.g. replaced by a directory): certainly not the
      // captured file, and with no digest to check against history.
      return { existed: false };
    }
    const changed =
      current.existed !== baseline.existed ||
      current.mode !== baseline.mode ||
      current.digest !== baseline.digest;
    return changed ? current : undefined;
  }

  /** Captures every currently-protected file under the repo. */
  protectAll(paths: readonly string[]): void {
    // Per-path isolation. A single unreadable file (permissions, an
    // odd symlink) must not abort the pass: an aborted pass leaves
    // later protected files uncaptured, and uncaptured is the
    // condition under which check() would otherwise delete them as
    // "created after activation". One bad file would become data loss.
    for (const p of paths) {
      if (!classifyPath(p).protected || !this.inScope(p)) continue;
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
    this.syncExternalHistory();
    const candidates = new Set([...changedPaths(this.rootDir), ...this.snapshots.keys()]);
    const out: WriteViolation[] = [];
    for (const path of candidates) {
      const verdict = classifyPath(path);
      if (!verdict.protected || !this.inScope(path)) continue;
      if (this.snapshots.has(path)) {
        const current = this.changedSinceActivation(path);
        if (!current) continue;
        if (current.digest && isRestorationToHistory(this.rootDir, this.trustedHead, path, current.digest)) continue;
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
    this.syncExternalHistory();
    const candidates = new Set([...changedPaths(this.rootDir), ...this.snapshots.keys()]);
    const violations: WriteViolation[] = [];

    for (const path of candidates) {
      const verdict = classifyPath(path);
      if (!verdict.protected || !this.inScope(path)) continue;

      const snapshot = this.snapshots.get(path);
      let restored = false;
      if (snapshot) {
        const current = this.changedSinceActivation(path);
        if (!current) continue;
        if (current.digest && isRestorationToHistory(this.rootDir, this.trustedHead, path, current.digest)) {
          // Adopting, not reverting, is what makes `git checkout <good-sha>
          // -- <path>` agent-reachable again after a bad commit (br-suoh):
          // the correction needs no approval, because it can only ever
          // reproduce a state this branch's own history already holds.
          this.accept(path);
          continue;
        }
        restored = snapshot.restore().failed.length === 0;
        if (restored) {
          // restore() only ever touches the working tree (writeFileSync). A
          // prior `git checkout <sha> -- path` also staged the good blob, so
          // without this the index keeps holding it after the working tree
          // is reverted -- the stale-staged-blob trap an unrelated later
          // commit can silently sweep in (br-suoh). Scoped to this one path,
          // never a bare `-A`.
          git(this.rootDir, ["add", "-A", "--", path]);
        }
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
          // Same index concern as the restore branch above.
          git(this.rootDir, ["add", "-A", "--", path]);
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
