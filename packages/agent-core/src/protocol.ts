import { BehaviorEvent } from "./events";

/**
 * Provider-neutral wire contract between a behavior definition and
 * whatever adapter is hosting it (pi-extension today; a future
 * omp-adapter later). Adapters translate their native turn/tool-call
 * shapes into these types.
 */

export interface ToolCallRequest {
  toolName: string;
  args: Record<string, unknown>;
  /** Runtime-derived session identity — never agent-chosen (TRD-016). */
  requestedBy: string;
  /** Runtime-derived per-invocation execution id (TRD-016/AC-016-2). */
  executionId?: string;
  behaviorId?: string;
  behaviorDigest?: string;
  causationId?: string;
}

export type ToolCallResult =
  | { status: "ok"; result: unknown }
  | { status: "error"; error: string }
  | { status: "unauthorized"; reason: string };

export interface BehaviorTurnContext {
  triggeringEvent: BehaviorEvent;
  sessionId: string;
}

export interface BehaviorProtocolAdapter {
  callTool(request: ToolCallRequest): Promise<ToolCallResult>;
  emitEvent(event: BehaviorEvent): Promise<void>;
}

/**
 * Cross-repository provider-neutral invocation contract (source:
 * docs/architecture/ensemble-behavior-runtime-plan.md §6). Versioned as
 * one contract because InvocationRequest/InvocationEvent/InvocationResult
 * are consumed together outside this repository (Foreman); never add a
 * raw Pi/OMP session object to any of these types.
 *
 * AC-010-2: bump this string on any breaking change to the three types
 * below. assertInvocationContractVersion() makes an out-of-date consumer
 * fail loudly (throw) instead of silently misreading renamed/removed
 * fields.
 */
export const INVOCATION_CONTRACT_SCHEMA_VERSION = "ensemble.sunstone.dev/invocation-contract/v1";

export function assertInvocationContractVersion(value: {
  schemaVersion: string;
}): asserts value is { schemaVersion: typeof INVOCATION_CONTRACT_SCHEMA_VERSION } {
  if (value.schemaVersion !== INVOCATION_CONTRACT_SCHEMA_VERSION) {
    throw new Error(
      `Invocation contract version mismatch: got "${value.schemaVersion}", ` +
        `expected "${INVOCATION_CONTRACT_SCHEMA_VERSION}". Refusing to interpret ` +
        `fields from an incompatible schema version.`,
    );
  }
}

export interface WorktreeSpec {
  path: string;
  branch?: string;
}

export interface InvocationToolGrant {
  toolName: string;
  grantedTo: string;
}

export interface InvocationRequest {
  schemaVersion: typeof INVOCATION_CONTRACT_SCHEMA_VERSION;
  executionId: string;
  prompt: string;
  context: Record<string, unknown>;
  tools: InvocationToolGrant[];
  worktree?: WorktreeSpec;
  model?: string;
  timeoutMs: number;
  attempt: number;
}

export function toInvocationRequest(
  request: Omit<InvocationRequest, "schemaVersion">,
): InvocationRequest {
  return { schemaVersion: INVOCATION_CONTRACT_SCHEMA_VERSION, ...request };
}

export type InvocationEventKind =
  | "started"
  | "progress"
  | "tool_call"
  | "tool_result"
  | "message"
  | "failed"
  | "completed";

export interface InvocationEvent {
  schemaVersion: typeof INVOCATION_CONTRACT_SCHEMA_VERSION;
  executionId: string;
  kind: InvocationEventKind;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export function toInvocationEvent(event: Omit<InvocationEvent, "schemaVersion">): InvocationEvent {
  return { schemaVersion: INVOCATION_CONTRACT_SCHEMA_VERSION, ...event };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  custom: boolean;
  isError: boolean;
}

/** AC-008-2: every failed invocation carries one of these, never a raw provider error object. */
export interface NormalizedFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export type InvocationStatus = "completed" | "failed" | "timeout" | "cancelled";

export interface InvocationResult {
  schemaVersion: typeof INVOCATION_CONTRACT_SCHEMA_VERSION;
  executionId: string;
  status: InvocationStatus;
  output: string;
  usage?: Usage;
  toolCalls: ToolCallRecord[];
  failure?: NormalizedFailure;
}

export interface InvocationOutcome {
  status: InvocationStatus;
  output: string;
  usage?: Usage;
  toolCalls: ToolCallRecord[];
  failure?: NormalizedFailure;
}

/**
 * Builds a schema-conformant InvocationResult from a plain-data outcome.
 * `outcome` MUST already be normalized (no adapter-native objects) — this
 * function only stamps the executionId and schema version, it does not
 * translate provider-native shapes; that translation is the adapter's job
 * (see pi-extension for the Pi-specific translation).
 */
export function toInvocationResult(executionId: string, outcome: InvocationOutcome): InvocationResult {
  if (outcome.status === "failed" && !outcome.failure) {
    throw new Error("AC-008-2 violation: a failed InvocationOutcome must include a NormalizedFailure");
  }

  return {
    schemaVersion: INVOCATION_CONTRACT_SCHEMA_VERSION,
    executionId,
    status: outcome.status,
    output: outcome.output,
    usage: outcome.usage,
    toolCalls: outcome.toolCalls,
    failure: outcome.failure,
  };
}
