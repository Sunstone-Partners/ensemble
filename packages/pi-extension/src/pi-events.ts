import type { SessionStartEvent, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { normalizeEvent, RawEventInput } from "@sunstone-partners/ensemble-agent-core";

/**
 * Translates Pi's native lifecycle events into the provider-neutral
 * BehaviorEvent shape. This is the only place in this package that
 * knows about Pi's event field names — agent-core never sees them.
 */

export function fromSessionStart(_event: SessionStartEvent) {
  const raw: RawEventInput = { type: "session.started", source: "pi" };
  return normalizeEvent(raw);
}

export function fromSessionShutdown(_event: SessionShutdownEvent) {
  const raw: RawEventInput = { type: "session.shutdown", source: "pi" };
  return normalizeEvent(raw);
}
