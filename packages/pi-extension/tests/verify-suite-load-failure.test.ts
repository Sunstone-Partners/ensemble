import { verifySuite } from "../src/verify-suite";
import { tmpdir } from "node:os";

/**
 * br-srbd: suites that never loaded were graded "failed", so correct fixes
 * were rolled back.
 *
 * The numbers below are the ones from the live run: a root `npx jest` with
 * no root config, where every TypeScript suite died on `import type` before
 * any assertion executed.
 */

const LOAD_FAILURE = [
  "Test Suites: 66 failed, 104 passed, 170 total",
  "Tests:       2693 passed, 2693 total",
  "Snapshots:   0 total",
].join("\n");

const REAL_FAILURE = [
  "Test Suites: 1 failed, 16 passed, 17 total",
  "Tests:       2 failed, 128 passed, 130 total",
].join("\n");

const CLEAN_PASS = [
  "Test Suites: 17 passed, 17 total",
  "Tests:       130 passed, 130 total",
].join("\n");

/** Runs verifySuite against canned runner output with a chosen exit code. */
function grade(output: string, exitCode: number) {
  const script = `cat <<'EOF'\n${output}\nEOF\nexit ${exitCode}`;
  return verifySuite(script, tmpdir(), tmpdir());
}

describe("verifySuite and suites that never ran", () => {
  it("does not call a load failure a test failure", () => {
    // 0 failed TESTS but 66 failed SUITES: the harness could not run, which
    // says nothing about the change. Grading this "failed" rolled back
    // correct work (a verified a-b -> a+b repair was reverted).
    const verdict = grade(LOAD_FAILURE, 1);

    expect(verdict.status).toBe("inconclusive");
    expect(verdict.detail).toContain("suites failed to load");
  });

  it("still fails when tests actually failed", () => {
    const verdict = grade(REAL_FAILURE, 1);

    expect(verdict.status).toBe("failed");
    expect(verdict.detail).toContain("2 failed");
  });

  it("still passes a clean run", () => {
    expect(grade(CLEAN_PASS, 0).status).toBe("passed");
  });

  it("a failing suite WITH failing tests is a real failure, not a load error", () => {
    // Both counts non-zero: the suite ran and its assertions failed.
    expect(grade(REAL_FAILURE, 0).status).toBe("failed");
  });

  it("reports inconclusive when no tests ran at all", () => {
    expect(grade("Tests:       0 total", 0).status).toBe("inconclusive");
  });
});
