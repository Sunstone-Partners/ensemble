import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { echoTool, compile, compileBehaviorToArtifacts, BehaviorManifest } from "@sunstone-partners/ensemble-agent-core";
import { loadCompiledBehavior } from "../src/behavior-loader";

const manifest: BehaviorManifest = {
  api_version: "ensemble.sunstone.dev/v1",
  kind: "Behavior",
  metadata: { name: "investigate-test-failure", version: "1.0.0" },
  trigger: { event_type: "test.failed" },
  policy: { mode: "propose", timeout: "30m" },
  capabilities: { tools: ["echo"], mutation_classes: [] },
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

function fakePi() {
  const commands = new Map<string, FakeCommandOptions>();
  const tools = new Map<string, FakeToolOptions>();
  const sentMessages: { content: string; options: unknown }[] = [];
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
  } as unknown as ExtensionAPI;

  return { pi, commands, tools, sentMessages };
}

describe("loadCompiledBehavior (TRD-014)", () => {
  it("AC-014-1: the compiled prompt is available and functional as a real Pi command", async () => {
    const { compiled } = compile({ behaviors: [manifest] });
    const artifacts = compileBehaviorToArtifacts(compiled[0], [echoTool]);

    const { pi, commands, sentMessages } = fakePi();
    loadCompiledBehavior(pi, artifacts, [echoTool]);

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
    loadCompiledBehavior(pi, artifacts, [echoTool]);

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
    loadCompiledBehavior(pi, artifacts, [echoTool]);

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
    loadCompiledBehavior(pi, artifacts, [echoTool]);
    expect(tools.size).toBe(0);
  });
});
