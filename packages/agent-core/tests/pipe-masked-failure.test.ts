import { translateEvent, outputReportsFailure } from "../src/behavior/event-translator";

const completed = (payload: Record<string, unknown>) => ({
  type: "runtime.tool_call.completed",
  source: "test",
  payload,
}) as never;

const JEST_FAIL = `FAIL tests/live-e2e.test.ts
  ✕ adds one and one (1 ms)

Tests:       1 failed, 1 total`;

const JEST_PASS = `PASS tests/live-e2e.test.ts
  ✓ adds one and one (1 ms)

Tests:       1 passed, 1 total`;

describe("failure detection does not depend on exit status", () => {
  // The exact shape observed live: `npx jest live-e2e 2>&1 | tail -5`
  // reports tail's status, so a failing suite arrives as isError=false.
  it("detects a failing suite whose exit status was masked by a pipe", () => {
    const derived = translateEvent(
      completed({
        command: "npx jest live-e2e 2>&1 | tail -5",
        isError: false,
        output: JEST_FAIL,
      }),
    );
    expect(derived?.type).toBe("test.failure.observed");
    expect((derived?.payload as Record<string, unknown>).detectedBy).toBe("output");
  });

  it("still detects via exit status when the shell reports it", () => {
    const derived = translateEvent(
      completed({ command: "npx jest live-e2e", isError: true, output: JEST_FAIL }),
    );
    expect(derived?.type).toBe("test.failure.observed");
    expect((derived?.payload as Record<string, unknown>).detectedBy).toBe("exit-status");
  });

  // The dangerous direction: firing on a healthy suite would make autofix
  // chase passing tests, which is worse than missing a failure.
  it("does NOT fire on a passing suite piped through tail", () => {
    expect(
      translateEvent(
        completed({ command: "npx jest live-e2e | tail -5", isError: false, output: JEST_PASS }),
      ),
    ).toBeUndefined();
  });

  it("does NOT fire on a passing suite reporting zero failures", () => {
    expect(outputReportsFailure("Tests:       3 passed, 0 failed, 3 total")).toBe(false);
  });

  it("does NOT fire on a non-test command whose output mentions failures", () => {
    expect(
      translateEvent(
        completed({
          command: "git log --oneline",
          isError: false,
          output: "abc1234 fix: 2 failed deploys",
        }),
      ),
    ).toBeUndefined();
  });

  it("detects pytest, go, cargo and mix failure summaries", () => {
    expect(outputReportsFailure("=== 1 failed, 2 passed in 0.12s ===")).toBe(true);
    expect(outputReportsFailure("FAIL\tgithub.com/x/y\t0.01s")).toBe(true);
    expect(outputReportsFailure("test result: FAILED. 1 passed; 1 failed")).toBe(true);
    expect(outputReportsFailure("5 tests, 1 failure")).toBe(true);
    expect(outputReportsFailure("5 tests, 0 failures")).toBe(false);
  });
});
