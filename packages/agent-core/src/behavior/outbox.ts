import { appendFile } from "node:fs/promises";
import { RuntimeStampedEvent } from "../events";

/**
 * Local outbox/evidence sink (source: architecture doc §5 "Event
 * sinks"). A delivery buffer and evidence mechanism, NOT a second
 * durable Foreman event store — it must append before acknowledging
 * acceptance (TRD-017).
 */
export interface LocalOutboxSink {
  append(event: RuntimeStampedEvent): Promise<void>;
}

/** In-memory outbox for local runs and tests — not durable across process restarts. */
export class InMemoryLocalOutboxSink implements LocalOutboxSink {
  private readonly entries: RuntimeStampedEvent[] = [];

  async append(event: RuntimeStampedEvent): Promise<void> {
    this.entries.push(event);
  }

  peek(): readonly RuntimeStampedEvent[] {
    return this.entries;
  }
}

/** Append-only JSONL file outbox — the durable local evidence mechanism. */
export class FileLocalOutboxSink implements LocalOutboxSink {
  constructor(private readonly filePath: string) {}

  async append(event: RuntimeStampedEvent): Promise<void> {
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }
}
