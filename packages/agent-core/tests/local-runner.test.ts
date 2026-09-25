import { LocalRunner, isProcessAlive } from "../src/local-runner";

// Real wall-clock wait, not a fake timer: this exercises a genuine OS
// child process (spawn/SIGTERM/SIGKILL) and process.kill(pid, 0)
// liveness checks, which cannot be driven by a virtual clock.
function wait(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

describe("LocalRunner (TRD-019)", () => {
  it("AC-019-1: cancelling a running invocation terminates the real child process with no orphan remaining", async () => {
    const runner = new LocalRunner();
    // A genuinely long-running child process (Node event loop kept alive).
    const runPromise = runner.run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 60_000,
    });

    // Let it actually start before cancelling.
    await wait(150);
    const pidBeforeCancel = (runner as unknown as { child?: { pid?: number } }).child?.pid;
    expect(typeof pidBeforeCancel).toBe("number");
    expect(isProcessAlive(pidBeforeCancel as number)).toBe(true);

    runner.cancel();
    const result = await runPromise;

    expect(result.status).toBe("cancelled");
    // Verified via real process listing (process.kill(pid, 0)) after the
    // test: no orphan process remains.
    expect(isProcessAlive(pidBeforeCancel as number)).toBe(false);
  });

  it("AC-019-2: an invocation exceeding timeoutMs returns status 'timeout' and cleans up identically to cancellation", async () => {
    const runner = new LocalRunner();
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 200,
    });

    expect(result.status).toBe("timeout");
    const pid = (runner as unknown as { child?: { pid?: number } }).child?.pid;
    expect(typeof pid).toBe("number");
    expect(isProcessAlive(pid as number)).toBe(false);
  });

  it("resolves 'completed' for a process that exits successfully on its own well within the timeout", async () => {
    const runner = new LocalRunner();
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 5_000,
    });
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
  });

  it("resolves 'failed' for a process that exits with a non-zero code on its own", async () => {
    const runner = new LocalRunner();
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
      timeoutMs: 5_000,
    });
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
  });
});
