import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ToolRegistry, InMemoryEventSink, echoTool, EventSink, ApprovalGate, ApprovalHost } from "@sunstone-partners/ensemble-agent-core";
import { wireSessionLifecycle } from "./session";
import { handleEchoToolCall } from "./echo-tool-handler";
import { activateBehaviorPipeline, resolveRepoRoot, BehaviorActivationResult } from "./behavior-activation";
import { createBehaviorInvoker, FixProvider, ConstitutionProvider, BehaviorRunRecord } from "./behavior-runner";
import { ConstitutionChange, PullRequestRef } from "./constitution-proposal";
import { SuiteResult } from "./autofix-loop";
import { logRuntime } from "./runtime-log";

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
 * Builds one extension activation instance with its own event sink,
 * exposed for scripted end-to-end proofs (TRD-009) and tests. Pi itself
 * only ever calls the default-exported `activate` below, which is a
 * single instance's `activate` function — Pi loads this module once per
 * extension activation, so binding one instance here is exactly the
 * production shape, not a test-only shortcut.
 */
export interface ActivateOptions {
  /**
   * Supplies candidate fixes. Omitted in a plain session: fabricating
   * a fix without a model would be worse than doing nothing, so the
   * default records the failure and stops rather than pretending.
   */
  proposeFix?: FixProvider;
  /** Supplies constitution changes implied by an investigation. */
  proposeConstitutionChange?: ConstitutionProvider;
  /**
   * Approval host. Absent means no UI, and ApprovalGate fails closed,
   * so a constitution change is declined rather than auto-applied.
   */
  approvalHost?: ApprovalHost;
  openPullRequest?: (change: ConstitutionChange) => PullRequestRef | Promise<PullRequestRef>;
  runSuite?: (command: string, signal: AbortSignal) => SuiteResult | Promise<SuiteResult>;
}

export function createActivate(options: ActivateOptions = {}): {
  activate: (pi: ExtensionAPI) => void;
  sink: InMemoryEventSink;
  lastActivation: () => BehaviorActivationResult | null;
  runRecords: BehaviorRunRecord[];
} {
  const runRecords: BehaviorRunRecord[] = [];
  const sink = new InMemoryEventSink();
  let lastActivation: BehaviorActivationResult | null = null;

  const activate = (pi: ExtensionAPI): void => {
    assertRequiredCapabilities(pi);

    // Every published event is forwarded to the sink and then offered
    // to the matcher, so a matching event actually invokes its behavior
    // in a real session (TRD-015 / REQ-003). Without this the matcher
    // is built during activation and never sees a live event --
    // dispatch only a test could trigger.
    //
    // The matcher is resolved at publish time, not captured here:
    // wireSessionLifecycle runs before activateBehaviorPipeline has
    // produced one, so binding eagerly would capture null forever.
    const dispatchingSink: EventSink = {
      async publish(envelope) {
        await sink.publish(envelope);
        logRuntime(resolveRepoRoot(process.cwd()), {
          kind: "event",
          type: envelope.event.type,
          payload: envelope.event.payload,
        });
        const matcher = lastActivation?.matcher;
        if (!matcher) return;
        try {
          const invoked = await matcher.onEvent(envelope.event);
          if (invoked && invoked.length > 0) {
            logRuntime(resolveRepoRoot(process.cwd()), {
              kind: "dispatch",
              type: envelope.event.type,
              invoked,
            });
          }
        } catch (error) {
          // A behavior invocation must never break the event pipeline.
          lastActivation?.invocationErrors.push({
            behavior: "(dispatch)",
            reason: (error as Error).message,
          });
        }
      },
    };

    wireSessionLifecycle(pi, dispatchingSink);

    // agent-core's ToolRegistry is the enforced grant-denial boundary
    // (AC-005-2: "prompt text cannot bypass this"). The grant source
    // here is a registered CLI flag (`--ensemble-tool-grant`), set only
    // at Pi startup outside the LLM's control — not something the
    // agent's own tool-call arguments or prompt content can flip at
    // call time. Default is false (ungranted), so the deny path is
    // genuinely reachable, not an always-true rubber stamp.
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

    // TRD-005/AC-009-1: discover, compile and load this repo's
    // behavior packages from the real production activate(). Until
    // this call existed, the entire behavior pipeline — including the
    // manifest-driven native-tool grant enforcement wired inside
    // loadCompiledBehavior — was reachable only from tests.
    //
    // The invoker is what makes dispatch real. Passing none left
    // LocalEventMatcher defaulting to `() => undefined`, so a matched
    // event ran a stub and every downstream guarantee was
    // test-only reachable.
    const invoker = createBehaviorInvoker({
      rootDir: resolveRepoRoot(process.cwd()),
      compiled: () => lastActivation?.compiled ?? [],
      proposeFix: options.proposeFix,
      proposeConstitutionChange: options.proposeConstitutionChange,
      approval: options.approvalHost ? new ApprovalGate(options.approvalHost) : undefined,
      openPullRequest: options.openPullRequest,
      runSuite: options.runSuite,
      records: runRecords,
      onRecord: (r) => logRuntime(resolveRepoRoot(process.cwd()), { kind: "invocation", record: r }),
    });

    lastActivation = activateBehaviorPipeline(
      pi,
      resolveRepoRoot(process.cwd()),
      [echoTool],
      undefined,
      invoker,
    );

    logRuntime(resolveRepoRoot(process.cwd()), {
      kind: "activation",
      discovered: lastActivation.discovered,
      loaded: lastActivation.loaded,
      skipped: lastActivation.skipped,
      hasFixProvider: Boolean(options.proposeFix),
      hasApprovalHost: Boolean(options.approvalHost),
    });
  };

  return { activate, sink, lastActivation: () => lastActivation, runRecords };
}

const activate: (pi: ExtensionAPI) => void = createActivate().activate;

export default activate;
