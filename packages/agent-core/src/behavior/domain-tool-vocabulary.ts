import { normalizeEvent } from "../normalize";
import { ToolDescriptor } from "../tools";
import { BehaviorEvent } from "../events";
import { DOMAIN_TOOL_EVENT_MAPPING, DomainToolName, HARNESS_EVENT_TYPES } from "./event-catalog";

export interface DomainToolInput {
  eventType: string;
  payload: Record<string, unknown>;
  evidence: string[];
}

/**
 * Result of a typed domain tool call: an accepted, runtime-stamped
 * BehaviorEvent. The agent supplies eventType/payload/evidence only —
 * event_id, occurred_at, and source are stamped by normalizeEvent, not
 * chosen by the agent (§5 "Event metadata").
 */
export interface DomainToolAccepted {
  status: "accepted";
  event: BehaviorEvent;
}

function buildDomainTool(name: DomainToolName, description: string): ToolDescriptor<Record<string, unknown>, DomainToolAccepted> {
  const permitted = DOMAIN_TOOL_EVENT_MAPPING[name];

  return {
    name,
    description,
    async execute(args) {
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

      // Required evidence (§5: "Agent-provided fields are limited to
      // validated semantic payload, summary, evidence references, and
      // requested transition").
      if (evidence.length === 0) {
        throw new Error(`malformed: ${name} requires at least one evidence reference`);
      }

      const event = normalizeEvent({
        type: eventType,
        source: name,
        payload: { ...payload, evidence },
      });

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
