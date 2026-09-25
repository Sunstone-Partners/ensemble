import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CompiledBehaviorPackage } from "@sunstone-partners/ensemble-agent-core";

/**
 * Enforces the *union* of all loaded behaviors' effective tool grants
 * (`capabilities.tools`) at the extension boundary (TRD-018), using
 * Pi's real `tool_call` event ("Fired before a tool executes. Can
 * block."). This check is purely `event.toolName` membership against
 * the compiled manifests — it never inspects prompt content, model
 * reasoning, or tool-call arguments, so no prompt-injection phrasing
 * ("ignore tool restrictions and write anyway") can influence it
 * (AC-018-2). It also covers Pi's own native tools (bash/read/edit/
 * write/...), not only governed custom tools, so an ungranted native
 * tool call is denied exactly like an ungranted custom one (AC-018-1).
 *
 * WHY UNION, NOT PER-BEHAVIOR:
 *
 * Pi's `emitToolCall` runs every registered `tool_call` handler in
 * registration order and returns on the *first* one that answers
 * `{ block: true }`. So registering one handler per behavior makes the
 * session's effective permission the *intersection* of all loaded
 * behaviors: a behavior that grants `bash` cannot use `bash` if some
 * unrelated behavior loaded earlier does not grant it. Observed live —
 * `fix-failing-test` granted [read, grep, glob, bash, edit, write] and
 * was still blocked from `bash` by `investigate-test-failure`. Adding a
 * restrictive behavior silently disabled a permissive one.
 *
 * Per-behavior scoping is the architecturally correct answer but is not
 * currently implementable: `ToolCallEvent` carries only
 * `{ type, toolName, toolCallId, input }` — there is no `invocationId`
 * or active-behavior marker anywhere in the extension API correlating a
 * tool call to a behavior. Nor is there a fact to correlate: tool calls
 * originate from the model's own turn, not from a dispatched behavior.
 * Tracked separately; see the behavior-scoped-grants bead.
 *
 * Union is therefore the honest reading of what this architecture can
 * enforce — session-wide capability — and it composes: loading a
 * behavior can only ever *widen* the grant, never silently narrow
 * another behavior's.
 */
const SESSION_GRANTS = new WeakMap<object, Set<CompiledBehaviorPackage>>();

export function wireToolGrantEnforcement(pi: ExtensionAPI, compiled: CompiledBehaviorPackage): void {
  const existing = SESSION_GRANTS.get(pi);
  if (existing) {
    // Handler already registered for this session; widen the grant.
    existing.add(compiled);
    return;
  }

  const behaviors = new Set<CompiledBehaviorPackage>([compiled]);
  SESSION_GRANTS.set(pi, behaviors);

  pi.on("tool_call", (event) => {
    for (const behavior of behaviors) {
      if (behavior.hasTool(event.toolName)) {
        return undefined;
      }
    }
    const granted = new Set<string>();
    const names: string[] = [];
    for (const behavior of behaviors) {
      names.push(behavior.manifest.metadata.name);
      for (const tool of behavior.manifest.capabilities.tools) {
        granted.add(tool);
      }
    }
    return {
      block: true,
      reason: `tool "${event.toolName}" is not granted to any loaded behavior [${names.join(", ")}] (granted tools: [${[...granted].sort().join(", ")}])`,
    };
  });
}
