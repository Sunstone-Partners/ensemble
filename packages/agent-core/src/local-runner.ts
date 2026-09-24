import { spawn, ChildProcess } from "node:child_process";
import { InvocationStatus } from "./protocol";

/**
 * LocalRunner: an explicit, named LOCAL/SIMULATION-ONLY execution
 * mechanism (architecture doc §8: "A local runner may exist, but it
 * must be explicit and named as local/simulation-only... It must not
 * claim durability, recovery, or Foreman ownership."). It bounds one
 * child process invocation with cancellation and timeout, guaranteeing
 * no orphan process remains afterward (TRD-019).
 *
 * This does not spawn or manage a Pi/OMP session itself — pi-extension
 * runs inside an already-live Pi session it never owns the lifecycle
 * of. LocalRunner is the bounded local-execution primitive a behavior
 * package's `execution.graph` step (or a local simulation) can use for
 * an actual local subprocess, with the same cancel/timeout/cleanup
 * guarantees regardless of which triggers it.
 */
export interface LocalRunnerOptions {
  command: string;
  args?: string[];
  timeoutMs: number;
}

export interface LocalRunnerResult {
  status: InvocationStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

const GRACE_PERIOD_MS = 200;

export class LocalRunner {
  private child?: ChildProcess;
  private cancelled = false;

  /**
   * Runs one bounded local invocation. Resolves with "completed" if the
   * process exits on its own within timeoutMs, "timeout" if the timeout
   * fires first, or "cancelled" if cancel() was called — cleanup
   * (SIGTERM, then SIGKILL after a grace period if still alive) is
   * identical for both the timeout and the cancel path (AC-019-2).
   */
  async run(options: LocalRunnerOptions): Promise<LocalRunnerResult> {
    const { promise, resolve } = Promise.withResolvers<LocalRunnerResult>();

    const child = spawn(options.command, options.args ?? [], { stdio: "ignore" });
    this.child = child;

    let settled = false;
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      this.terminate();
    }, options.timeoutMs);

    child.on("exit", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);

      let status: InvocationStatus;
      if (this.cancelled) {
        status = "cancelled";
      } else if (timedOut) {
        status = "timeout";
      } else {
        status = exitCode === 0 ? "completed" : "failed";
      }

      resolve({ status, exitCode, signal });
    });

    return promise;
  }

  /** Cancels a running invocation. Cleanup is identical to the timeout path. */
  cancel(): void {
    this.cancelled = true;
    this.terminate();
  }

  private terminate(): void {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    this.child.kill("SIGTERM");
    const child = this.child;
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, GRACE_PERIOD_MS);
  }
}

/** Returns true if a process with the given pid is still alive (used to prove no orphan remains). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
