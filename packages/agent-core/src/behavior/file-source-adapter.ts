/**
 * Artifact-change trigger source (TRD-001 / REQ-001).
 *
 * A behavior can fire because a FILE changed -- a coverage summary appearing,
 * a generated report rewritten -- not only because a tool call returned.
 *
 * HOW A CHANGE IS SEEN: content hashes checked at lifecycle points. The
 * session calls `check()` at `tool_result` and at `agent_end`; each call
 * hashes every watched file and emits one `artifact.changed` per digest that
 * differs from the last one seen this session. Not `fs.watch`: its event
 * semantics differ between macOS, Linux and Windows (rename-vs-change,
 * recursive support), which REQ-023 forbids absorbing silently, and it holds
 * a handle open for the whole session. Not `chokidar`: a new runtime
 * dependency (constitution §4) for a problem lifecycle-point hashing already
 * solves. The cost, stated rather than hidden: a change is seen at the next
 * tool call or at the end of the run, not instantly.
 *
 * WHAT IS WATCHED comes only from compiled triggers. `artifactWatchSet` reads
 * the `path` predicate of every valid `artifact.changed` trigger, and there is
 * no other way to add a watch, so a package cannot make the session hash a
 * path its own trigger does not name. `artifactTriggerViolation` is the
 * compile-time half: a trigger with no concrete path, or one resolving outside
 * the repository, fails validation naming `trigger.predicate.path` (AC-001-2)
 * instead of registering a watch that can never fire -- or one that reads
 * outside the checkout. A symlink inside the repository that points out of it
 * is never read either.
 *
 * EVERY EVENT GOES THROUGH `normalizeEvent`, the ingress tool-result events
 * use, so the closed catalog governs this source exactly as it governs the
 * translator (AC-001-1). Snapshots live in memory only and die with the
 * session (Rule 4).
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { BehaviorEvent } from "../events";
import { normalizeEvent } from "../normalize";
import { globStaticPrefix, globToRegExp } from "./path-glob";
import { BehaviorManifest } from "./schema";

export const ARTIFACT_CHANGED_EVENT_TYPE = "artifact.changed";

/** The lifecycle hook that ran the check which saw a change. */
export type ArtifactObservationPoint = "tool_result" | "agent_end";

/** Payload of `artifact.changed` (data model: ArtifactChangedPayload). */
export interface ArtifactChangedPayload {
  /** Repo-relative, `/`-separated on every OS. */
  readonly path: string;
  /** sha256 of the content last seen this session; null the first time it is seen. */
  readonly previousDigest: string | null;
  /** sha256 of the content now. */
  readonly currentDigest: string;
  readonly observedAt: string;
  readonly observedBy: ArtifactObservationPoint;
}

/** One watch, exactly as a trigger's `path` predicate names it. */
export interface ArtifactWatch {
  /** `file` for `equals: <path>`, `glob` for `glob: <pattern>`. */
  readonly kind: "file" | "glob";
  /** Repo-relative, normalised, `/`-separated. */
  readonly pattern: string;
}

const PATH_FIELD = "trigger.predicate.path";

/** The watch a manifest's trigger names, or the diagnostic explaining why it names none. */
function readWatch(manifest: BehaviorManifest): ArtifactWatch | string {
  const condition = manifest.trigger?.predicate?.path;
  if (!condition) {
    return (
      `field '${PATH_FIELD}' is required for an ${ARTIFACT_CHANGED_EVENT_TYPE} trigger: name the file ` +
      `(equals) or glob (glob) to watch. Without one nothing is hashed and the behavior could never fire`
    );
  }
  const { equals, glob, matches, not } = condition;
  if (matches !== undefined || not !== undefined || (equals === undefined) === (glob === undefined)) {
    return (
      `field '${PATH_FIELD}' must name exactly one concrete path, as equals: <file> or glob: <pattern>; ` +
      `a matches or not condition names no file to hash`
    );
  }
  const raw = equals ?? glob;
  if (typeof raw !== "string" || raw.trim() === "" || raw.includes("\0")) {
    return `field '${PATH_FIELD}' must be a non-empty repo-relative path string`;
  }
  const pattern = posix.normalize(raw.replace(/\\/g, "/"));
  if (
    posix.isAbsolute(pattern) ||
    /^[A-Za-z]:/.test(pattern) ||
    pattern === ".." ||
    pattern.startsWith("../")
  ) {
    return (
      `field '${PATH_FIELD}' resolves outside the repository root: "${raw}". ` +
      `Only files inside the checkout can be watched`
    );
  }
  if (pattern === ".") {
    return `field '${PATH_FIELD}' names the repository root itself, not a file inside it: "${raw}"`;
  }
  return { kind: glob !== undefined ? "glob" : "file", pattern };
}

/**
 * The compile-time half of AC-001-2: undefined for a valid `artifact.changed`
 * trigger, or for any other trigger type; otherwise a diagnostic naming
 * `trigger.predicate.path`.
 */
