import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CompiledBehaviorPackage } from "@sunstone-partners/ensemble-agent-core";

/**
 * Enforces a behavior's declared tool grants (`capabilities.tools`) while
 * that behavior is executing, using Pi's real `tool_call` event ("Fired
 * before a tool executes. Can block."). The check is purely
 * `event.toolName` membership against the compiled manifests — it never
 * inspects prompt content, model reasoning, or tool-call arguments, so no
 * prompt-injection phrasing ("ignore tool restrictions and write anyway")
 * can influence it (AC-018-2). It covers Pi's own native tools
 * (bash/read/edit/write/...), not only governed custom tools, so an
 * ungranted native tool call is denied exactly like an ungranted custom
 * one (AC-018-1).
 *
 * SCOPE: A BEHAVIOR, NOT THE SESSION.
 *
 * Grants previously applied session-wide as the union across every loaded
 * behavior. That was wrong, and it broke this repo: shipping the single
 * read-only `investigate-test-failure` behavior (read/grep/glob/
 * ensemble.bash) removed `bash` from the session, so the agent could not
 * run the test suite at all -- no failure was observed, nothing dispatched,
 * and autofix could not detect a failure it was not permitted to produce.
 * Observed live in a clean worktree (br-uavb).
 *
 * A grant declares what a BEHAVIOR may do. It is not a policy knob for the
 * human's session, and installing a narrow analysis behavior must not
 * silently take away the user's shell. Session-wide union also made grants
 * non-composable in the other direction: a permissive behavior widened
 * capability for everything else in the session.
 *
 * HOW SCOPING IS ACHIEVED WITHOUT PER-CALL ATTRIBUTION:
 *
 * `ToolCallEvent` carries only `{ type, toolName, toolCallId, input }`.
 * There is no `invocationId` or behavior marker, and no fact to correlate:
 * tool calls originate from the model's turn, not from a dispatched
 * behavior. So per-CALL attribution remains impossible.
 *
 * What is available is a TEMPORAL boundary. A behavior's work happens in a
 * continuation turn that this extension itself queues, so the caller marks
 * that window with beginBehaviorScope()/endBehaviorScope(). Inside it,
 * only the named behaviors' grants apply. Outside it, no behavior is
 * executing and the user's own tools are untouched.
 *
 * Known limitation, deliberately accepted: the window is a turn, not a
 * call. In an interactive session a user interjection landing inside a
 * behavior turn runs under that behavior's grants. Coarser than per-call,
 * strictly better than session-wide.
 */
const SESSION_GRANTS = new WeakMap<object, Set<CompiledBehaviorPackage>>();
const ACTIVE_SCOPE = new WeakMap<object, string[]>();

/**
 * Marks the start of a behavior's execution window. Only the named
 * behaviors' grants are enforced until endBehaviorScope().
 */
export function beginBehaviorScope(pi: ExtensionAPI, behaviorNames: readonly string[]): void {
  ACTIVE_SCOPE.set(pi, [...behaviorNames]);
}

/**
 * Ends the execution window. MUST be idempotent and MUST be called even
 * when the behavior turn failed: leaving a scope open would strand the
 * user in a narrowed session, which is the defect this change exists to
 * remove, merely made transient and harder to spot.
 */
export function endBehaviorScope(pi: ExtensionAPI): void {
  ACTIVE_SCOPE.delete(pi);
}

/** Behaviors currently executing, for status and tests. */
export function activeBehaviorScope(pi: ExtensionAPI): readonly string[] | undefined {
  return ACTIVE_SCOPE.get(pi);
}

export function wireToolGrantEnforcement(pi: ExtensionAPI, compiled: CompiledBehaviorPackage): void {
  const existing = SESSION_GRANTS.get(pi);
  if (existing) {
    // Handler already registered for this session; register the behavior.
    // One handler per session, because Pi's emitToolCall returns on the
    // FIRST handler answering { block: true } -- one handler per behavior
    // would make the effective permission an intersection.
    existing.add(compiled);
    return;
  }

  const behaviors = new Set<CompiledBehaviorPackage>([compiled]);
  SESSION_GRANTS.set(pi, behaviors);

  pi.on("tool_call", (event) => {
    const scope = ACTIVE_SCOPE.get(pi);
    // No behavior executing: this is the user's own turn. Their tools are
    // none of a behavior's business.
    if (!scope || scope.length === 0) return undefined;

    const scoped = [...behaviors].filter((b) => scope.includes(b.manifest.metadata.name));
    // A scope naming behaviors we have no manifest for must not silently
    // allow everything: fail closed by blocking, since an executing
    // behavior whose grants cannot be resolved is not a safe state.
    for (const behavior of scoped) {
      if (behavior.hasTool(event.toolName)) return undefined;
    }

    const granted = new Set<string>();
    for (const behavior of scoped) {
      for (const tool of behavior.manifest.capabilities.tools) granted.add(tool);
    }
    return {
      block: true,
      reason: `tool "${event.toolName}" is not granted to executing behavior(s) [${scope.join(", ")}] (granted tools: [${[...granted].sort().join(", ")}])`,
    };
  });
}
