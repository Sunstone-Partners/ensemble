import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BehaviorEvent, EventSink } from "@sunstone-partners/ensemble-agent-core";
import {
  fromSessionStart,
  fromBeforeAgentStart,
  fromToolExecutionStart,
  fromToolExecutionEnd,
  fromAgentEnd,
  fromSessionShutdown,
} from "./pi-events";

/**
 * Subscribes to Pi's lifecycle via the confirmed ExtensionAPI
 * (`pi.on(...)`) and forwards normalized events to the given sink.
 * No Pi agent-loop fork or patch is required, and no Claude-style hook
 * mechanism is involved anywhere in this path (REQ-006/AC-006-2):
 * capture works whether or not any hook configuration exists, because
 * it is wired entirely through Pi's own native extension events.
 */
export function wireSessionLifecycle(pi: ExtensionAPI, sink: EventSink): void {
  const publish = (event: BehaviorEvent) => {
    void sink.publish({ event, receivedAt: new Date().toISOString() });
  };

  pi.on("session_start", async (event) => publish(fromSessionStart(event)));
  pi.on("before_agent_start", async (event) => publish(fromBeforeAgentStart(event)));
  pi.on("tool_execution_start", async (event) => publish(fromToolExecutionStart(event)));
  pi.on("tool_execution_end", async (event) => publish(fromToolExecutionEnd(event)));
  pi.on("agent_end", async (event) => publish(fromAgentEnd(event)));
  pi.on("session_shutdown", async (event) => publish(fromSessionShutdown(event)));
}
