import { normalizeEvent } from "../normalize";
import type { BehaviorEvent } from "../events";

/**
 * Derives semantic events from raw runtime events (TRD-012 / REQ-002).
 *
 * A behavior triggers on `test.failure.observed`, but nothing in the
 * runtime ever emitted that type: Pi emits `runtime.tool_call.completed`
 * and no component turned one into the other, so a behavior with that
 * trigger could never fire in production no matter how correct its
 * manifest was. This module is that missing link.
 */

/** Commands treated as test runs when they fail. */
// Anchored with ^: these are matched against a command-position token
// sequence, never against the whole command line. See isTestCommand.
const TEST_COMMAND_PATTERNS: readonly RegExp[] = [
  /^npm\s+(run\s+)?test\b/,
  /^(\S*\/)?jest\b/,
  /^(\S*\/)?vitest\b/,
  /^(\S*\/)?pytest\b/,
  /^python\s+-m\s+pytest\b/,
  /^go\s+test\b/,
  /^cargo\s+test\b/,
  /^mix\s+test\b/,
  /^bun\s+test\b/,
  /^pnpm\s+(run\s+)?test\b/,
  /^yarn\s+test\b/,
];

/** Shell operators that begin a new command. */
const SEGMENT_SPLIT = /(?:\|\||&&|;|\||\n)/;
/** Wrappers that delegate to the runner named after them. */
const WRAPPERS = new Set(["npx", "bunx", "sudo", "time", "env", "exec", "command"]);

/**
 * True when the command actually INVOKES a test runner.
 *
 * Substring matching was wrong and fired in production. Observed live: the
 * model ran
 *   `git status --short; ls tests src; cat src/live-math.ts; cat jest.config.* package.json`
 * and `/\bjest\b/` matched the FILENAME `jest.config.*`. That misclassified an
 * investigation command as a failing test run, queued a continuation for it,
 * and burned a retry from the budget on a command that runs no tests.
 *
 * So the runner must appear in COMMAND POSITION: the first token of some
 * shell segment, after stripping wrappers (npx, bunx, env VAR=1, ...) and
 * leading environment assignments. Mentioning a runner as an ARGUMENT --
 * `cat jest.config.js`, `grep jest package.json` -- is not an invocation.
 */
export function isTestCommand(command: string): boolean {
  return command
    .split(SEGMENT_SPLIT)
    .some((segment) => segmentInvokesRunner(segment));
}

function segmentInvokesRunner(segment: string): boolean {
  let tokens = segment.trim().split(/\s+/).filter(Boolean);
  // Strip leading `VAR=value` assignments and known wrappers so that
  // `CI=1 npx jest` is recognised while `cat jest.config.js` is not.
  while (tokens.length > 0) {
    const head = tokens[0] as string;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head) || WRAPPERS.has(head)) {
      tokens = tokens.slice(1);
      continue;
    }
    break;
  }
  if (tokens.length === 0) return false;
  // Re-join so multi-word invocations (`go test`, `npm run test`) still match,
  // but anchor every pattern to the START of the command.
  const invocation = tokens.join(" ");
  return TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(invocation));
}

/**
 * Output signatures that mean "a test run reported failures".
 *
 * Exit status alone is not a reliable failure signal. Observed live: the
 * model ran `npx jest live-e2e 2>&1 | tail -5`, and because a pipeline
 * reports the status of its LAST command, the tool result carried
 * isError=false for a suite that genuinely failed. No failure event fired
 * and autofix never started, while an otherwise identical run without the
 * pipe worked. Piping test output through tail/head/grep is ordinary model
 * behaviour, so detection cannot depend on the model avoiding it.
 *
 * Every pattern requires a NON-ZERO failure count. Matching a bare word
 * like "failed" would fire on the routine "Tests: 3 passed, 0 failed" and
 * on prose mentioning failure, which would be worse than missing the
 * failure: autofix would chase healthy suites.
 */
