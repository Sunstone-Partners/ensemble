/**
 * `IssueRunIndexStore`: atomic, concurrency-safe CRUD over project-local
 * `fix-issue` run records.
 *
 * Delegates its atomic-write, active-lock acquire/release, revision-conflict
 * mutate, and corrupt-file-validation I/O primitives to the shared,
 * stage-agnostic `../run-index-core.ts` (TRD-014), supplying this
 * workflow's own `.ensemble/fix-issue` runs-dir resolver and `IssueRunRecord`
 * shape validator as the generic parameters. This file's own public API,
 * `IssueStage`, and `IssueRunRecord` shape are independent from the feature
 * workflow's `RunIndexStore` (`../new-feature/run-index.ts`) -- a sibling
 * store, not a shared one (REQ-002, REQ-019). See
 * docs/TRD/TRD-2026-87e64cc6-command-surface-consolidation-data-model.md
 * (TRD-015) and the companion research doc's "Option C" rationale for the
 * full design.
 */

import * as path from "path";
import * as randomBytes from "crypto";

import {
  acquireActiveLock,
  isRevisionConflictError,
  isRunAlreadyActiveError,
  listRunFiles,
  makeRunIndexCorrupt,
  mutateRecord,
  readRunFile as coreReadRunFile,
  releaseActiveLockIfOwned,
  runFilePath as coreRunFilePath,
  writeRunAtomic,
  type RunIndexCorruptError,
  type RunAlreadyActiveError,
} from "../run-index-core";
import { ISSUE_STAGE_ORDER, type IssueArtifactRef, type IssueRunRecord, type IssueStage } from "./types";

export type { RunIndexCorruptError, RunAlreadyActiveError };
export { isRevisionConflictError, isRunAlreadyActiveError };

const ISSUE_STAGE_MEMBERSHIP: Record<string, true> = Object.fromEntries(
  ISSUE_STAGE_ORDER.map((stage) => [stage, true as const]),
);

/**
 * Directory holding every `IssueRunRecord` JSON file for a given project --
 * its own, independent run-file directory, distinct from the feature
 * workflow's `.ensemble/new-feature` (REQ-019/AC-019-1).
 */
function runsDir(projectRoot: string): string {
  return path.join(projectRoot, ".ensemble", "fix-issue");
}

/** An issue run file's absolute path. Shared by every call site below. */
function runFilePath(projectRoot: string, runId: string): string {
  return coreRunFilePath(runsDir, projectRoot, runId);
}

/**
 * Validate the shape of a value loaded from an issue run file. Throws
 * `RUN_INDEX_CORRUPT` on the first violation rather than letting a
 * partially-trusted object through.
 */
