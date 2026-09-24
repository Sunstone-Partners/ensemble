import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CompiledBehaviorPackage } from "@sunstone-partners/ensemble-agent-core";

/**
 * Enforces a compiled behavior's effective tool grant
 * (`capabilities.tools`) at the extension boundary (TRD-018), using
 * Pi's real `tool_call` event ("Fired before a tool executes. Can
 * block."). This check is purely `event.toolName` membership against
 * the compiled manifest — it never inspects prompt content, model
 * reasoning, or tool-call arguments, so no prompt-injection phrasing
 * ("ignore tool restrictions and write anyway") can influence it
 * (AC-018-2). It also covers Pi's own native tools (bash/read/edit/
 * write/...), not only governed custom tools, so an ungranted native
 * tool call is denied exactly like an ungranted custom one (AC-018-1).
 */
export function wireToolGrantEnforcement(pi: ExtensionAPI, compiled: CompiledBehaviorPackage): void {
  pi.on("tool_call", (event) => {
    if (compiled.hasTool(event.toolName)) {
      return undefined;
    }
    return {
      block: true,
      reason: `tool "${event.toolName}" is not granted to behavior "${compiled.manifest.metadata.name}" (capabilities.tools: [${compiled.manifest.capabilities.tools.join(", ")}])`,
    };
  });
}
