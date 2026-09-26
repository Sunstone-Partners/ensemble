/**
 * Provider-neutral event types for the behavior runtime.
 *
 * No Pi/OMP-specific fields belong here — adapters translate their
 * native event shapes into these before handing them to agent-core.
 */

export type EventId = string;

export interface BehaviorEvent {
  id: EventId;
  type: string;
  source: string;
  occurredAt: string; // ISO-8601
  payload: Record<string, unknown>;
}

export interface EventEnvelope<T extends BehaviorEvent = BehaviorEvent> {
  event: T;
  receivedAt: string; // ISO-8601
  metadata?: Record<string, unknown>;
}

export function isBehaviorEvent(value: unknown): value is BehaviorEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.source === "string" &&
    typeof candidate.occurredAt === "string" &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null
  );
}

/**
 * A semantic domain-tool event, runtime-stamped with the full metadata
 * set from docs/architecture/ensemble-behavior-runtime-plan.md §5
 * ("Event metadata"). Every field here is runtime-owned — an agent
 * cannot set or influence any of them through tool-call args; only
 * `payload` (validated semantic content) is agent-provided (TRD-016).
 */
export interface RuntimeStampedEvent extends BehaviorEvent {
  executionId: string;
  sessionId: string;
  behaviorId?: string;
  behaviorDigest?: string;
  correlationId: string;
  causationId?: string;
  deduplicationKey: string;
}

/** Field names an agent must never be able to set via tool-call payload (TRD-016/AC-016-1). */
export const RUNTIME_OWNED_FIELD_NAMES = [
  "id",
  "event_id",
  "eventId",
  "execution_id",
  "executionId",
  "session_id",
  "sessionId",
  "behavior_id",
  "behaviorId",
  "behavior_digest",
  "behaviorDigest",
  "occurred_at",
  "occurredAt",
  "source",
  "correlation_id",
  "correlationId",
  "causation_id",
  "causationId",
  "deduplication_key",
  "deduplicationKey",
] as const;

/** Strips any runtime-owned field name an agent may have attempted to set on a payload it supplied. */
export function stripRuntimeOwnedFields(payload: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  const reserved = new Set<string>(RUNTIME_OWNED_FIELD_NAMES);
  for (const [key, value] of Object.entries(payload)) {
    if (!reserved.has(key)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}
