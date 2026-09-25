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

// The inverse of the pipe case. A compound command reports the exit status
// of whatever ran LAST, so a non-zero status only means "tests failed" when
// the runner is what ran last. Both commands below were observed live: each
// dispatched autofix against a fully green suite.
describe("exit status counts only when it is the runner's own", () => {
  const JEST_ALL_PASS = "Test Suites: 17 passed, 17 total\nTests:       129 passed, 129 total";

  it("does NOT fire when a trailing non-test command set the exit status", () => {
    expect(
      translateEvent(
        completed({
          command:
            'npm test 2>&1 | grep -E "^(Tests|Test Suites):|FAIL "; grep -nE "incremental" ../agent-core/tsconfig.json; ls ../agent-core/*.tsbuildinfo 2>&1',
          isError: true,
          output: `${JEST_ALL_PASS}\nls: cannot access '../agent-core/*.tsbuildinfo': No such file or directory`,
        }),
      ),
    ).toBeUndefined();
  });

  it("does NOT fire when a trailing grep matched nothing", () => {
    expect(
      translateEvent(
        completed({
          command:
            'rm -rf packages/agent-core/dist; npm test > /tmp/log 2>&1; echo "exit=$?"; grep -E "^(Tests|Test Suites):" /tmp/log | grep -E "failed"',
          isError: true,
          output: "exit=0",
        }),
      ),
    ).toBeUndefined();
  });

  it("still fires on exit status when the runner ran last", () => {
    for (const command of ["npx jest foo", "cd packages/core && npx jest", "npm test > /tmp/log 2>&1", 'npx jest -t "adds|subtracts"']) {
      const derived = translateEvent(completed({ command, isError: true, output: "" }));
      expect({ command, type: derived?.type }).toEqual({ command, type: "test.failure.observed" });
      expect((derived?.payload as Record<string, unknown>).detectedBy).toBe("exit-status");
    }
  });

  it("still fires by output when a compound command's tests failed", () => {
    const derived = translateEvent(
      completed({ command: "npx jest foo; echo done", isError: false, output: JEST_FAIL }),
    );
    expect((derived?.payload as Record<string, unknown>).detectedBy).toBe("output");
  });

  it("trusts exit status for an exact declared test command", () => {
    const derived = translateEvent(
      completed({ command: "make check", isError: true, output: "" }),
      { testCommand: "make check" },
    );
    expect((derived?.payload as Record<string, unknown>).detectedBy).toBe("exit-status");
  });
});
