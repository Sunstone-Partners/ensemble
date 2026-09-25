import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
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
 * The log is the evidence, and it is written unconditionally: a diagnostic
 * that has to be switched on is not available at the moment something
 * surprising happens.
 *
 * WHERE it lands is conditional, and that distinction is load-bearing. The
 * extension is installed globally and loads in EVERY session, so writing to
 * <cwd>/.ensemble/ unconditionally created a stray log inside any directory
 * the user happened to open -- including ones with no behaviours.
 *
 * Suppressing the write instead was worse, and was briefly done here: a
 * repository that discovers 0 behaviours BECAUSE OF A BUG would then produce
 * no evidence at all, which is precisely the "cannot distinguish working
 * from never-loaded" problem this file exists to prevent.
 *
 * So: an unarmed session still records its activation, out of the way, under
 * ~/.omp/ensemble/. Only the per-session event stream -- which is noise
 * outside a repository that actually uses behaviours -- is dropped.
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

/**
 * Where activation records go when a repository armed nothing. Outside the
 * user's tree, so it never shows up in their git status, but still on disk
 * so "it did nothing" and "it never loaded" stay distinguishable.
 */
export function unarmedRuntimeLogPath(): string {
  return join(homedir(), ".omp", "ensemble", "runtime-log.jsonl");
}

export function logRuntime(rootDir: string, entry: Omit<RuntimeLogEntry, "at">): void {
  // Activation is the one record that must survive an unarmed session: it is
  // the only thing that proves the extension loaded at all.
  const path = armed
    ? runtimeLogPath(rootDir)
    : entry.kind === "activation"
      ? unarmedRuntimeLogPath()
      : null;
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const record = armed ? entry : { ...entry, cwd: rootDir };
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
  } catch {
    // Logging must never break a session. Silence here is deliberate,
    // and is the one place in this package where swallowing is correct.
  }
}
