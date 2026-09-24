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
