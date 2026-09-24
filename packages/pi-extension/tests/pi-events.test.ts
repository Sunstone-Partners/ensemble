import { HARNESS_EVENT_TYPES, SEMANTIC_EVENT_TYPES, normalizeEvent } from "@sunstone-partners/ensemble-agent-core";
import {
  fromSessionStart,
  fromBeforeAgentStart,
  fromToolExecutionStart,
  fromToolExecutionEnd,
  fromAgentEnd,
  fromSessionShutdown,
  fromToolCall,
  fromToolResult,
} from "../src/pi-events";

const CATALOG = new Set<string>([...HARNESS_EVENT_TYPES, ...SEMANTIC_EVENT_TYPES]);

describe("pi-events catalog reconciliation (TRD-001 / INFRA)", () => {
  it("every normalizer emits a type that exists in the closed catalog", () => {
    // Before TRD-001 four of these emitted runtime.tool_result /
    // runtime.tool.called / runtime.tool.failed / runtime.tool.completed,
    // none of which appear in HARNESS_EVENT_TYPES. Nothing rejected
    // them, so "validated against the closed catalog" was vacuous.
    const emitted = [
      fromSessionStart({} as never),
      fromBeforeAgentStart({ prompt: "hi" } as never),
      fromToolExecutionStart({ toolCallId: "c1", toolName: "bash" } as never),
      fromToolExecutionEnd({ toolCallId: "c1", toolName: "bash", isError: true } as never),
      fromAgentEnd({} as never),
      fromSessionShutdown({} as never),
      fromToolCall({ toolCallId: "c1", toolName: "bash" } as never),
      fromToolResult({ toolCallId: "c1", toolName: "bash" } as never),
    ];

    const uncatalogued = emitted.map((e) => e.type).filter((t) => !CATALOG.has(t));
    expect(uncatalogued).toEqual([]);
  });

  it("carries the pass/fail signal on the payload rather than in an uncatalogued type name", () => {
    const failed = fromToolExecutionEnd({ toolCallId: "c1", toolName: "bash", isError: true } as never);
    const passed = fromToolExecutionEnd({ toolCallId: "c2", toolName: "bash", isError: false } as never);

    expect(failed.type).toBe("runtime.tool_call.completed");
    expect(passed.type).toBe("runtime.tool_call.completed");
    expect(failed.payload.isError).toBe(true);
    expect(passed.payload.isError).toBe(false);
  });

  it("normalizeEvent rejects an uncatalogued type instead of passing it through", () => {
    expect(() => normalizeEvent({ type: "runtime.tool_result", source: "pi" })).toThrow(
      /not in the closed event catalog/,
    );
    expect(() => normalizeEvent({ type: "totally.made.up", source: "pi" })).toThrow(
      /not in the closed event catalog/,
    );
  });

  it("normalizeEvent still accepts catalogued harness and semantic types", () => {
    expect(normalizeEvent({ type: "runtime.session.started", source: "pi" }).type).toBe("runtime.session.started");
    expect(normalizeEvent({ type: "test.failure.observed", source: "pi" }).type).toBe("test.failure.observed");
  });
});
