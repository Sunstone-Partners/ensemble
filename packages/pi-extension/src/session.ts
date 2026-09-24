import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EventSink } from "@sunstone-partners/ensemble-agent-core";
import { fromSessionStart, fromSessionShutdown } from "./pi-events";

/**
 * Subscribes to Pi's session lifecycle via the confirmed ExtensionAPI
 * (`pi.on("session_start" | "session_shutdown", ...)`) and forwards
 * normalized events to the given sink. No Pi agent-loop fork or patch
 * is required — this uses only the documented, supported extension
 * mechanism.
 */
export function wireSessionLifecycle(pi: ExtensionAPI, sink: EventSink): void {
  pi.on("session_start", async (event) => {
    await sink.publish({ event: fromSessionStart(event), receivedAt: new Date().toISOString() });
  });

  pi.on("session_shutdown", async (event) => {
    await sink.publish({
      event: fromSessionShutdown(event),
      receivedAt: new Date().toISOString(),
    });
  });
}
