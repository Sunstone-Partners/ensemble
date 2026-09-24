import { randomUUID, createHash } from "node:crypto";
import { ToolDescriptor } from "../tools";
import { ToolCallRequest } from "../protocol";
import { RuntimeStampedEvent, stripRuntimeOwnedFields } from "../events";
import { DOMAIN_TOOL_EVENT_MAPPING, DomainToolName, HARNESS_EVENT_TYPES } from "./event-catalog";
import { InMemoryLocalOutboxSink, LocalOutboxSink } from "./outbox";

/**
 * Distinguished tool-result statuses (architecture doc §5 "Tool
 * results must distinguish"). A successful local acceptance must never
 * be represented as durable Foreman acceptance (TRD-017/AC-017-1) —
 * this local-only implementation never produces "accepted_by_foreman"
 * or "queued_for_forwarding"; those are reserved for a future
 * Foreman-connected mode, out of this TRD's scope.
 */
export type DomainToolCallStatus =
  | "accepted_locally"
  | "accepted_by_foreman"
  | "queued_for_forwarding"
  | "rejected"
  | "malformed"
  | "unauthorized";

export interface DomainToolCallResult {
  status: DomainToolCallStatus;
  event?: RuntimeStampedEvent;
  reason?: string;
}

function stampRuntimeEvent(
  toolName: DomainToolName,
  eventType: string,
  rawPayload: Record<string, unknown>,
  request: ToolCallRequest,
): RuntimeStampedEvent {
  const payload = stripRuntimeOwnedFields(rawPayload);
  const executionId = request.executionId ?? randomUUID();
  const occurredAt = new Date().toISOString();
  const deduplicationKey = createHash("sha256")
    .update(`${executionId}:${eventType}:${JSON.stringify(payload)}`)
    .digest("hex");

  return {
    id: randomUUID(),
    type: eventType,
    source: toolName,
    occurredAt,
    payload,
    executionId,
    sessionId: request.requestedBy,
    behaviorId: request.behaviorId,
    behaviorDigest: request.behaviorDigest,
    correlationId: executionId,
    causationId: request.causationId,
    deduplicationKey,
  };
}

function buildDomainTool(
  name: DomainToolName,
  description: string,
  outbox: LocalOutboxSink,
): ToolDescriptor<Record<string, unknown>, DomainToolCallResult> {
  const permitted = DOMAIN_TOOL_EVENT_MAPPING[name];

  return {
    name,
    description,
    async execute(args, request): Promise<DomainToolCallResult> {
      const eventType = typeof args.eventType === "string" ? args.eventType : "";
      const payload =
        args.payload && typeof args.payload === "object" ? (args.payload as Record<string, unknown>) : {};
      const evidence = Array.isArray(args.evidence) ? (args.evidence as string[]) : [];

      // AC-015-2: the wrapper, not the model, selects the permitted event
      // type. runtime.* is never in any tool's permitted list, so a model
      // cannot smuggle a harness-owned event through a domain tool.
      if (!permitted.includes(eventType)) {
        const isHarnessEvent = (HARNESS_EVENT_TYPES as readonly string[]).includes(eventType);
        return {
          status: "unauthorized",
          reason: isHarnessEvent
            ? `${name} cannot emit harness-owned event type "${eventType}"`
            : `"${eventType}" is not in ${name}'s permitted event-type mapping`,
        };
      }

      if (evidence.length === 0) {
        return { status: "malformed", reason: `${name} requires at least one evidence reference` };
      }

      const event = stampRuntimeEvent(name, eventType, { ...payload, evidence }, request);

      // TRD-017: append to the local outbox BEFORE acknowledging
      // acceptance. A write failure is a rejection, never a false
      // "accepted_locally" claim (AC-017-2).
      try {
        await outbox.append(event);
      } catch (error) {
        return {
          status: "rejected",
          reason: `local outbox write failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      return { status: "accepted_locally", event };
    },
  };
}

/**
 * Builds one fresh set of the five typed domain tools bound to the
 * given local outbox. Real adapters (pi-extension) should call this
 * with a durable FileLocalOutboxSink per session/behavior rather than
 * sharing the module-level default singletons below.
 */
export function createDomainToolVocabulary(
  outbox: LocalOutboxSink,
): readonly ToolDescriptor<Record<string, unknown>, DomainToolCallResult>[] {
  return [
    buildDomainTool(
      "ensemble.record_observation",
      "Records a validated semantic observation (behavior.observation.recorded and related informational event types).",
      outbox,
    ),
    buildDomainTool(
      "ensemble.record_outcome",
      "Records a completed outcome (behavior.outcome.recorded and related terminal event types).",
      outbox,
    ),
    buildDomainTool(
      "ensemble.propose_change",
      "Proposes a change requiring review (change.proposed and related proposal event types).",
      outbox,
    ),
    buildDomainTool(
      "ensemble.report_blocked",
      "Reports or clears a blocked state (behavior.blocked/behavior.unblocked and related event types).",
      outbox,
    ),
    buildDomainTool(
      "ensemble.request_approval",
      "Requests approval for an artifact or transition (approval.requested and related approval event types).",
      outbox,
    ),
  ];
}

/** Default in-memory outbox backing the module-level singleton tools below (demo/test convenience). */
export const defaultLocalOutbox = new InMemoryLocalOutboxSink();

const [
  recordObservationTool,
  recordOutcomeTool,
  proposeChangeTool,
  reportBlockedTool,
  requestApprovalTool,
] = createDomainToolVocabulary(defaultLocalOutbox);

export {
  recordObservationTool,
  recordOutcomeTool,
  proposeChangeTool,
  reportBlockedTool,
  requestApprovalTool,
};

export const domainToolVocabulary: readonly ToolDescriptor<Record<string, unknown>, DomainToolCallResult>[] = [
  recordObservationTool,
  recordOutcomeTool,
  proposeChangeTool,
  reportBlockedTool,
  requestApprovalTool,
];