export function artifactTriggerViolation(manifest: BehaviorManifest): string | undefined {
  if (manifest.trigger?.event_type !== ARTIFACT_CHANGED_EVENT_TYPE) return undefined;
  const watch = readWatch(manifest);
  return typeof watch === "string" ? watch : undefined;
}

/**
 * Every path the compiled `artifact.changed` triggers name, once each, in
 * declaration order. Takes COMPILED behaviors, so a trigger that failed
 * validation never reaches here and registers no watch.
 */
export function artifactWatchSet(compiled: readonly { readonly manifest: BehaviorManifest }[]): ArtifactWatch[] {
  const watches: ArtifactWatch[] = [];
  for (const { manifest } of compiled) {
    if (manifest.trigger?.event_type !== ARTIFACT_CHANGED_EVENT_TYPE) continue;
    const watch = readWatch(manifest);
    if (typeof watch === "string") continue;
    if (!watches.some((seen) => seen.kind === watch.kind && seen.pattern === watch.pattern)) {
      watches.push(watch);
    }
  }
  return watches;
}

export interface FileSourceAdapterOptions {
  /** Repository root every watch is relative to. */
  readonly repoRoot: string;
  /** From `artifactWatchSet`. */
  readonly watches: readonly ArtifactWatch[];
  /** Event `source`: the host the session runs in, e.g. "pi". */
  readonly source: string;
  /** Clock seam for tests. */
  readonly now?: () => Date;
}

export class FileSourceAdapter {
  /** Last digest seen per repo-relative path, this session only. */
  private readonly seen = new Map<string, string>();
  private readonly root: string;

  constructor(private readonly options: FileSourceAdapterOptions) {
    this.root = realpathSync(options.repoRoot);
  }

  /**
   * Records what is on disk now as the session's baseline and emits nothing.
   * Called at session start, so a file that already existed is not reported
   * as changed by the first tool call that happens to look at it.
   */
  prime(): void {
    for (const [path, digest] of this.observe()) this.seen.set(path, digest);
  }

  /**
   * Hashes every watched file and returns one `artifact.changed` event, built
   * by `normalizeEvent`, per file whose digest differs from the last one seen
   * this session. A file seen for the first time carries `previousDigest:
   * null`; a byte-identical rewrite produces nothing; a missing file is not a
   * change and keeps its last digest.
   */
  check(observedBy: ArtifactObservationPoint): BehaviorEvent[] {
    const events: BehaviorEvent[] = [];
    for (const [path, currentDigest] of this.observe()) {
      const previousDigest = this.seen.get(path) ?? null;
      if (previousDigest === currentDigest) continue;
      const observedAt = (this.options.now?.() ?? new Date()).toISOString();
      const payload: ArtifactChangedPayload = { path, previousDigest, currentDigest, observedAt, observedBy };
      // Built before the snapshot moves: if ingress refuses the event, the
      // change is reported again at the next check instead of being lost.
      events.push(
        normalizeEvent({
          type: ARTIFACT_CHANGED_EVENT_TYPE,
          source: this.options.source,
          occurredAt: observedAt,
          payload: { ...payload },
        }),
      );
      this.seen.set(path, currentDigest);
    }
    return events;
  }

  /** Current digest of every existing file the watches cover. */
  private observe(): Map<string, string> {
    const digests = new Map<string, string>();
    for (const watch of this.options.watches) {
      const paths = watch.kind === "file" ? [watch.pattern] : this.expand(watch.pattern);
      for (const path of paths) {
        if (digests.has(path)) continue;
        const digest = this.digest(path);
        if (digest !== undefined) digests.set(path, digest);
      }
    }
    return digests;
  }

  /**
   * Files under the glob's static prefix that match it. `.git` and nested
   * `node_modules` directories are not descended into: they are never
   * artifacts a behavior reacts to, and walking them at every tool call would
   * make the check cost scale with the dependency tree.
   */
  private expand(pattern: string): string[] {
    const matcher = globToRegExp(pattern);
    const matched: string[] = [];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(join(this.root, dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== ".git" && entry.name !== "node_modules") walk(path);
        } else if (matcher.test(path)) {
          matched.push(path);
        }
      }
    };
    walk(globStaticPrefix(pattern));
    return matched.sort();
  }

  /**
   * sha256 of a regular file inside the repository, streamed so a large
   * artifact is never held in memory. Undefined when it does not exist, is
   * not a regular file, or resolves (through a symlink) outside the root.
   */
  private digest(path: string): string | undefined {
    let real: string;
    try {
      real = realpathSync(join(this.root, path));
    } catch {
      return undefined;
    }
    const inside = relative(this.root, real);
    if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      return undefined;
    }
    if (!statSync(real).isFile()) return undefined;
    const hash = createHash("sha256");
    const fd = openSync(real, "r");
    try {
      const chunk = Buffer.alloc(64 * 1024);
      let read: number;
      while ((read = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
        hash.update(chunk.subarray(0, read));
      }
    } finally {
      closeSync(fd);
    }
    return hash.digest("hex");
  }
}
