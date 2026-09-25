import { LocalEventMatcher, BehaviorInvocation } from "../src/behavior/local-event-matcher";
import { compile } from "../src/behavior/compiler";
import { normalizeEvent } from "../src/normalize";
import { BehaviorManifest } from "../src/behavior/schema";

function manifest(name: string, predicate?: Record<string, unknown>): BehaviorManifest {
  return {
    api_version: "ensemble.sunstone.dev/v1",
    kind: "Behavior",
    metadata: { name, version: "1.0.0" },
    trigger: { event_type: "test.failure.observed", predicate: predicate as never },
    policy: { mode: "propose", timeout: "30m" },
    capabilities: { tools: ["read"], mutation_classes: [] },
    execution: { graph: name },
    outcomes: ["test.failure.investigated"],
  };
}

function compiledFor(...manifests: BehaviorManifest[]) {
  const { compiled, errors } = compile({ behaviors: manifests });
  expect(errors).toEqual([]);
  return compiled;
}

const failing = () =>
  normalizeEvent({
    type: "test.failure.observed",
    source: "pi",
    payload: { command: "npm test", isError: true },
  });

describe("LocalEventMatcher (TRD-015 / REQ-003)", () => {
  it("AC-003-1: invokes a behavior whose trigger matches", async () => {
    const seen: BehaviorInvocation[] = [];
    const m = new LocalEventMatcher(compiledFor(manifest("a")), { invoke: (i) => void seen.push(i) });

    const invoked = await m.onEvent(failing());

    expect(invoked).toEqual(["a"]);
    expect(seen).toHaveLength(1);
    expect(seen[0].behavior.metadata.name).toBe("a");
    expect(seen[0].event.type).toBe("test.failure.observed");
  });

  it("AC-003-2: invokes nothing when no trigger matches", async () => {
    const seen: BehaviorInvocation[] = [];
    const m = new LocalEventMatcher(compiledFor(manifest("a")), { invoke: (i) => void seen.push(i) });

    const other = normalizeEvent({ type: "runtime.session.started", source: "pi" });
    expect(await m.onEvent(other)).toEqual([]);
    expect(seen).toEqual([]);
    expect(m.invocations).toBe(0);
  });

  it("respects trigger predicates, not just event type", async () => {
    const m = new LocalEventMatcher(compiledFor(manifest("picky", { isError: { equals: true } })), {
      invoke: () => undefined,
    });

    expect(await m.onEvent(failing())).toEqual(["picky"]);

    const passing = normalizeEvent({
      type: "test.failure.observed",
      source: "pi",
      payload: { command: "npm test", isError: false },
    });
    expect(await m.onEvent(passing)).toEqual([]);
  });

  it("invokes every matching behavior, in registration order", async () => {
    const m = new LocalEventMatcher(compiledFor(manifest("a"), manifest("b")), { invoke: () => undefined });
    expect(await m.onEvent(failing())).toEqual(["a", "b"]);
    expect(m.invocations).toBe(2);
  });

  it("one behavior's failure does not suppress its siblings", async () => {
    const errors: string[] = [];
    const m = new LocalEventMatcher(compiledFor(manifest("boom"), manifest("ok")), {
      invoke: (i) => {
        if (i.behavior.metadata.name === "boom") throw new Error("invoker exploded");
      },
      onError: (e) => errors.push(e.message),
    });

    expect(await m.onEvent(failing())).toEqual(["ok"]);
    expect(errors).toEqual(["invoker exploded"]);
  });

  it("rethrows when no onError handler is supplied, rather than silently swallowing", async () => {
    const m = new LocalEventMatcher(compiledFor(manifest("boom")), {
      invoke: () => {
        throw new Error("invoker exploded");
      },
    });
    await expect(m.onEvent(failing())).rejects.toThrow("invoker exploded");
  });

  it("compiles once and reuses it across events", async () => {
    const m = new LocalEventMatcher(compiledFor(manifest("a")), { invoke: () => undefined });
    for (let i = 0; i < 25; i += 1) await m.onEvent(failing());
    expect(m.invocations).toBe(25);
    expect(m.behaviorNames).toEqual(["a"]);
  });
});

describe("non-durability (TRD-016 / REQ-003)", () => {
  it("writes no event-to-behavior correlation anywhere on disk", async () => {
    // Asserted by interception rather than by inspecting a directory:
    // a directory check only proves nothing landed where we looked.
    const fs = require("node:fs") as typeof import("node:fs");
    const writes: string[] = [];
    const spies = (["writeFileSync", "appendFileSync", "mkdirSync", "openSync"] as const).map((fn) => {
      const original = fs[fn] as unknown as (...args: unknown[]) => unknown;
      (fs as Record<string, unknown>)[fn] = (...args: unknown[]) => {
        writes.push(`${fn}:${String(args[0])}`);
        return original(...args);
      };
      return () => {
        (fs as Record<string, unknown>)[fn] = original;
      };
    });

    try {
      const m = new LocalEventMatcher(compiledFor(manifest("a")), { invoke: () => undefined });
      await m.onEvent(failing());
      await m.onEvent(failing());
      expect(m.invocations).toBe(2);
    } finally {
      spies.forEach((restore) => restore());
    }

    expect(writes).toEqual([]);
  });

  it("a fresh matcher starts with no memory of a previous one", () => {
    // Stands in for the cross-process case: state lives in the object,
    // so a new session (new object) cannot inherit it.
    const first = new LocalEventMatcher(compiledFor(manifest("a")), { invoke: () => undefined });
    const second = new LocalEventMatcher(compiledFor(manifest("a")), { invoke: () => undefined });

    expect(first.invocations).toBe(0);
    expect(second.invocations).toBe(0);
  });
});

describe("sibling isolation holds without an onError handler", () => {
  it("a failing behavior does not prevent later matches from running", async () => {
    // Previously the default path threw inside the loop, so isolation
    // only held when onError happened to be supplied -- making
    // invocation order silently significant.
    const invoked: string[] = [];
    const m = new LocalEventMatcher(compiledFor(manifest("boom"), manifest("later")), {
      invoke: (i) => {
        invoked.push(i.behavior.metadata.name);
        if (i.behavior.metadata.name === "boom") throw new Error("exploded");
      },
    });

    await expect(m.onEvent(failing())).rejects.toThrow("exploded");
    expect(invoked).toEqual(["boom", "later"]);
  });
});
