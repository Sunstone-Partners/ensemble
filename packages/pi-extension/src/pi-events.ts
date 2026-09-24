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
import { normalizeEvent, RawEventInput } from "@sunstone-partners/ensemble-agent-core";

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
    type: "runtime.tool.called",
    source: "pi",
    payload: { toolCallId: event.toolCallId, toolName: event.toolName },
  });
}

export function fromToolExecutionEnd(event: ToolExecutionEndEvent) {
  return normalizeEvent({
    type: event.isError ? "runtime.tool.failed" : "runtime.tool.completed",
    source: "pi",
    payload: { toolCallId: event.toolCallId, toolName: event.toolName },
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
    type: "runtime.tool_call",
    source: "pi",
    payload: { toolCallId: event.toolCallId, toolName: event.toolName, custom },
  });
}

export function fromToolResult(event: ToolResultEvent) {
  const custom = !NATIVE_PI_TOOL_NAMES.has(event.toolName);
  return normalizeEvent({
    type: "runtime.tool_result",
    source: "pi",
    payload: { toolCallId: event.toolCallId, toolName: event.toolName, custom },
  });
}
