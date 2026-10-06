/**
 * Shared, stage-agnostic run-index I/O primitives.
 *
 * Extracted from `new-feature/run-index.ts` (TRD-002) so a second,
 * independent run-index store (the issue workflow's `fix-issue/issue-run-index.ts`,
 * TRD-015) can reuse the same atomic-write, active-lock,
 * optimistic-concurrency `mutate()`, and corrupt-file-validation plumbing
 * without duplicating it (REQ-019). See the companion research doc's
 * Option C (docs/TRD/TRD-2026-87e64cc6-command-surface-consolidation-research.md):
 * only the stage-agnostic I/O primitives live here; each workflow keeps its
 * own public API, `Stage` union, and record shape in its own thin wrapper.
 *
 * Every primitive below is generic over a caller-supplied runs-dir
 * resolver (how to compute a project's run-file directory from its root)
 * and a record-shape validator (the caller's own `asserts`-style shape
 * check) -- this module knows nothing about `Stage`, `RunRecord`, or
 * `.ensemble/new-feature`; that stays in each workflow's own wrapper.
 *
 * Ports `packages/core/lib/refinement-review/session.js`'s proven
 * temp-file-then-`renameSync` atomic write plus `expectedRevision`/409-style
 * optimistic concurrency pattern. See
 * docs/TRD/TRD-2026-d6bbf322-new-feature-workflow.md (TRD-002, Component
 * Design's data contracts and failure paths) for the original design this
 * ports forward unchanged.
 */

import * as fs from "fs";
import * as path from "path";

/** Resolves the directory holding a project's run files, given its root. */
export type RunsDirResolver = (projectRoot: string) => string;

/**
 * Caller-supplied, `asserts`-style shape check for a value loaded from a
 * run file. Must throw (via `makeRunIndexCorrupt`, never return a boolean)
 * on the first violation rather than letting a partially-trusted object
 * through.
 */
export type ShapeValidator<T> = (value: unknown, filePath: string) => asserts value is T;

/** Structural shape every record `mutateRecord()` manages must have. */
export interface RevisionedRecord {
  revision: number;
  updatedAt: string;
}

/** Typed error thrown by `mutateRecord()` on a stale `expectedRevision`. */
export interface RevisionConflictError extends Error {
  code: "REVISION_CONFLICT";
  status: 409;
  currentRevision: number;
}

/**
 * Typed error thrown when a run file on disk is malformed or internally
 * inconsistent (JSON parse failure, or a caller-supplied validator
 * rejecting its shape). Never silently skipped or guessed around
 * (AC-005-3).
 */
export interface RunIndexCorruptError extends Error {
  code: "RUN_INDEX_CORRUPT";
  filePath: string;
  reason: string;
}

/**
 * Typed error thrown by `acquireActiveLock()` when a project already has
 * an active/paused run holding `active.lock` (REQ-008). Names the
 * existing run so the caller can resume or abandon it instead of
 * guessing.
 */
export interface RunAlreadyActiveError extends Error {
  code: "RUN_ALREADY_ACTIVE";
  existingRunId: string;
}

export function isRevisionConflictError(err: unknown): err is RevisionConflictError {
  return typeof err === "object" && err !== null && "code" in err && err.code === "REVISION_CONFLICT";
}

/**
 * Construct a `RUN_INDEX_CORRUPT` error. Exported so each caller's own
 * record-shape validator can throw the exact same error shape this core
 * throws internally on read/parse failure, keeping corrupt-file reporting
 * consistent across every workflow built on this core.
 */
export function makeRunIndexCorrupt(filePath: string, reason: string): RunIndexCorruptError {
  return Object.assign(new Error(`run index corrupt at ${filePath}: ${reason}`), {
    code: "RUN_INDEX_CORRUPT" as const,
    filePath,
    reason,
  });
}

export function isRunAlreadyActiveError(err: unknown): err is RunAlreadyActiveError {
  return typeof err === "object" && err !== null && "code" in err && err.code === "RUN_ALREADY_ACTIVE";
}

