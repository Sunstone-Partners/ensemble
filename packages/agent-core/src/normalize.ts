import { BehaviorEvent } from "./events";

/**
 * Normalizes an adapter's native event shape into the provider-neutral
 * BehaviorEvent contract. Adapters call this at their boundary so
 * nothing downstream in agent-core ever sees a provider-specific
 * field name.
 */
export interface RawEventInput {
  id?: string;
  type: string;
  source: string;
  occurredAt?: string;
  payload?: Record<string, unknown>;
}

export function normalizeEvent(raw: RawEventInput): BehaviorEvent {
  return {
    id: raw.id ?? crypto.randomUUID(),
    type: raw.type,
    source: raw.source,
    occurredAt: raw.occurredAt ?? new Date().toISOString(),
    payload: raw.payload ?? {},
  };
}
