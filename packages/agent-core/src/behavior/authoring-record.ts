import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Behavior-authoring timestamps (TRD-023 / REQ-029, AC-029-1).
 *
 * Records when each behavior package was first discovered (authoring
 * started) and when its fixture conformance first passed (authoring
 * completed), in the checkout, so authoring turnaround is observable
 * without anyone instrumenting their own workflow by hand.
 *
 * Both timestamps are write-once. A later discovery never moves a start and
 * a later pass never moves a completion, so repeating either step cannot
 * shorten or stretch the turnaround being measured.
 *
 * The record is a metric, never a gate (data model, Validation Rules). An
 * unreadable, malformed or unknown-version file disables recording with a
 * named diagnostic and is left exactly as found -- writing over it would
 * destroy the history it holds. Nothing here throws, so a bad record can
 * never fail discovery, and through discovery never fail activation.
 *
 * There is no cross-process lock. Two sessions starting in one checkout at
 * the same instant can lose one's update to the other's rename. The file is
 * never torn, and a lost entry is recorded again, later, the next time
 * discovery or activation runs. Acceptable for a metric, never for a gate.
 */

/** Repository-relative location of the record (data model: AuthoringRecord). */
export const AUTHORING_STATE_PATH = join(".ensemble", "state", "authoring.json");
export const AUTHORING_SCHEMA_VERSION = "1.0.0";

export interface AuthoringRecord {
  /** Behavior id, exactly as discovery reports it. */
  package: string;
  /** ISO-8601 UTC. First discovery; written once. */
  startedAt: string;
  /** ISO-8601 UTC. First passing fixture-conformance run; null until then. */
  completedAt: string | null;
}

export interface AuthoringRecordOptions {
  /** Clock seam for tests. */
  readonly now?: () => Date;
  /** Receives the named diagnostic whenever the record cannot be used or written. */
  readonly onDiagnostic?: (message: string) => void;
}

export type AuthoringRecordsRead =
  | { readonly ok: true; readonly entries: AuthoringRecord[] }
  | { readonly ok: false; readonly diagnostic: string };

const DISABLED = "authoring timestamps are not recorded until it is fixed or removed";

// Structural, not `instanceof Error`: fs errors can come from another realm
// (a jest VM context, for one), where `instanceof Error` is false.
function errorMessage(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : String(error);
}

/** ISO-8601 UTC as `toISOString()` writes it (data model: "Timestamps are ISO-8601 UTC"). */
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_8601_UTC.test(value) && !Number.isNaN(Date.parse(value));
}

function isAuthoringRecord(value: unknown): value is AuthoringRecord {
  if (typeof value !== "object" || value === null) return false;
  if (!("package" in value) || typeof value.package !== "string" || value.package.length === 0) return false;
  if (!("startedAt" in value) || !isTimestamp(value.startedAt)) return false;
  return "completedAt" in value && (value.completedAt === null || isTimestamp(value.completedAt));
}

function parseAuthoringFile(path: string, value: unknown): AuthoringRecordsRead {
  const malformed = (why: string): AuthoringRecordsRead => ({ ok: false, diagnostic: `${path} ${why}; ${DISABLED}` });

  if (typeof value !== "object" || value === null || Array.isArray(value)) return malformed("is not a JSON object");
  if (!("schema_version" in value)) return malformed("has no schema_version");
  if (value.schema_version !== AUTHORING_SCHEMA_VERSION) {
    return malformed(
      `has unsupported schema_version ${JSON.stringify(value.schema_version)} ` +
        `(this runtime reads ${JSON.stringify(AUTHORING_SCHEMA_VERSION)})`,
    );
  }
  if (!("entries" in value) || !Array.isArray(value.entries)) return malformed("has no entries array");

  const entries: AuthoringRecord[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries.entries()) {
    if (!isAuthoringRecord(entry)) return malformed(`has an invalid entry at index ${index}`);
    // Two starts for one package would leave the turnaround ambiguous.
    if (seen.has(entry.package)) return malformed(`has more than one entry for "${entry.package}"`);
    seen.add(entry.package);
    entries.push({ package: entry.package, startedAt: entry.startedAt, completedAt: entry.completedAt });
  }
  return { ok: true, entries };
}