function validateIssueRunRecordShape(value: unknown, filePath: string): asserts value is IssueRunRecord {
  if (typeof value !== "object" || value === null) {
    throw makeRunIndexCorrupt(filePath, "not a JSON object");
  }
  const r = value as Record<string, unknown>;

  const requiredStrings = ["runId", "projectRoot", "issueDescription", "createdAt", "updatedAt"];
  for (const key of requiredStrings) {
    if (typeof r[key] !== "string") {
      throw makeRunIndexCorrupt(filePath, `missing or non-string field "${key}"`);
    }
  }
  if (typeof r.stage !== "string" || !ISSUE_STAGE_MEMBERSHIP[r.stage as string]) {
    throw makeRunIndexCorrupt(filePath, `stage "${String(r.stage)}" is not in the fixed enum`);
  }
  if (r.status !== "active" && r.status !== "paused" && r.status !== "completed" && r.status !== "abandoned") {
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
 * Read and validate a single issue run file. Throws `RUN_INDEX_CORRUPT` on
 * parse failure or shape violation -- never falls back to directory-scan
 * guessing.
 */
function readRunFile(filePath: string): IssueRunRecord {
  return coreReadRunFile(filePath, validateIssueRunRecordShape);
}

/**
 * Create a new run for `projectRoot` at stage `analysis_planning`. Enforces
 * single-active-run-per-project exclusivity (REQ-019/AC-019-1, mirroring
 * the feature store's own `.ensemble/fix-issue/active.lock`) independently
 * of the feature workflow's own `.ensemble/new-feature/active.lock` -- no
 * cross-store coupling.
 */
export function createRun(projectRoot: string, issueDescription: string): IssueRunRecord {
  const runId = randomBytes.randomBytes(8).toString("hex");
  acquireActiveLock(runsDir, projectRoot, runId);

  const now = new Date().toISOString();
  const record: IssueRunRecord = {
    runId,
    projectRoot,
    issueDescription,
    status: "active",
    stage: "analysis_planning",
    stageOutcome: { kind: "approval_wait", detail: "run created, stage not yet attempted", recordedAt: now },
    artifacts: [],
    beadRefs: [],
    prApprovedAt: null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
  writeRunAtomic(runFilePath(projectRoot, runId), record);
  return record;
}

/**
 * Mark `runId` abandoned (a terminal state) and release `active.lock`,
 * permitting a subsequent `createRun()` to succeed. The run's own `.json`
 * history file is never deleted.
 */
export function abandon(projectRoot: string, runId: string, reason: string): IssueRunRecord {
  const updated = mutateRecord<IssueRunRecord>(
    runFilePath(projectRoot, runId),
    readRunFile(runFilePath(projectRoot, runId)).revision,
    (r) => {
      r.status = "abandoned";
      r.stageOutcome = { ...r.stageOutcome, detail: reason, recordedAt: new Date().toISOString() };
    },
    validateIssueRunRecordShape,
  );
  releaseActiveLockIfOwned(runsDir, projectRoot, runId);
  return updated;
}

/**
 * Mark `runId` completed (a terminal state) and release `active.lock`,
 * permitting a subsequent `createRun()` to succeed. The run's own `.json`
 * history file is never deleted.
 */
export function complete(projectRoot: string, runId: string): IssueRunRecord {
  const updated = mutateRecord<IssueRunRecord>(
    runFilePath(projectRoot, runId),
    readRunFile(runFilePath(projectRoot, runId)).revision,
    (r) => {
      r.status = "completed";
    },
    validateIssueRunRecordShape,
  );
  releaseActiveLockIfOwned(runsDir, projectRoot, runId);
  return updated;
}

/**
 * Find the single active-or-paused run for a project, if any. Throws
 * `RUN_INDEX_CORRUPT` (does not skip) on any malformed run file it
 * encounters, even if it is not the one ultimately returned.
 */
export function findActive(projectRoot: string): IssueRunRecord | undefined {
  const files = listRunFiles(runsDir, projectRoot);
  let found: IssueRunRecord | undefined;
  for (const file of files) {
    const record = readRunFile(file);
    if (record.status === "active" || record.status === "paused") found = record;
  }
  return found;
}

/**
 * Find the run (if any) whose `artifacts[]` contains an entry with this
 * exact `path`. Returns `undefined` (not a thrown error) when no indexed
 * run references it.
 */
export function resolveByArtifact(projectRoot: string, artifactPath: string): IssueRunRecord | undefined {
  const files = listRunFiles(runsDir, projectRoot);
  for (const file of files) {
    const record = readRunFile(file);
    if (record.artifacts.some((a: IssueArtifactRef) => a.path === artifactPath)) return record;
  }
  return undefined;
}

/** Load a run by id. Throws `RUN_INDEX_CORRUPT` if missing or malformed. */
export function loadRun(projectRoot: string, runId: string): IssueRunRecord {
  return readRunFile(runFilePath(projectRoot, runId));
}

/**
 * Mutate a run through `updater`, persisting with optimistic concurrency.
 * `updater` receives the current record and mutates it in place; `revision`
 * must not touch `revision` itself. Throws `REVISION_CONFLICT` (`{ code,
 * status: 409, currentRevision }`) on a stale `expectedRevision`, mirroring
 * the feature store's `mutate()`'s own contract.
 */
export function mutate(
  projectRoot: string,
  runId: string,
  expectedRevision: number,
  updater: (record: IssueRunRecord) => void,
): IssueRunRecord {
  return mutateRecord<IssueRunRecord>(runFilePath(projectRoot, runId), expectedRevision, updater, validateIssueRunRecordShape);
}
