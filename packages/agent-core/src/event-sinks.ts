import { EventEnvelope } from "./events";

/**
 * A destination for behavior events. Adapters (pi-extension, and any
 * future provider adapter) supply concrete sinks; agent-core only
 * depends on this interface.
 */
export interface EventSink {
  publish(envelope: EventEnvelope): Promise<void>;
}

/**
 * In-memory sink useful for local runs, simulation, and tests. Not a
 * durable production sink — Foreman owns durable event ingestion.
 */
export class InMemoryEventSink implements EventSink {
  private readonly received: EventEnvelope[] = [];

  async publish(envelope: EventEnvelope): Promise<void> {
    this.received.push(envelope);
  }

  drain(): EventEnvelope[] {
    return this.received.splice(0, this.received.length);
  }

  peek(): readonly EventEnvelope[] {
    return this.received;
  }
}

export class FanOutEventSink implements EventSink {
  constructor(private readonly sinks: readonly EventSink[]) {}

  async publish(envelope: EventEnvelope): Promise<void> {
    await Promise.all(this.sinks.map((sink) => sink.publish(envelope)));
  }
}
