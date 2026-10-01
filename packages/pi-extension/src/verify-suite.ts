import { spawnSync } from "node:child_process";

export type VerificationStatus = "passed" | "failed" | "inconclusive";

export interface Verdict {
  status: VerificationStatus;
  detail: string;
}

interface Totals {
  /** Jest summaries seen (one per jest run). */
  runs: number;
  failed: number;
  passed: number;
  skipped: number;
  total: number;
  failedSuites: number;
}

const count = (line: string, label: string): number =>
  Number(new RegExp(`\\b(\\d+)\\s+${label}\\b`).exec(line)?.[1] ?? 0);

/**
 * Sums every jest `Tests:` and `Test Suites:` summary in the output.
 * Anchored to line starts so a test NAME containing "Tests:" is not counted.
 */
export function parseTotals(text: string): Totals {
  const t: Totals = { runs: 0, failed: 0, passed: 0, skipped: 0, total: 0, failedSuites: 0 };
  for (const [, line] of text.matchAll(/^[ \t]*Tests:[ \t]+(.*)$/gm)) {
    t.runs++;
    t.failed += count(line, "failed");
    t.passed += count(line, "passed");
    t.skipped += count(line, "skipped");
    t.total += count(line, "total");
  }
  for (const [, line] of text.matchAll(/^[ \t]*Test Suites:[ \t]+(.*)$/gm)) {
    t.failedSuites += count(line, "failed");
  }
  return t;
}

function describeTotals(t: Totals): string {
  const tests = [
    t.failed && `${t.failed} failed`,
    t.skipped && `${t.skipped} skipped`,
    `${t.passed} passed`,
    `${t.total} total`,
  ]
    .filter(Boolean)
    .join(", ");
  const suites = t.failedSuites ? `${t.failedSuites} test suite(s) failed or could not load; ` : "";
  const runs = t.runs > 1 ? ` across ${t.runs} jest runs` : "";
  return `${suites}${tests}${runs}`;
}

/**
 * Re-runs a failing test command and reports what actually happened.
 *
 * A continuation turn ends with the model ASSERTING that it fixed the
 * problem. Accepting that assertion is the failure this project exists to
 * prevent, so the claim is never the evidence: the suite is re-run here and
 * the verdict comes from its output.
 *
 * Four traps this deliberately handles, all observed live rather than
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
 *
 * 3. A SUITE THAT CANNOT LOAD IS NOT A VERDICT, AND MUST SAY SO. Observed
 *    live (br-srbd): `npx jest` at a root with no jest config failed to load
 *    66 TypeScript suites while every test that did load passed. The old
 *    parse read only the first `Tests:` line ("2693 passed"), found no
 *    failure count and fell through to the bare exit code -- a "failed"
 *    verdict whose detail showed nothing failing, and a rollback of a repair
 *    that was correct. `Test Suites: N failed` is now read and reported
 *    explicitly, but as "inconclusive": the harness could not run, which is
 *    an environment problem, not evidence about the change. A wrong "failed"
 *    destroys correct work silently; an "inconclusive" never does.
 *
 * 4. EVERY SUMMARY COUNTS. A repo-level `npm test` runs one jest per
 *    workspace and prints one summary each; a failure in the fifth must not
 *    be hidden behind a pass in the first. All summaries are summed.
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
  const t = parseTotals(text);
  const detail = describeTotals(t);

  // ORDER MATTERS. Two branches drew OPPOSITE conclusions from the same
  // observation and both landed here: #94 graded "suites failed to load" as
  // a failure, br-srbd graded it inconclusive. Merging kept both, with the
  // failure check first, which made the inconclusive branch dead code and
  // silently restored the bug br-srbd exists to fix.
  //
  // Reconciled below. Both branches agree the case must NEVER be "passed";
  // they differ on whether it should ROLL BACK. It must not, and #94's
  // better detail is kept.

  // Failing TESTS are a verdict on the fix.
  if (t.failed > 0) {
    return { status: "failed", detail: detail + failingSuites(text) };
  }

  // Suites that never LOADED are not.
  //
  // OBSERVED LIVE (br-srbd): a root-level `npx jest` with no root config
  // produced "66 suites failed to run, 2693 tests passed, 0 failed" and
  // exit 1 -- every TypeScript suite died on `import type` before a single
  // assertion ran. Graded "failed", restoreWorkingTree() then rolled back a
  // correct a-b -> a+b repair that had passed its own test.
  //
  // Zero failed TESTS alongside failed SUITES means the harness could not
  // run: an environment problem, not evidence about the change. The suites
  // are NAMED (#94's fix) so this is never a bare verdict with empty detail.
  if (t.failedSuites > 0) {
    return {
      status: "inconclusive",
      detail: `suites failed to load, no test failures; ${detail}${failingSuites(text)}`,
    };
  }

  // A non-zero count of passed/failed/total is the proof that the suite
  // actually executed. Matching a bare number would accept "0 total".
  if (t.passed + t.total === 0) {
    return {
      status: "inconclusive",
      detail: `re-run executed no tests (cwd=${cwd ?? fallbackCwd}); ${detail}`,
    };
  }

  // The exit code is NOT trusted on its own. Observed live: the model ran
  // `npx jest live-e2e 2>&1 | tail -60`, and in a pipeline $? is the status
  // of `tail`, not of jest -- so a suite reporting "1 failed, 1 passed"
  // exited 0 and was graded "passed". Reported failure counts (above)
  // outweigh a zero exit; a non-zero exit with no reported failure is still
  // a failure, and says so rather than showing only passing counts.
  if (out.status !== 0) {
    return {
      status: "failed",
      detail:
        `command exited ${out.status ?? `on signal ${out.signal}`} with no failing test reported; ${detail}` +
        failureHint(out.stderr ?? ""),
    };
  }
  return { status: "passed", detail };
}

/**
 * Names what failed when no test did. `npm test` across workspaces reports
 * the failing workspace as `npm error path ...` / `npm error workspace ...`;
 * anything else falls back to the last stderr line. Without this the detail
 * shows only passing counts and the rollback looks like the fix's fault --
 * observed: a missing pytest under CI=true read as "the fix broke something".
 */
function failureHint(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const npm = lines.filter((l) => /^npm error (workspace|path) /.test(l));
  const hint = (npm.length ? npm : lines.slice(-1)).join("; ").slice(0, 300);
  return hint ? `; stderr: ${hint}` : "";
}

/**
 * Names the failing test files. Without them, the rollback notice says a
 * test failed but not which one, and the model cannot tell whether its fix
 * broke a real caller or tripped over something unrelated -- observed live.
 */
export function failingSuites(text: string, max = 5): string {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  const files = [...new Set([...plain.matchAll(/^[ \t]*FAIL[ \t]+(\S+)/gm)].map((m) => m[1]))];
  if (files.length === 0) return "";
  const more = files.length > max ? ` (+${files.length - max} more)` : "";
  return `; failing: ${files.slice(0, max).join(", ")}${more}`;
}
