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
