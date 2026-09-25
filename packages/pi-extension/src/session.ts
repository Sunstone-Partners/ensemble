import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BehaviorEvent, EventSink, withTranslation } from "@sunstone-partners/ensemble-agent-core";
import {
  fromSessionStart,
  fromBeforeAgentStart,
  fromToolExecutionStart,
  fromToolExecutionEnd,
  fromAgentEnd,
  fromSessionShutdown,
  fromToolCall,
  fromToolResult,
} from "./pi-events";

/**
 * Subscribes to Pi's lifecycle via the confirmed ExtensionAPI
 * (`pi.on(...)`) and forwards normalized events to the given sink.
 * No Pi agent-loop fork or patch is required, and no Claude-style hook
 * mechanism is involved anywhere in this path (REQ-006/AC-006-2):
 * capture works whether or not any hook configuration exists, because
 * it is wired entirely through Pi's own native extension events.
 *
 * tool_call/tool_result (REQ-007) fire around every tool invocation —
 * both governed custom tools and Pi's own native tools (bash/read/etc)
 * — with a shared `toolCallId` correlating the pair, and are
 * distinguished custom-vs-native in pi-events.ts.
 */
export function wireSessionLifecycle(
  pi: ExtensionAPI,
  sink: EventSink,
  options: { testCommand?: string } = {},
): void {
  // Returns the sink's promise rather than voiding it. `void` here
  // made publication fire-and-forget: withTranslation awaited emit,
  // got undefined, and returned before the matcher had invoked
  // anything, so a behavior's work -- and any error it raised -- was
  // unobservable and raced the rest of the session.
  const emit = (event: BehaviorEvent): Promise<void> =>
    sink.publish({ event, receivedAt: new Date().toISOString() });

  // Every raw event is forwarded, and any semantic event it implies is
  // published straight after it. Without this the runtime emits only
  // runtime.* events and a behavior triggering on test.failure.observed
  // can never fire in production, however correct its manifest is
  // (TRD-012 / REQ-002).
  const publish = withTranslation(emit, { testCommand: options.testCommand });

  pi.on("session_start", async (event) => publish(fromSessionStart(event)));
  pi.on("before_agent_start", async (event) => publish(fromBeforeAgentStart(event)));
  pi.on("tool_execution_start", async (event) => publish(fromToolExecutionStart(event)));
  pi.on("tool_execution_end", async (event) => publish(fromToolExecutionEnd(event)));
  pi.on("tool_call", async (event) => publish(fromToolCall(event)));
  pi.on("tool_result", async (event) => publish(fromToolResult(event)));
  pi.on("agent_end", async (event) => publish(fromAgentEnd(event)));
  pi.on("session_shutdown", async (event) => publish(fromSessionShutdown(event)));
}
