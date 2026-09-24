import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ToolRegistry, InMemoryEventSink, echoTool } from "@sunstone-partners/ensemble-agent-core";
import { wireSessionLifecycle } from "./session";
import { handleEchoToolCall } from "./echo-tool-handler";

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

  // agent-core's ToolRegistry is the enforced grant-denial boundary
  // (AC-005-2: "prompt text cannot bypass this"). The grant source here
  // is a registered CLI flag (`--ensemble-tool-grant`), set only at Pi
  // startup outside the LLM's control — not something the agent's own
  // tool-call arguments or prompt content can flip at call time. Default
  // is false (ungranted), so the deny path is genuinely reachable, not
  // an always-true rubber stamp.
  pi.registerFlag("ensemble-tool-grant", {
    description: "Grant the ensemble-managed governed tools for this session",
    type: "boolean",
    default: false,
  });

  const registry = new ToolRegistry();
  registry.register(echoTool);

  pi.registerTool({
    name: echoTool.name,
    label: "Ensemble Echo",
    description: echoTool.description,
    parameters: Type.Object({ message: Type.String({ description: "Message to echo back" }) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        throw new Error("cancelled");
      }
      const sessionId = ctx.sessionManager.getSessionId() ?? "pi-session";
      const granted = pi.getFlag("ensemble-tool-grant") === true;
      return handleEchoToolCall(registry, sessionId, granted, params.message ?? "");
    },
  });
};

export default activate;