/** Reads and validates `<rootDir>/.ensemble/state/authoring.json`. A missing file is no records, not an error. */
export function readAuthoringRecords(rootDir: string): AuthoringRecordsRead {
  const path = join(rootDir, AUTHORING_STATE_PATH);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // Data model, Migration notes: a missing file means "no records".
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { ok: true, entries: [] };
    }
    return { ok: false, diagnostic: `${path} is unreadable (${errorMessage(error)}); ${DISABLED}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, diagnostic: `${path} is malformed JSON (${errorMessage(error)}); ${DISABLED}` };
  }
  return parseAuthoringFile(path, parsed);
}

/** Returns a diagnostic when the write did not land, undefined when it did. */
function writeAuthoringRecords(rootDir: string, entries: readonly AuthoringRecord[]): string | undefined {
  const path = join(rootDir, AUTHORING_STATE_PATH);
  // Write, then rename over the target, so neither a concurrent reader nor
  // a crash mid-write ever leaves half a file behind.
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify({ schema_version: AUTHORING_SCHEMA_VERSION, entries }, null, 2)}\n`);
    renameSync(temporary, path);
    return undefined;
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The write already failed; the diagnostic below is the report.
    }
    return `${path} could not be written (${errorMessage(error)}); authoring timestamps were not recorded`;
  }
}

/**
 * Records first discovery for every id that has no record yet, and returns
 * the ids this call recorded. An id already present keeps its start: it is
 * recorded once and never overwritten.
 */
export function recordAuthoringStarts(
  rootDir: string,
  behaviorIds: readonly string[],
  options: AuthoringRecordOptions = {},
): string[] {
  // Nothing discovered means nothing to record. A repository without
  // behaviors must not grow an empty state file just for being looked at.
  if (behaviorIds.length === 0) return [];

  const read = readAuthoringRecords(rootDir);
  if (!read.ok) {
    options.onDiagnostic?.(read.diagnostic);
    return [];
  }

  const known = new Set(read.entries.map((entry) => entry.package));
  const added = [...new Set(behaviorIds)].filter((id) => !known.has(id));
  if (added.length === 0) return [];

  const startedAt = (options.now?.() ?? new Date()).toISOString();
  const failure = writeAuthoringRecords(rootDir, [
    ...read.entries,
    ...added.map((id) => ({ package: id, startedAt, completedAt: null })),
  ]);
  if (failure) {
    options.onDiagnostic?.(failure);
    return [];
  }
  return added;
}

/**
 * Records a package's first passing conformance run as its authoring
 * completion, and returns whether this call recorded it. A later pass never
 * moves it. A package with no recorded start gets no completion: a
 * completion without a start would report a turnaround nobody measured.
 */
export function recordAuthoringCompletion(
  rootDir: string,
  behaviorId: string,
  options: AuthoringRecordOptions = {},
): boolean {
  const read = readAuthoringRecords(rootDir);
  if (!read.ok) {
    options.onDiagnostic?.(read.diagnostic);
    return false;
  }

  const entry = read.entries.find((candidate) => candidate.package === behaviorId);
  if (!entry) {
    options.onDiagnostic?.(
      `no authoring start is recorded for "${behaviorId}" in ${join(rootDir, AUTHORING_STATE_PATH)}, ` +
        `so its passing conformance run is not recorded as a completion; discovery records the start`,
    );
    return false;
  }
  if (entry.completedAt !== null) return false;

  entry.completedAt = (options.now?.() ?? new Date()).toISOString();
  const failure = writeAuthoringRecords(rootDir, read.entries);
  if (failure) {
    options.onDiagnostic?.(failure);
    return false;
  }
  return true;
}
