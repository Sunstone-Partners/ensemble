import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InMemoryEventSink } from "@sunstone-partners/ensemble-agent-core";
import { wireSessionLifecycle } from "../src/session";

type Handler = (event: unknown) => Promise<void> | void;

/**
 * Minimal fake of the subset of ExtensionAPI this package uses,
 * recording registered handlers so tests can fire them directly. Proves
 * TRD-006's wiring logic without needing a live Pi process — a real
 * live-process activation proof for the whole extension already exists
 * in scripts/smoke-activate.mjs.
 */
function fakePi(): { pi: ExtensionAPI; fire: (eventName: string, event: unknown) => Promise<void> } {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (eventName: string, handler: Handler) => {
      handlers.set(eventName, handler);
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    fire: async (eventName, event) => {
      await handlers.get(eventName)?.(event);
    },
  };
}

describe("wireSessionLifecycle (TRD-006)", () => {
  it("AC-006-1: captures session started, prompt submitted, tool called/completed/failed, session completed, and process exit — via Pi's native extension events only", async () => {
    const { pi, fire } = fakePi();
    const sink = new InMemoryEventSink();
    wireSessionLifecycle(pi, sink);

    await fire("session_start", { type: "session_start" });
    await fire("before_agent_start", { type: "before_agent_start", prompt: "hello" });
    await fire("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "echo",
      args: {},
    });
    await fire("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "echo",
      result: {},
      isError: false,
    });
    await fire("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "call-2",
      toolName: "echo",
      result: {},
      isError: true,
    });
    await fire("agent_end", { type: "agent_end", messages: [] });
    await fire("session_shutdown", { type: "session_shutdown" });

    const captured = sink.drain().map((envelope) => envelope.event.type);
    expect(captured).toEqual([
      "runtime.session.started",
      "runtime.prompt.submitted",
      "runtime.tool_call.started",
      "runtime.tool_call.completed",
      "runtime.tool_call.completed",
      "runtime.session.completed",
      "runtime.process.exited",
    ]);
  });

  it("AC-006-2: capture logic reads no hook configuration of any kind (hook-independence, by construction)", () => {
    const sourceOfWiring = wireSessionLifecycle.toString();
    expect(sourceOfWiring).not.toMatch(/hook/i);
  });
});

describe("wireSessionLifecycle (TRD-007)", () => {
  it("AC-007-1: a custom tool call/result pair is captured with matching correlation", async () => {
    const { pi, fire } = fakePi();
    const sink = new InMemoryEventSink();
    wireSessionLifecycle(pi, sink);

    await fire("tool_call", {
      type: "tool_call",
      toolCallId: "call-echo-1",
      toolName: "echo",
      input: { message: "hi" },
    });
    await fire("tool_result", {
      type: "tool_result",
      toolCallId: "call-echo-1",
      toolName: "echo",
      input: { message: "hi" },
      content: [],
      isError: false,
      details: {},
    });

    const [call, result] = sink.drain();
    expect(call.event.type).toBe("runtime.tool_call.started");
    expect(result.event.type).toBe("runtime.tool_call.completed");
    expect(call.event.payload.toolCallId).toBe("call-echo-1");
    expect(result.event.payload.toolCallId).toBe("call-echo-1");
    expect(call.event.payload.custom).toBe(true);
    expect(result.event.payload.custom).toBe(true);
  });

  it("AC-007-2: a native Pi tool call (bash) is captured and distinguished from a custom tool call", async () => {
    const { pi, fire } = fakePi();
    const sink = new InMemoryEventSink();
    wireSessionLifecycle(pi, sink);

    await fire("tool_call", {
      type: "tool_call",
      toolCallId: "call-bash-1",
      toolName: "bash",
      input: { command: "ls" },
    });

    const [call] = sink.drain();
    expect(call.event.type).toBe("runtime.tool_call.started");
    expect(call.event.payload.toolName).toBe("bash");
    expect(call.event.payload.custom).toBe(false);
  });
});

describe("tool_result payload enrichment (TRD-011 / REQ-001)", () => {
  it("AC-001-1: carries command, isError and output from a bash tool result", async () => {
    const sink = new InMemoryEventSink();
    const { pi, fire } = fakePi();
    wireSessionLifecycle(pi, sink);

    await fire("tool_result", {
      type: "tool_result",
      toolCallId: "t1",
      toolName: "bash",
      input: { command: "npm test" },
      content: [{ type: "text", text: "1 failing" }],
      isError: true,
    });

    const completed = sink.drain().find((e) => e.event.type === "runtime.tool_call.completed")!;
    expect(completed.event.payload).toMatchObject({
      toolCallId: "t1",
      toolName: "bash",
      command: "npm test",
      isError: true,
      output: "1 failing",
    });
  });

  it("both emitters of runtime.tool_call.completed agree on isError and custom", async () => {
    const sink = new InMemoryEventSink();
    const { pi, fire } = fakePi();
    wireSessionLifecycle(pi, sink);

    await fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: {}, isError: true });
    await fire("tool_result", { type: "tool_result", toolCallId: "t2", toolName: "bash", input: {}, content: [], isError: true });

    const completed = sink.drain().filter((e) => e.event.type === "runtime.tool_call.completed");
    expect(completed).toHaveLength(2);
    for (const e of completed) {
      expect(e.event.payload).toMatchObject({ isError: true, custom: false });
    }
  });
});

describe("live semantic translation through the real wiring (TRD-012/TRD-014)", () => {
  it("a failing test command produces test.failure.observed on the session bus", async () => {
    const sink = new InMemoryEventSink();
    const { pi, fire } = fakePi();
    wireSessionLifecycle(pi, sink);

    await fire("tool_result", {
      type: "tool_result",
      toolCallId: "t3",
      toolName: "bash",
      input: { command: "pytest tests/" },
      content: [{ type: "text", text: "FAILED" }],
      isError: true,
    });

    expect(sink.drain().map((e) => e.event.type)).toEqual([
      "runtime.tool_call.completed",
      "test.failure.observed",
    ]);
  });

  it("a passing test command produces no semantic event", async () => {
    const sink = new InMemoryEventSink();
    const { pi, fire } = fakePi();
    wireSessionLifecycle(pi, sink);

    await fire("tool_result", {
      type: "tool_result",
      toolCallId: "t4",
      toolName: "bash",
      input: { command: "pytest tests/" },
      content: [],
      isError: false,
    });

    expect(sink.drain().map((e) => e.event.type)).toEqual(["runtime.tool_call.completed"]);
  });

  it("a behavior-declared test command is honoured by the session wiring", async () => {
    const sink = new InMemoryEventSink();
    const { pi, fire } = fakePi();
    wireSessionLifecycle(pi, sink, { testCommand: "./run-suite.sh" });

    await fire("tool_result", {
      type: "tool_result",
      toolCallId: "t5",
      toolName: "bash",
      input: { command: "./run-suite.sh" },
      content: [],
      isError: true,
    });

    expect(sink.drain().map((e) => e.event.type)).toContain("test.failure.observed");
  });
});
