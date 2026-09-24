import type {
  SessionStartEvent,
  SessionShutdownEvent,
  BeforeAgentStartEvent,
  AgentEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionEndEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { normalizeEvent } from "@sunstone-partners/ensemble-agent-core";

/**
 * Native Pi tool names (as opposed to a governed custom tool registered
 * via `pi.registerTool`). Anything outside this set on a ToolCallEvent/
 * ToolResultEvent is a custom tool call (REQ-007/AC-007-2).
 */
const NATIVE_PI_TOOL_NAMES = new Set([
  "bash",
  "powershell",
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

/**
 * Translates Pi's native lifecycle events into the provider-neutral
 * BehaviorEvent shape. This is the only place in this package that
 * knows about Pi's event field names — agent-core never sees them.
 *
 * These are Pi's own native extension-event subscriptions (`pi.on`),
 * entirely independent of any Claude-style hook mechanism (REQ-006):
 * there is no Claude hook configuration involved anywhere in this path.
 */

export function fromSessionStart(_event: SessionStartEvent) {
  return normalizeEvent({ type: "runtime.session.started", source: "pi" });
}

export function fromBeforeAgentStart(event: BeforeAgentStartEvent) {
  return normalizeEvent({
    type: "runtime.prompt.submitted",
    source: "pi",
    payload: { prompt: event.prompt },
  });
}

export function fromToolExecutionStart(event: ToolExecutionStartEvent) {
  return normalizeEvent({
    type: "runtime.tool_call.started",
    source: "pi",
    payload: { toolCallId: event.toolCallId, toolName: event.toolName },
  });
}

export function fromToolExecutionEnd(event: ToolExecutionEndEvent) {
  // Previously emitted "runtime.tool.failed"/"runtime.tool.completed",
  // neither of which exists in HARNESS_EVENT_TYPES. The pass/fail
  // signal now rides on the payload instead of on an uncatalogued
  // type name (TRD-001).
  return normalizeEvent({
    type: "runtime.tool_call.completed",
    source: "pi",
    payload: {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      custom: !NATIVE_PI_TOOL_NAMES.has(event.toolName),
      isError: event.isError === true,
    },
  });
}

export function fromAgentEnd(_event: AgentEndEvent) {
  // Pi's subscribable events do not expose a distinct
  // completed/aborted/error outcome on agent_end itself (that
  // granularity lives on agent_before_settle/agent_settled, which are
  // not `pi.on`-subscribable). AC-006-1 only requires observing at
  // least a completed-or-failed event; refine to a real failed/aborted
  // split if Pi exposes that via a subscribable event in a later version.
  return normalizeEvent({ type: "runtime.session.completed", source: "pi" });
}

export function fromSessionShutdown(_event: SessionShutdownEvent) {
  return normalizeEvent({ type: "runtime.process.exited", source: "pi" });
}

export function fromToolCall(event: ToolCallEvent) {
  const custom = !NATIVE_PI_TOOL_NAMES.has(event.toolName);
  return normalizeEvent({
    type: "runtime.tool_call.started",
    source: "pi",
    payload: { toolCallId: event.toolCallId, toolName: event.toolName, custom },
  });
}

/**
 * Extracts the shell command from a bash tool result.
 *
 * Pi has no numeric exit code anywhere in its event surface -- only a
 * boolean `isError` -- so the command text plus that flag is the whole
 * of the failure signal available to a behavior predicate (REQ-001).
 */
function bashCommandOf(event: ToolResultEvent): string | undefined {
  // Structural check rather than Pi's isBashToolResult type guard: the
  // guard is a runtime export, and importing a value from
  // @earendil-works/pi-coding-agent turns this module's type-only
  // dependency into a real require that is not resolvable in every
  // consumer (it broke three test suites). Types stay import type.
  const command = (event.input as Record<string, unknown> | undefined)?.command;
  return typeof command === "string" ? command : undefined;
}

/** Concatenates the textual parts of a tool result, ignoring images. */
function outputTextOf(event: ToolResultEvent): string {
  return (event.content ?? [])
    .filter((part): part is { type: "text"; text: string } => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function fromToolResult(event: ToolResultEvent) {
  const custom = !NATIVE_PI_TOOL_NAMES.has(event.toolName);
  // `isError` is carried here and on fromToolExecutionEnd so that both
  // emitters of runtime.tool_call.completed agree on the failure field;
  // a predicate must not have to know which Pi event produced the
  // envelope. `command`/`output` are additionally present here because
  // only tool_result exposes the tool's input and content (REQ-001).
  return normalizeEvent({
    type: "runtime.tool_call.completed",
    source: "pi",
    payload: {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      custom,
      isError: event.isError === true,
      command: bashCommandOf(event),
      output: outputTextOf(event),
    },
  });
}
