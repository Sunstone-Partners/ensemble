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
const TEST_COMMAND_PATTERNS: readonly RegExp[] = [
  /\bnpm\s+(run\s+)?test\b/,
  /\bnpx\s+jest\b/,
  /\bjest\b/,
  /\bvitest\b/,
  /\bpytest\b/,
  /\bgo\s+test\b/,
  /\bcargo\s+test\b/,
  /\bmix\s+test\b/,
  /\bbun\s+test\b/,
  /\bpnpm\s+(run\s+)?test\b/,
  /\byarn\s+test\b/,
];

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
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
  if (payload.isError !== true) return undefined;

  const command = typeof payload.command === "string" ? payload.command : undefined;
  if (!command) return undefined;

  const declared = options.testCommand?.trim();
  const matches = (declared && command.trim() === declared) || isTestCommand(command);
  if (!matches) return undefined;

  return normalizeEvent({
    type: "test.failure.observed",
    source: event.source,
    payload: {
      command,
      isError: true,
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
