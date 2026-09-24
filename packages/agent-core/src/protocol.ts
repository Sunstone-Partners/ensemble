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
  requestedBy: string;
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
 * docs/architecture/ensemble-behavior-runtime-plan.md §6). Versioned
 * because it is consumed outside this repository (Foreman); never add
 * a raw Pi/OMP session object to any of these types.
 */
export const INVOCATION_RESULT_SCHEMA_VERSION = "ensemble.sunstone.dev/invocation-result/v1";

export interface WorktreeSpec {
  path: string;
  branch?: string;
}

export interface InvocationToolGrant {
  toolName: string;
  grantedTo: string;
}

export interface InvocationRequest {
  executionId: string;
  prompt: string;
  context: Record<string, unknown>;
  tools: InvocationToolGrant[];
  worktree?: WorktreeSpec;
  model?: string;
  timeoutMs: number;
  attempt: number;
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
  executionId: string;
  kind: InvocationEventKind;
  occurredAt: string;
  payload: Record<string, unknown>;
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
  schemaVersion: typeof INVOCATION_RESULT_SCHEMA_VERSION;
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
    schemaVersion: INVOCATION_RESULT_SCHEMA_VERSION,
    executionId,
    status: outcome.status,
    output: outcome.output,
    usage: outcome.usage,
    toolCalls: outcome.toolCalls,
    failure: outcome.failure,
  };
}
