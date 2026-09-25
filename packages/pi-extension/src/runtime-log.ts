import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Append-only JSONL log of what the runtime actually did, written into the
 * repository it acted on.
 *
 * This exists because the runtime's state -- the event sink, the matcher,
 * the run records -- lives only in the host process's memory. From outside
 * that process there is no way to tell the difference between "the pipeline
 * ran correctly" and "the extension never loaded". Every claim about live
 * behavior was therefore unverifiable.
 *
 * Within an ARMED repository the log is written unconditionally: a
 * diagnostic that has to be switched on is not available at the moment
 * something surprising happens.
 *
 * An unarmed session writes nothing, anywhere. The extension is installed
 * globally and loads in EVERY session, so an unconditional write left a
 * stray artefact in whatever directory the user happened to open. Two other
 * placements were tried and rejected:
 *
 *   - <cwd>/.ensemble/ always: litters every repository the user opens.
 *   - an append-only file under ~/.omp/: moves the litter somewhere the
 *     user cannot see rather than removing it, and grows without bound
 *     across every session on the machine, forever.
 *
 * The concern motivating those -- that suppression hides a discovery BUG --
 * is real but is answered on demand rather than by a persistent write: the
 * ensemble-status command reports discovery from inside a live session, and
 * `install.mjs --status` reports what is installed from outside one. Neither
 * needs a file to exist in a repository that opted into nothing.
 */

let armed = false;

/** Set once activation has counted the behaviours in this repository. */
export function setRuntimeLoggingArmed(value: boolean): void {
  armed = value;
}

export function isRuntimeLoggingArmed(): boolean {
  return armed;
}

export interface RuntimeLogEntry {
  at: string;
  kind: "activation" | "event" | "dispatch" | "invocation" | "error";
  [key: string]: unknown;
}

export function runtimeLogPath(rootDir: string): string {
  return join(rootDir, ".ensemble", "runtime-log.jsonl");
}

export function logRuntime(rootDir: string, entry: Omit<RuntimeLogEntry, "at">): void {
  if (!armed) return;
  try {
    const path = runtimeLogPath(rootDir);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // Logging must never break a session. Silence here is deliberate,
    // and is the one place in this package where swallowing is correct.
  }
}
