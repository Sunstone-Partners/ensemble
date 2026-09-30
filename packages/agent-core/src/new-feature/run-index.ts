/**
 * `RunIndexStore`: atomic, concurrency-safe CRUD over project-local
 * `new-feature` run records.
 *
 * Ports `packages/core/lib/refinement-review/session.js`'s proven
 * temp-file-then-`renameSync` atomic write plus `expectedRevision`/409-style
 * optimistic concurrency pattern, rather than `ProposalStore`'s plain
 * `writeFileSync` (no atomicity, no lock).
 *
 * See docs/TRD/TRD-2026-d6bbf322-new-feature-workflow.md (TRD-002,
 * Component Design's data contracts and failure paths).
 */

import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import type { ArtifactRef, RunRecord, Stage } from "./types";
import { STAGE_ORDER } from "./types";

/** Typed error thrown by `mutate()` on a stale `expectedRevision`. */
export interface RevisionConflictError extends Error {
  code: "REVISION_CONFLICT";
  status: 409;
  currentRevision: number;
}

/**
 * Typed error thrown when a run file on disk is malformed or internally
 * inconsistent (JSON parse failure, missing required field, `stage` not in
 * the fixed enum). Never silently skipped or guessed around (AC-005-3).
 */
export interface RunIndexCorruptError extends Error {
  code: "RUN_INDEX_CORRUPT";
  filePath: string;
  reason: string;
}

/**
 * Typed error thrown by `createRun()` when a project already has an
 * active/paused run holding `active.lock` (REQ-008). Names the existing
 * run so the caller can resume or abandon it instead of guessing.
 */
export interface RunAlreadyActiveError extends Error {
  code: "RUN_ALREADY_ACTIVE";
  existingRunId: string;
}

function isRevisionConflictError(err: unknown): err is RevisionConflictError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "REVISION_CONFLICT"
  );
}

function makeRevisionConflict(currentRevision: number): RevisionConflictError {
  return Object.assign(
    new Error(`revision conflict (current ${currentRevision})`),
    { code: "REVISION_CONFLICT" as const, status: 409 as const, currentRevision },
  );
}

function makeRunIndexCorrupt(filePath: string, reason: string): RunIndexCorruptError {
  return Object.assign(new Error(`run index corrupt at ${filePath}: ${reason}`), {
    code: "RUN_INDEX_CORRUPT" as const,
    filePath,
    reason,
  });
}

function isRunAlreadyActiveError(err: unknown): err is RunAlreadyActiveError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "RUN_ALREADY_ACTIVE"
  );
}

function makeRunAlreadyActiveError(existingRunId: string): RunAlreadyActiveError {
  return Object.assign(
    new Error(`a run is already active for this project: ${existingRunId}`),
    { code: "RUN_ALREADY_ACTIVE" as const, existingRunId },
  );
}

const STAGE_MEMBERSHIP: Record<string, true> = Object.fromEntries(
  STAGE_ORDER.map((stage) => [stage, true as const]),
);

/** Directory holding every run's JSON file for a given project. */
function runsDir(projectRoot: string): string {
  return path.join(projectRoot, ".ensemble", "new-feature");
}

function runFilePath(projectRoot: string, runId: string): string {
  return path.join(runsDir(projectRoot), `${runId}.json`);
}

/**
 * Create-time exclusivity marker (REQ-008). Its content is the owning
 * run's id; `createRun()` writes it write-exclusive (`EEXIST` on a second
 * concurrent/paused run) and `abandon()`/`complete()` remove it on
 * terminal transition. Never removed based on elapsed time alone.
 */
function activeLockPath(projectRoot: string): string {
  return path.join(runsDir(projectRoot), "active.lock");
}

/**
 * Atomic JSON write: write to a temp file in the same directory, fsync,
 * then rename over the destination. Ported from `session.js`'s
 * `writeJsonAtomic`. A crash between `openSync` and `renameSync` leaves the
 * prior valid file intact and an orphaned `.tmp` file — never a partially
 * written destination.
 */
