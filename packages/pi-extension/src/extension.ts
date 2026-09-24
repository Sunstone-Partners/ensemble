import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { InMemoryEventSink, echoTool } from "@sunstone-partners/ensemble-agent-core";
import { wireSessionLifecycle } from "./session";

/**
 * Capability check for AC-004-2: this extension only depends on
 * `pi.on` (lifecycle subscription), `pi.registerTool` (tool
 * registration), and per-call `AbortSignal` (cancellation), all of
 * which are present in @earendil-works/pi-coding-agent's ExtensionAPI as
 * of the pinned peer range (>=0.87.0). If a future Pi version drops
 * one of these, this function throws instead of silently degrading,
 * so the gap is documented and visible rather than papered over with
 * a fork.
 */
function assertRequiredCapabilities(pi: ExtensionAPI): void {
  if (typeof pi.registerTool !== "function") {
    throw new Error(
      "BLOCKING GAP: pi.registerTool is unavailable in this Pi version; " +
        "the behavior runtime cannot register governed tools without it. " +
        "Do not fork Pi to add it — escalate for an explicitly approved, " +
        "minimal upstreamable change instead.",
    );
  }
  if (typeof pi.on !== "function") {
    throw new Error(
      "BLOCKING GAP: pi.on (lifecycle subscription) is unavailable in this " +
        "Pi version; escalate rather than forking Pi's agent loop.",
    );
  }
}

/**
 * Extension entry point. Loaded into a live Pi session via Pi's
 * native extension mechanism (see docs/extensions.md): auto-discovered
 * from `.pi/agent/extensions/` or a project's `.pi/extensions/`, no
 * fork or patch of Pi's agent loop.
 */
const activate = (pi: ExtensionAPI): void => {
  assertRequiredCapabilities(pi);

  const sink = new InMemoryEventSink();
  wireSessionLifecycle(pi, sink);

  // Pi's own tool-authorization surface (getActiveTools/setActiveTools,
  // tool_call event blocking) is the runtime boundary a caller cannot
  // bypass with prompt text — that boundary is Pi's, not re-implemented
  // here. agent-core's ToolRegistry grant model is exercised separately
  // by callers that go through it directly (see agent-core's own tests).
  pi.registerTool({
    name: echoTool.name,
    label: "Ensemble Echo",
    description: echoTool.description,
    parameters: Type.Object({ message: Type.String({ description: "Message to echo back" }) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        throw new Error("cancelled");
      }
      const result = await echoTool.execute(
        { message: params.message ?? "" },
        {
          toolName: echoTool.name,
          args: params,
          requestedBy: ctx.sessionManager.getSessionId() ?? "pi-session",
        },
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
};

export default activate;
