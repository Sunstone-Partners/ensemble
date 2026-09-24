import { randomUUID, createHash } from "node:crypto";
import { ToolDescriptor } from "../tools";
import { ToolCallRequest } from "../protocol";
import { RuntimeStampedEvent, stripRuntimeOwnedFields } from "../events";
import { DOMAIN_TOOL_EVENT_MAPPING, DomainToolName, HARNESS_EVENT_TYPES } from "./event-catalog";

export interface DomainToolAccepted {
  status: "accepted";
  event: RuntimeStampedEvent;
}

/**
 * Stamps the full runtime-owned metadata set from
 * docs/architecture/ensemble-behavior-runtime-plan.md §5 ("Event
 * metadata"). `payload` is agent-provided semantic content only — any
 * reserved field name the agent tried to smuggle in (event_id,
 * occurred_at, session_id, ...) is stripped before merging, and every
 * runtime-owned field below comes from the request/tool call context,
 * never from the agent's payload (TRD-016/AC-016-1).
 */
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
    // AC-016-2: sessionId is always request.requestedBy, the same
    // runtime-derived session identity TRD-005's grant flow already
    // uses — never a value read from the agent's tool-call args.
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
): ToolDescriptor<Record<string, unknown>, DomainToolAccepted> {
  const permitted = DOMAIN_TOOL_EVENT_MAPPING[name];

  return {
    name,
    description,
    async execute(args, request) {
      const eventType = typeof args.eventType === "string" ? args.eventType : "";
      const payload =
        args.payload && typeof args.payload === "object" ? (args.payload as Record<string, unknown>) : {};
      const evidence = Array.isArray(args.evidence) ? (args.evidence as string[]) : [];

      // AC-015-2: the wrapper, not the model, selects the permitted event
      // type — this is a closed-list membership check, not a generic
      // emitter. runtime.* is never in any tool's permitted list, so a
      // model cannot smuggle a harness-owned event through a domain tool.
      if (!permitted.includes(eventType)) {
        const isHarnessEvent = (HARNESS_EVENT_TYPES as readonly string[]).includes(eventType);
        throw new Error(
          isHarnessEvent
            ? `unauthorized: ${name} cannot emit harness-owned event type "${eventType}"`
            : `unauthorized: "${eventType}" is not in ${name}'s permitted event-type mapping`,
        );
      }

      if (evidence.length === 0) {
        throw new Error(`malformed: ${name} requires at least one evidence reference`);
      }

      const event = stampRuntimeEvent(name, eventType, { ...payload, evidence }, request);
      return { status: "accepted", event };
    },
  };
}

export const recordObservationTool = buildDomainTool(
  "ensemble.record_observation",
  "Records a validated semantic observation (behavior.observation.recorded and related informational event types).",
);

export const recordOutcomeTool = buildDomainTool(
  "ensemble.record_outcome",
  "Records a completed outcome (behavior.outcome.recorded and related terminal event types).",
);

export const proposeChangeTool = buildDomainTool(
  "ensemble.propose_change",
  "Proposes a change requiring review (change.proposed and related proposal event types).",
);

export const reportBlockedTool = buildDomainTool(
  "ensemble.report_blocked",
  "Reports or clears a blocked state (behavior.blocked/behavior.unblocked and related event types).",
);

export const requestApprovalTool = buildDomainTool(
  "ensemble.request_approval",
  "Requests approval for an artifact or transition (approval.requested and related approval event types).",
);

export const domainToolVocabulary: readonly ToolDescriptor<Record<string, unknown>, DomainToolAccepted>[] = [
  recordObservationTool,
  recordOutcomeTool,
  proposeChangeTool,
  reportBlockedTool,
  requestApprovalTool,
];
