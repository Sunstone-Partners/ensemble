import { spawnSync } from "node:child_process";

export type VerificationStatus = "passed" | "failed" | "inconclusive";

export interface Verdict {
  status: VerificationStatus;
  detail: string;
}

/**
 * Re-runs a failing test command and reports what actually happened.
 *
 * A continuation turn ends with the model ASSERTING that it fixed the
 * problem. Accepting that assertion is the failure this project exists to
 * prevent, so the claim is never the evidence: the suite is re-run here and
 * the verdict comes from its output.
 *
 * Two traps this deliberately handles, both observed live rather than
 * imagined:
 *
 * 1. WRONG DIRECTORY IS NOT A PASS. The command must run where it originally
 *    failed. `npx jest live-e2e` at the repo root matches ZERO tests and
 *    exits 0 -- a false pass that would rubber-stamp any fix, including no
 *    fix at all. The cwd is carried from the bash tool input for this reason.
 *
 * 2. EXIT CODE ALONE IS NOT ENOUGH. Because of (1), a zero exit must be
 *    corroborated by evidence that tests actually ran. A run reporting no
 *    tests is "inconclusive" -- never "passed". Reporting uncertainty is
 *    strictly better than guessing, because a wrong "passed" is silently
 *    accepted while an "inconclusive" is visible.
 */
export function verifySuite(
  command: string,
  cwd: string | undefined,
  fallbackCwd: string,
  timeoutMs = 300_000,
): Verdict {
  const out = spawnSync("bash", ["-lc", command], {
    cwd: cwd ?? fallbackCwd,
    encoding: "utf8",
    timeout: timeoutMs,
  });

  const text = `${out.stdout ?? ""}${out.stderr ?? ""}`;
  const totals = /Tests:\s+(.*)/.exec(text)?.[1] ?? "";
  // A non-zero count of passed/failed/total is the proof that the suite
  // actually executed. Matching a bare number would accept "0 total".
  const ranSomething = /\b[1-9]\d*\s+(passed|failed|total)/.test(totals);

  if (!ranSomething) {
    return {
      status: "inconclusive",
      detail: `re-run executed no tests (cwd=${cwd ?? fallbackCwd}); totals=${JSON.stringify(totals)}`,
    };
  }

  return {
    status: out.status === 0 ? "passed" : "failed",
    detail: totals.trim(),
  };
}
