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
 * The log is the evidence. It is written unconditionally, because a
 * diagnostic that has to be switched on is not available at the moment
 * something surprising happens.
 */

export interface RuntimeLogEntry {
  at: string;
  kind: "activation" | "event" | "dispatch" | "invocation" | "error";
  [key: string]: unknown;
}

export function runtimeLogPath(rootDir: string): string {
  return join(rootDir, ".ensemble", "runtime-log.jsonl");
}

export function logRuntime(rootDir: string, entry: Omit<RuntimeLogEntry, "at">): void {
  try {
    const path = runtimeLogPath(rootDir);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // Logging must never break a session. Silence here is deliberate,
    // and is the one place in this package where swallowing is correct.
  }
}
