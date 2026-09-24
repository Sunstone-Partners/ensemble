import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  CompiledBehaviorArtifacts,
  CompiledBehaviorPackage,
  ToolDescriptor,
  ToolRegistry,
} from "@sunstone-partners/ensemble-agent-core";
import { wireToolGrantEnforcement } from "./tool-grant-enforcement";

/**
 * Loads one compiled behavior's artifacts into a live Pi session
 * (TRD-014/AC-014-1):
 *
 * - `promptMarkdown` is exposed as a real Pi custom command
 *   (`pi.registerCommand`), whose handler sends it into the session via
 *   `pi.sendUserMessage` — the confirmed, documented way to deliver
 *   prompt content into a running session.
 * - `skillMarkdown` is exposed through the same command's `--skill`
 *   argument, returned verbatim without triggering a turn. Pi's own
 *   skill-directory auto-discovery (`.pi/agent/extensions/skills/`) is
 *   a filesystem convention, not an ExtensionAPI call, so this package
 *   does not fabricate a registration API that does not exist.
 * - governed tools (`artifacts.toolNames`, already filtered to ones
 *   with a real descriptor in `availableTools`) are registered via
 *   `pi.registerTool`, reusing the same ToolRegistry grant boundary
 *   established in TRD-005 (grant applies per session, per tool name).
 * - the compiled behavior's full `capabilities.tools` grant (including
 *   Pi's own native tools, not just governed custom ones) is enforced
 *   at the `tool_call` boundary via `wireToolGrantEnforcement`
 *   (TRD-018) — independent of `availableTools`/`artifacts.toolNames`,
 *   which only control what gets *registered*, not what Pi is allowed
 *   to *execute*.
 *
 * Reuses `packages/pi`'s existing generator output *shape* conceptually
 * (name/description/content) without importing from or modifying
 * `packages/pi` itself — this task's two target packages are
 * `agent-core` and `pi-extension` only (AC-014-2: packages/pi is
 * untouched, so its existing generated artifacts cannot regress).
 */
export function loadCompiledBehavior(
  pi: ExtensionAPI,
  compiled: CompiledBehaviorPackage,
  artifacts: CompiledBehaviorArtifacts,
  availableTools: readonly ToolDescriptor<Record<string, unknown>, unknown>[],
): void {
  wireToolGrantEnforcement(pi, compiled);

  pi.registerCommand(artifacts.commandName, {
    description: `Behavior: ${artifacts.behaviorName}`,
    async handler(args, ctx) {
      if (args.trim() === "--skill") {
        ctx.ui.setStatus?.(artifacts.commandName, artifacts.skillMarkdown);
        return;
      }
      pi.sendUserMessage(artifacts.promptMarkdown, { deliverAs: "followUp" });
    },
  });

  const registry = new ToolRegistry();
  const byName = new Map(availableTools.map((tool) => [tool.name, tool]));

  for (const toolName of artifacts.toolNames) {
    const descriptor = byName.get(toolName);
    if (!descriptor) continue;

    registry.register(descriptor);

    pi.registerTool({
      name: descriptor.name,
      label: descriptor.name,
      description: descriptor.description,
      parameters: Type.Record(Type.String(), Type.Unknown()),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        if (signal?.aborted) {
          throw new Error("cancelled");
        }
        const sessionId = ctx.sessionManager.getSessionId() ?? "pi-session";
        registry.grant({ toolName: descriptor.name, grantedTo: sessionId });
        const result = await registry.invoke({
          toolName: descriptor.name,
          args: params,
          requestedBy: sessionId,
        });
        if (result.status === "unauthorized") {
          throw new Error(`unauthorized: ${result.reason}`);
        }
        if (result.status === "error") {
          throw new Error(result.error);
        }
        return { content: [{ type: "text", text: JSON.stringify(result.result) }], details: result.result };
      },
    });
  }
}
