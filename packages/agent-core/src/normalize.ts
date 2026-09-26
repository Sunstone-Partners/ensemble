import { BehaviorEvent } from "./events";
import { HARNESS_EVENT_TYPES, SEMANTIC_EVENT_TYPES } from "./behavior/event-catalog";

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

/**
 * The closed catalog is closed at the *normalizer* boundary, not only
 * in documentation (TRD-001). Before this, `normalizeEvent` accepted
 * any string, so an adapter could mint an event type that no behavior
 * trigger could ever legitimately reference and nothing would object —
 * which made "validated against the closed catalog" vacuous for every
 * downstream consumer.
 */
const CATALOGUED_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  ...HARNESS_EVENT_TYPES,
  ...SEMANTIC_EVENT_TYPES,
]);

export function isCataloguedEventType(type: string): boolean {
  return CATALOGUED_EVENT_TYPES.has(type);
}

export function normalizeEvent(raw: RawEventInput): BehaviorEvent {
  if (!CATALOGUED_EVENT_TYPES.has(raw.type)) {
    throw new Error(
      `event type "${raw.type}" is not in the closed event catalog ` +
        `(docs/architecture/ensemble-behavior-runtime-plan.md §5). ` +
        `Add it to HARNESS_EVENT_TYPES/SEMANTIC_EVENT_TYPES deliberately, ` +
        `or emit an existing catalogued type — adapters must not invent types.`,
    );
  }
  return {
    id: raw.id ?? crypto.randomUUID(),
    type: raw.type,
    source: raw.source,
    occurredAt: raw.occurredAt ?? new Date().toISOString(),
    payload: raw.payload ?? {},
  };
}