const FAILURE_OUTPUT_PATTERNS: readonly RegExp[] = [
  // jest / vitest summary: "Tests: 1 failed, 2 passed, 3 total"
  /^\s*Tests:.*?\b[1-9]\d*\s+failed\b/m,
  // jest / vitest suite summary: "Test Suites: 1 failed"
  /^\s*Test Suites:.*?\b[1-9]\d*\s+failed\b/m,
  // jest per-suite marker at line start: "FAIL tests/foo.test.ts"
  /^\s*FAIL\s+\S/m,
  // pytest: "1 failed, 2 passed" / "=== 3 failed ==="
  /\b[1-9]\d*\s+failed\b/,
  // pytest collection errors: "1 error in 0.1s"
  /^\s*=+\s.*\b[1-9]\d*\s+error(s)?\b.*=+\s*$/m,
  // go test: a line that is exactly FAIL, or "FAIL\tpkg"
  /^FAIL\b/m,
  // cargo: "test result: FAILED. 1 passed; 1 failed"
  /test result:\s*FAILED\b/,
  // mix test: "5 tests, 1 failure"
  /\b\d+\s+tests?,\s+[1-9]\d*\s+failures?\b/,
];

/**
 * True when output shows a test run that reported failures.
 *
 * Used ONLY for commands already identified as test runs, so a build log
 * or unrelated command mentioning "1 failed" cannot trigger a fix.
 */
export function outputReportsFailure(output: string): boolean {
  return FAILURE_OUTPUT_PATTERNS.some((pattern) => pattern.test(output));
}

export interface TranslationOptions {
  /**
   * The behavior-declared test command, when one is known. An exact
   * match against it is authoritative and bypasses pattern matching, so
   * a repo whose suite runs via an unrecognised command still works
   * (REQ-012 feeding REQ-002).
   */
  testCommand?: string;
}

/**
 * Returns the semantic event implied by `event`, or undefined.
 *
 * Deliberately total and side-effect free so it can be unit tested
 * without a Pi session, and so the same translation is available to any
 * other harness (TRD-014 / portability).
 */
export function translateEvent(
  event: BehaviorEvent,
  options: TranslationOptions = {},
): BehaviorEvent | undefined {
  if (event.type !== "runtime.tool_call.completed") return undefined;

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const command = typeof payload.command === "string" ? payload.command : undefined;
  if (!command) return undefined;

  // Identify the command as a test run FIRST, so output sniffing is only
  // ever applied to test output. Otherwise an unrelated command whose log
  // happens to contain "1 failed" would trigger a fix.
  const declared = options.testCommand?.trim();
  const matches = (declared && command.trim() === declared) || isTestCommand(command);
  if (!matches) return undefined;

  const output = typeof payload.output === "string" ? payload.output : "";
  // Either signal is sufficient. Exit status is authoritative when present,
  // but a pipeline reports only its last command's status, so a genuinely
  // failing suite arrives with isError=false whenever the model pipes the
  // run through tail/head/grep -- observed live, and it silently disabled
  // autofix for that run.
  const failedByStatus = payload.isError === true;
  const failedByOutput = outputReportsFailure(output);
  if (!failedByStatus && !failedByOutput) return undefined;

  return normalizeEvent({
    type: "test.failure.observed",
    source: event.source,
    payload: {
      command,
      // Needed to re-run the suite where it actually failed. Verifying at
      // the repo root silently matches zero tests and "passes".
      cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
      isError: true,
      // How the failure was detected, so a run that only output-matched is
      // distinguishable from one the shell actually reported as failing.
      detectedBy: failedByStatus ? "exit-status" : "output",
      toolName: payload.toolName,
      toolCallId: payload.toolCallId,
      output: payload.output,
    },
  });
}

/**
 * Wraps a publish function so that every raw event is forwarded and any
 * implied semantic event is published immediately after it.
 */
export function withTranslation(
  publish: (event: BehaviorEvent) => void | Promise<void>,
  options: TranslationOptions = {},
): (event: BehaviorEvent) => Promise<void> {
  return async (event: BehaviorEvent) => {
    await publish(event);
    const derived = translateEvent(event, options);
    if (derived) await publish(derived);
  };
}
