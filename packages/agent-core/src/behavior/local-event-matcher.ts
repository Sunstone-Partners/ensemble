import { BehaviorEvent } from "../events";
import { BehaviorManifest, BehaviorPackage } from "./schema";
import { CompiledBehaviorPackage } from "./compiler";
import { match } from "./discovery";

/**
 * Matches events to behaviors and invokes them in-session (TRD-015 / REQ-003).
 *
 * This is the piece that makes a behavior *dispatch* rather than merely
 * validate: previously events were normalized and behaviors were
 * compiled, but nothing connected the two at runtime, so a matching
 * event produced no invocation.
 *
 * Non-durability is a requirement, not an omission (TRD-016 / REQ-003).
 * No event-to-behavior correlation is written to disk or to any
 * external store: state lives only in this object, for this session. A
 * durable queue would imply delivery guarantees, replay semantics and
 * crash recovery that this design does not provide, and pretending
 * otherwise is worse than being explicitly in-memory.
 */

export interface BehaviorInvocation {
  behavior: BehaviorManifest;
  event: BehaviorEvent;
}

export type BehaviorInvoker = (invocation: BehaviorInvocation) => void | Promise<void>;

export interface LocalEventMatcherOptions {
  /** Called once per (event, matching behavior) pair. */
  invoke: BehaviorInvoker;
  /** Reports an invoker failure; defaults to rethrowing. */
  onError?: (error: Error, invocation: BehaviorInvocation) => void;
}

export class LocalEventMatcher {
  private readonly pkg: BehaviorPackage;
  private invocationCount = 0;

  constructor(
    compiled: readonly CompiledBehaviorPackage[],
    private readonly options: LocalEventMatcherOptions,
  ) {
    // Compile once per session and cache: matching happens on every
    // appended event, and recompiling per event would put YAML parsing
    // on the hot path.
    this.pkg = { behaviors: compiled.map((c) => c.manifest) } as BehaviorPackage;
  }

  /** Behaviors known to this matcher, in registration order. */
  get behaviorNames(): string[] {
    return this.pkg.behaviors.map((b) => b.metadata.name);
  }

  /** Number of invocations made this session. Never persisted. */
  get invocations(): number {
    return this.invocationCount;
  }

  /**
   * Matches one event and invokes every matching behavior.
   * Returns the behaviors invoked, in order.
   */
  async onEvent(event: BehaviorEvent): Promise<string[]> {
    const matched = match(this.pkg, event);
    const invoked: string[] = [];

    for (const behavior of matched) {
      const invocation: BehaviorInvocation = { behavior, event };
      try {
        await this.options.invoke(invocation);
        this.invocationCount += 1;
        invoked.push(behavior.metadata.name);
      } catch (error) {
        // One behavior's failure must not suppress its siblings.
        if (this.options.onError) this.options.onError(error as Error, invocation);
        else throw error;
      }
    }

    return invoked;
  }
}