/** A run file's absolute path: `<runsDir(projectRoot)>/<runId>.json`. */
export function runFilePath(runsDir: RunsDirResolver, projectRoot: string, runId: string): string {
  return path.join(runsDir(projectRoot), `${runId}.json`);
}

/**
 * Atomic JSON write: write to a temp file in the same directory, fsync,
 * then rename over the destination. A crash between `openSync` and
 * `renameSync` leaves the prior valid file intact and an orphaned `.tmp`
 * file -- never a partially written destination.
 */
export function writeRunAtomic(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const data = JSON.stringify(value, null, 2);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

/**
 * Read and validate a single run file using the caller-supplied
 * `validateShape`. Throws `RUN_INDEX_CORRUPT` on parse failure or shape
 * violation -- never falls back to directory-scan guessing.
 */
export function readRunFile<T>(filePath: string, validateShape: ShapeValidator<T>): T {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw makeRunIndexCorrupt(filePath, `cannot read file: ${message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw makeRunIndexCorrupt(filePath, `invalid JSON: ${message}`);
  }
  validateShape(parsed, filePath);
  return parsed;
}

/** List every run file's absolute path under `runsDir(projectRoot)`, if any. */
export function listRunFiles(runsDir: RunsDirResolver, projectRoot: string): string[] {
  const dir = runsDir(projectRoot);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    const isEnoent = typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
    if (isEnoent) return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .map((name) => path.join(dir, name));
}

/**
 * Acquire `active.lock` for a new run (REQ-008): write-exclusive create of
 * the lock file naming `runId`. Throws `RUN_ALREADY_ACTIVE` (naming the
 * existing run) on `EEXIST`, writing nothing.
 */
export function acquireActiveLock(runsDir: RunsDirResolver, projectRoot: string, runId: string): void {
  const lockPath = path.join(runsDir(projectRoot), "active.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    fs.writeFileSync(lockPath, runId, { flag: "wx" });
  } catch (err) {
    const isEexist = typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST";
    if (isEexist) {
      const existingRunId = fs.readFileSync(lockPath, "utf8").trim();
      throw Object.assign(new Error(`a run is already active for this project: ${existingRunId}`), {
        code: "RUN_ALREADY_ACTIVE" as const,
        existingRunId,
      });
    }
    throw err;
  }
}

/**
 * Release `active.lock` if (and only if) it is currently held by `runId`.
 * Never removes a lock owned by a different run, and never removes it
 * based on elapsed time alone.
 */
export function releaseActiveLockIfOwned(runsDir: RunsDirResolver, projectRoot: string, runId: string): void {
  const lockPath = path.join(runsDir(projectRoot), "active.lock");
  let owner: string;
  try {
    owner = fs.readFileSync(lockPath, "utf8").trim();
  } catch (err) {
    const isEnoent = typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
    if (isEnoent) return;
    throw err;
  }
  if (owner === runId) {
    fs.unlinkSync(lockPath);
  }
}

/**
 * Mutate a run file through `updater`, persisting with optimistic
 * concurrency. `updater` receives the current record and mutates it in
 * place; `revision` is bumped by exactly 1 after `updater` returns --
 * `updater` must not touch `revision` itself.
 *
 * Throws `REVISION_CONFLICT` (`{ code, status: 409, currentRevision }`) on
 * a stale `expectedRevision`.
 */
export function mutateRecord<T extends RevisionedRecord>(
  filePath: string,
  expectedRevision: number,
  updater: (record: T) => void,
  validateShape: ShapeValidator<T>,
): T {
  const record = readRunFile(filePath, validateShape);

  if (record.revision !== expectedRevision) {
    throw Object.assign(new Error(`revision conflict (current ${record.revision})`), {
      code: "REVISION_CONFLICT" as const,
      status: 409 as const,
      currentRevision: record.revision,
    });
  }

  const preRevision = record.revision;
  updater(record);

  if (record.revision !== preRevision) {
    throw Object.assign(new Error("updater must not change revision; mutate() owns the +1 bump"), {
      code: "REVISION_TAMPERED",
      status: 400,
    });
  }

  record.revision = preRevision + 1;
  record.updatedAt = new Date().toISOString();

  writeRunAtomic(filePath, record);
  return record;
}
