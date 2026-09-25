import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Append-only JSONL log of what the runtime actually did.
 *
 * This exists because the runtime's state -- the event sink, the
 * matcher, the run records -- lives only in the host process's memory.
 * From outside that process there is no way to tell the difference
 * between "the pipeline ran correctly" and "the extension never
 * loaded". Every claim about live behavior was therefore unverifiable.
 *
 * The log is the evidence, and within an ARMED repository it is written
 * unconditionally: a diagnostic that has to be switched on is not available
 * at the moment something surprising happens.
 *
 * It is gated on the repository having behaviours, though. The extension is
 * installed globally and loads in EVERY session, so writing unconditionally
 * created a .ensemble/runtime-log.jsonl inside any directory the user
 * happened to cd into -- including ones with no behaviours, where the
 * runtime does nothing at all. An inert feature that litters every
 * repository is not inert. Logging stays off until activation discovers at
 * least one behaviour.
 */

let armed = false;

/** Enabled once activation finds behaviours in this repository. */
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
