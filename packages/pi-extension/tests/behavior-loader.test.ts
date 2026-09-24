import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  echoTool,
  compile,
  compileBehaviorToArtifacts,
  BehaviorManifest,
} from "@sunstone-partners/ensemble-agent-core";
import { loadCompiledBehavior } from "../src/behavior-loader";

const manifest: BehaviorManifest = {
  api_version: "ensemble.sunstone.dev/v1",
  kind: "Behavior",
  metadata: { name: "investigate-test-failure", version: "1.0.0" },
  trigger: { event_type: "test.failed" },
  policy: { mode: "propose", timeout: "30m" },
  capabilities: { tools: ["echo", "read"], mutation_classes: [] },
  execution: { graph: "investigate-test-failure" },
  outcomes: ["test.failure.investigated"],
};

interface FakeCommandOptions {
  description?: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

interface FakeToolOptions {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
}

type ToolCallHandler = (event: {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
}) => { block?: boolean; reason?: string } | undefined | Promise<{ block?: boolean; reason?: string } | undefined>;

function fakePi() {
  const commands = new Map<string, FakeCommandOptions>();
  const tools = new Map<string, FakeToolOptions>();
  const sentMessages: { content: string; options: unknown }[] = [];
  const toolCallHandlers: ToolCallHandler[] = [];
  const pi = {
    registerCommand: (name: string, options: FakeCommandOptions) => {
      commands.set(name, options);
    },
    registerTool: (options: FakeToolOptions) => {
      tools.set(options.name, options);
    },
    sendUserMessage: (content: string, options: unknown) => {
      sentMessages.push({ content, options });
    },
    on: (eventName: string, handler: ToolCallHandler) => {
      if (eventName === "tool_call") {
        toolCallHandlers.push(handler);
      }
      return () => undefined;
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    commands,
    tools,
    sentMessages,
    fireToolCall: async (toolName: string) => {
      for (const handler of toolCallHandlers) {
        const result = await handler({ type: "tool_call", toolCallId: "call-1", toolName });
        if (result?.block) return result;
      }
      return undefined;
    },
  };
}

describe("loadCompiledBehavior (TRD-014)", () => {
  it("AC-014-1: the compiled prompt is available and functional as a real Pi command", async () => {
    const { compiled } = compile({ behaviors: [manifest] });
    const artifacts = compileBehaviorToArtifacts(compiled[0], [echoTool]);

    const { pi, commands, sentMessages } = fakePi();
    loadCompiledBehavior(pi, compiled[0], artifacts, [echoTool]);

    expect(commands.has("investigate-test-failure")).toBe(true);

    const command = commands.get("investigate-test-failure")!;
    await command.handler("", { ui: {} });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content).toBe(artifacts.promptMarkdown);
  });

  it("AC-014-1: the compiled skill document is available on demand via --skill without triggering a turn", async () => {
    const { compiled } = compile({ behaviors: [manifest] });
    const artifacts = compileBehaviorToArtifacts(compiled[0], [echoTool]);

    const { pi, commands, sentMessages } = fakePi();
    loadCompiledBehavior(pi, compiled[0], artifacts, [echoTool]);

    const setStatusCalls: unknown[] = [];
    const command = commands.get("investigate-test-failure")!;
    await command.handler("--skill", { ui: { setStatus: (...args: unknown[]) => setStatusCalls.push(args) } });

    expect(sentMessages).toHaveLength(0);
    expect(setStatusCalls).toHaveLength(1);
  });

  it("AC-014-1: the governed tool declared by the behavior is registered and functional via pi.registerTool", async () => {
    const { compiled } = compile({ behaviors: [manifest] });
    const artifacts = compileBehaviorToArtifacts(compiled[0], [echoTool]);

    const { pi, tools } = fakePi();
    loadCompiledBehavior(pi, compiled[0], artifacts, [echoTool]);

    expect(tools.has("echo")).toBe(true);
    const tool = tools.get("echo")!;
    const result = await tool.execute(
      "call-1",
      { message: "hi" },
      new AbortController().signal,
      undefined,
      { sessionManager: { getSessionId: () => "session-1" } },
    );
    expect(result).toEqual({ content: [{ type: "text", text: '{"echoed":"hi"}' }], details: { echoed: "hi" } });
  });

  it("does not register a tool the artifacts did not declare as available", () => {
    const manifestWithUnavailableTool: BehaviorManifest = {
      ...manifest,
      capabilities: { tools: ["some-other-tool"], mutation_classes: [] },
    };
    const { compiled } = compile({ behaviors: [manifestWithUnavailableTool] });
    const artifacts = compileBehaviorToArtifacts(compiled[0], [echoTool]);
    expect(artifacts.toolNames).toEqual([]);

    const { pi, tools } = fakePi();
    loadCompiledBehavior(pi, compiled[0], artifacts, [echoTool]);
    expect(tools.size).toBe(0);
  });
});

describe("wireToolGrantEnforcement (TRD-018)", () => {
  it("AC-018-1: a tool call for a name outside capabilities.tools is denied at the boundary regardless of prompt phrasing", async () => {
    const { compiled } = compile({ behaviors: [manifest] }); // capabilities.tools: ["echo", "read"]
    const artifacts = compileBehaviorToArtifacts(compiled[0], [echoTool]);
    const { pi, fireToolCall } = fakePi();
    loadCompiledBehavior(pi, compiled[0], artifacts, [echoTool]);

    const blocked = await fireToolCall("bash.test");
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toMatch(/not granted/);
  });

  it("AC-018-1: a tool call for a granted name is not blocked by this handler", async () => {
    const { compiled } = compile({ behaviors: [manifest] });
    const artifacts = compileBehaviorToArtifacts(compiled[0], [echoTool]);
    const { pi, fireToolCall } = fakePi();
    loadCompiledBehavior(pi, compiled[0], artifacts, [echoTool]);

    const result = await fireToolCall("read");
    expect(result).toBeUndefined();
  });

  it("AC-018-2: enforcement is boundary-level (toolName-only), so no prompt-injection-style reasoning field can bypass it", async () => {
    const { compiled } = compile({ behaviors: [manifest] });
    const artifacts = compileBehaviorToArtifacts(compiled[0], [echoTool]);
    const { pi, fireToolCall } = fakePi();
    loadCompiledBehavior(pi, compiled[0], artifacts, [echoTool]);

    // The injected instruction lives only in conversational content this
    // handler never receives — the tool_call event carries only
    // toolCallId/toolName, so there is no "ignore restrictions" field to
    // honor even if the model was fooled into calling the ungranted tool.
    const blocked = await fireToolCall("bash.write");
    expect(blocked?.block).toBe(true);
  });
});