function writeRunAtomic(filePath: string, value: unknown): void {
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
 * Validate the shape of a value loaded from a run file. Throws
 * `RUN_INDEX_CORRUPT` on the first violation rather than returning a
 * partially-trusted object.
 */
function validateRunRecordShape(value: unknown, filePath: string): asserts value is RunRecord {
  if (typeof value !== "object" || value === null) {
    throw makeRunIndexCorrupt(filePath, "not a JSON object");
  }
  const r = value as Record<string, unknown>;
  const requiredStrings = ["runId", "projectRoot", "status", "stage", "createdAt", "updatedAt"];
  for (const key of requiredStrings) {
    if (typeof r[key] !== "string") {
      throw makeRunIndexCorrupt(filePath, `missing or non-string field "${key}"`);
    }
  }
  if (!STAGE_MEMBERSHIP[r.stage as string]) {
    throw makeRunIndexCorrupt(filePath, `stage "${String(r.stage)}" is not in the fixed enum`);
  }
  if (
    r.status !== "active" &&
    r.status !== "paused" &&
    r.status !== "completed" &&
    r.status !== "abandoned"
  ) {
    throw makeRunIndexCorrupt(filePath, `status "${String(r.status)}" is not in the fixed enum`);
  }
  if (typeof r.revision !== "number") {
    throw makeRunIndexCorrupt(filePath, "missing or non-number field \"revision\"");
  }
  if (typeof r.stageOutcome !== "object" || r.stageOutcome === null) {
    throw makeRunIndexCorrupt(filePath, "missing or non-object field \"stageOutcome\"");
  }
  if (!Array.isArray(r.artifacts)) {
    throw makeRunIndexCorrupt(filePath, "missing or non-array field \"artifacts\"");
  }
  if (!Array.isArray(r.beadRefs)) {
    throw makeRunIndexCorrupt(filePath, "missing or non-array field \"beadRefs\"");
  }
}

/**
 * Read and validate a single run file. Throws `RUN_INDEX_CORRUPT` on parse
 * failure or shape violation — never falls back to directory-scan guessing.
 */
function readRunFile(filePath: string): RunRecord {
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
  validateRunRecordShape(parsed, filePath);
  return parsed;
}

/** List every run file's absolute path under `projectRoot`, if any. */
function listRunFiles(projectRoot: string): string[] {
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
 * Create a new run for `projectRoot` at `stage: "prd_create"`.
 *
 * Enforces single-active-run-per-project exclusivity at create time
 * (REQ-008): writes `.ensemble/new-feature/active.lock` write-exclusive
 * (`{ flag: "wx" }`) before the run's own JSON file exists, since a
 * brand-new file has no prior `revision` for `mutate()`'s optimistic-
 * concurrency check to compare against. On `EEXIST` throws
 * `RUN_ALREADY_ACTIVE` naming the existing run and writes nothing.
 */
export function createRun(projectRoot: string, idea: string): RunRecord {
  const runId = randomBytes(8).toString("hex");
  const lockPath = activeLockPath(projectRoot);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    fs.writeFileSync(lockPath, runId, { flag: "wx" });
  } catch (err) {
    const isEexist = typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST";
    if (isEexist) {
      const existingRunId = fs.readFileSync(lockPath, "utf8").trim();
      throw makeRunAlreadyActiveError(existingRunId);
    }
    throw err;
  }

  const now = new Date().toISOString();
  const record: RunRecord = {
    runId,
    projectRoot,
    status: "active",
    stage: "prd_create",
    // No stage has been attempted yet. None of the four StageOutcome.kind
    // literals mean "not yet attempted"; "approval_wait" is the only one
    // that does not assert a false claim (success/decline/failure all
    // describe something that already happened). TRD-003's "only a
    // non-success outcome lets the current stage run" check treats this
    // correctly as "prd_create has not succeeded yet, so run it."
    stageOutcome: { kind: "approval_wait", detail: "run created; prd_create not yet attempted", recordedAt: now },
    artifacts: [],
    beadRefs: [],
    implementationApprovedAt: null,
    prApprovedAt: null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
  writeRunAtomic(runFilePath(projectRoot, runId), record);
  return record;
}

/**
 * Release `active.lock` if (and only if) it is currently held by `runId`.
 * Never removes a lock owned by a different run, and never removes it
 * based on elapsed time — only `abandon()`/`complete()` call this.
 */
function releaseActiveLockIfOwned(projectRoot: string, runId: string): void {
  const lockPath = activeLockPath(projectRoot);
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
 * Mark `runId` abandoned (a terminal state) and release `active.lock`,
 * permitting a subsequent `createRun()` to succeed. The run's own `.json`
 * history file is never deleted.
 */
export function abandon(projectRoot: string, runId: string, reason: string): RunRecord {
  const record = readRunFile(runFilePath(projectRoot, runId));
  const updated = mutate(projectRoot, runId, record.revision, (r) => {
    r.status = "abandoned";
    // `reason` explains *why the project was abandoned*, which is not
    // the same thing as the current stage's own outcome -- kind is left
    // as whatever the stage last recorded (success/failure/decline/
    // approval_wait); only detail/recordedAt are updated to carry the
    // abandon reason, so this never misrepresents the stage's own history.
    r.stageOutcome = { ...r.stageOutcome, detail: reason, recordedAt: new Date().toISOString() };
  });
  releaseActiveLockIfOwned(projectRoot, runId);
  return updated;
}

/**
 * Mark `runId` completed (a terminal state) and release `active.lock`,
 * permitting a subsequent `createRun()` to succeed. The run's own `.json`
 * history file is never deleted.
 */
export function complete(projectRoot: string, runId: string): RunRecord {
  const record = readRunFile(runFilePath(projectRoot, runId));
  const updated = mutate(projectRoot, runId, record.revision, (r) => {
    r.status = "completed";
  });
  releaseActiveLockIfOwned(projectRoot, runId);
  return updated;
}

/**
 * Find the single active-or-paused run for a project, if any. Throws
 * `RUN_INDEX_CORRUPT` (does not skip) on any malformed run file it
 * encounters, even if that file is not the one ultimately returned.
 */
export function findActive(projectRoot: string): RunRecord | undefined {
  const files = listRunFiles(projectRoot);
  let found: RunRecord | undefined;
  for (const file of files) {
    const record = readRunFile(file);
    if (record.status === "active" || record.status === "paused") {
      found = record;
    }
  }
  return found;
}

/**
 * Find the run (if any) whose `artifacts[]` contains an entry with this
 * exact `path`. Returns `undefined` (not a thrown error) when no indexed
 * run references it — the calling stage turns that into AC-001-3's
 * rejection message.
 */
export function resolveByArtifact(projectRoot: string, artifactPath: string): RunRecord | undefined {
  const files = listRunFiles(projectRoot);
  for (const file of files) {
    const record = readRunFile(file);
    if (record.artifacts.some((a: ArtifactRef) => a.path === artifactPath)) {
      return record;
    }
  }
  return undefined;
}

/**
 * Load a run by id. Throws `RUN_INDEX_CORRUPT` if missing or malformed.
 */
export function loadRun(projectRoot: string, runId: string): RunRecord {
  return readRunFile(runFilePath(projectRoot, runId));
}

/**
 * Mutate a run through `updater`, persisting with optimistic concurrency.
 * `updater` receives the current record and mutates it in place; `revision`
 * is bumped by exactly 1 after `updater` returns — `updater` must not touch
 * `revision` itself.
 *
 * Throws `REVISION_CONFLICT` (`{ code, status: 409, currentRevision }`) on a
 * stale `expectedRevision`, mirroring `mutateSession`'s contract.
 */
export function mutate(
  projectRoot: string,
  runId: string,
  expectedRevision: number,
  updater: (record: RunRecord) => void,
): RunRecord {
  const filePath = runFilePath(projectRoot, runId);
  const record = readRunFile(filePath);

  if (record.revision !== expectedRevision) {
    throw makeRevisionConflict(record.revision);
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

export { isRevisionConflictError, isRunAlreadyActiveError };
