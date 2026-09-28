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

/**
 * The directory the observed command actually ran in, when the event says so.
 *
 * br-x36p: the governed dispatch resolved its root from the EXTENSION HOST's
 * process.cwd(), so a failure observed in one worktree sent the fix provider,
 * the rule provider and the constitution applier at a different repository --
 * observed live, with fix-agent children writing into the maintainer's main
 * checkout while the failing command had run in /private/tmp/wt-autofix-fix.
 *
 * Returns undefined rather than a default so each caller states its own
 * fallback explicitly. A silent default here would reintroduce exactly the
 * bug: a wrong root that looks like a working one.
 */
export function eventCwd(event: BehaviorEvent | undefined): string | undefined {
  // Tolerates a missing event on purpose. Callers reach this from provider
  // entry points whose invocation is assembled by adapters and, in tests, by
  // fixtures -- and the nearest catch turns a TypeError here into "no
  // candidate offered", which reads as a considered decision rather than a
  // crash. Answering "no cwd" is the honest degraded result.
  const cwd = event?.payload?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
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
