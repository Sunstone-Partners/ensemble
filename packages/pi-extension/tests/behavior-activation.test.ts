import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { echoTool } from "@sunstone-partners/ensemble-agent-core";
import { activateBehaviorPipeline, resolveRepoRoot } from "../src/behavior-activation";
import { beginBehaviorScope } from "../src/tool-grant-enforcement";

type ToolCallHandler = (event: { type: "tool_call"; toolCallId: string; toolName: string }) =>
  | { block?: boolean; reason?: string }
  | undefined;

function fakePi() {
  const commands = new Map<string, unknown>();
  const tools = new Map<string, unknown>();
  const toolCallHandlers: ToolCallHandler[] = [];
  const pi = {
    registerCommand: (name: string, options: unknown) => commands.set(name, options),
    registerTool: (options: { name: string }) => tools.set(options.name, options),
    registerFlag: () => undefined,
    getFlag: () => false,
    sendUserMessage: () => undefined,
    on: (eventName: string, handler: ToolCallHandler) => {
      if (eventName === "tool_call") toolCallHandlers.push(handler);
      return () => undefined;
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    commands,
    tools,
    fireToolCall: (toolName: string) => {
      for (const handler of toolCallHandlers) {
        const result = handler({ type: "tool_call", toolCallId: "c1", toolName });
        if (result?.block) return result;
      }
      return undefined;
    },
  };
}

/** Builds a throwaway repo laid out the way discovery expects. */
function repoWithBehavior(yamlBody: string): string {
  const root = mkdtempSync(join(tmpdir(), "activation-"));
  const dir = join(root, "packages", "agent-core", "behaviors", "investigate-test-failure");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "behavior.yaml"), yamlBody);
  return root;
}

const GRANTS_READ_ONLY = `api_version: ensemble.sunstone.dev/v1
kind: Behavior
metadata:
  name: investigate-test-failure
  version: 1.0.0
trigger:
  event_type: test.failure.observed
policy:
  mode: propose
  timeout: 30m
capabilities:
  tools:
    - read
  mutation_classes: []
execution:
  graph: investigate-test-failure
outcomes:
  - test.failure.investigated
`;

describe("behavior pipeline activation (TRD-005 / REQ-009)", () => {
  const created: string[] = [];
  afterAll(() => created.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("AC-009-1: discovers, compiles and loads a behavior package with no test-only harness", () => {
    const root = repoWithBehavior(GRANTS_READ_ONLY);
    created.push(root);

    const { pi, commands } = fakePi();
    const result = activateBehaviorPipeline(pi, root, [echoTool]);

    expect(result.discovered).toBe(1);
    expect(result.loaded).toEqual(["investigate-test-failure"]);
    expect(result.skipped).toEqual([]);
    // Proof the load actually reached Pi, not just that a function returned.
    expect(commands.has("investigate-test-failure")).toBe(true);
  });

  it("AC-009-2: a native bash call is blocked when the manifest does not grant bash", () => {
    // This is the assertion the whole of PR 1 exists for. Before
    // TRD-005, wireToolGrantEnforcement lived inside loadCompiledBehavior,
    // which had no call sites outside tests -- so this enforcement never
    // ran in a real session. Removing the activation wiring must make
    // this test fail.
    const root = repoWithBehavior(GRANTS_READ_ONLY);
    created.push(root);

    const { pi, fireToolCall } = fakePi();
    const activated = activateBehaviorPipeline(pi, root, [echoTool]);
    // Grants bind to an executing behavior, not the idle session.
    beginBehaviorScope(pi, activated.loaded);

    const blocked = fireToolCall("bash");
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toMatch(/not granted/);

    // A granted tool is not blocked, proving the check discriminates.
    expect(fireToolCall("read")).toBeUndefined();
  });

  it("AC-009-3: a repo with no behavior packages activates cleanly (TRD-006)", () => {
    const empty = mkdtempSync(join(tmpdir(), "activation-empty-"));
    created.push(empty);

    const { pi } = fakePi();
    let result;
    expect(() => {
      result = activateBehaviorPipeline(pi, empty, [echoTool]);
    }).not.toThrow();

    expect(result!.discovered).toBe(0);
    expect(result!.loaded).toEqual([]);
  });

  it("reports a malformed behavior as skipped rather than aborting activation", () => {
    const root = repoWithBehavior("this: [is not: valid behavior yaml");
    created.push(root);

    const { pi } = fakePi();
    const result = activateBehaviorPipeline(pi, root, [echoTool]);

    expect(result.loaded).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].behaviorId).toBe("investigate-test-failure");
  });
});

describe("resolveRepoRoot (TRD-005 robustness)", () => {
  it("finds the repo root when started from a nested subdirectory", () => {
    const root = mkdtempSync(join(tmpdir(), "root-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    const nested = join(root, "packages", "deep", "nested");
    mkdirSync(nested, { recursive: true });

    expect(resolveRepoRoot(nested)).toBe(root);
    rmSync(root, { recursive: true, force: true });
  });

  it("falls back to the start directory when no .git ancestor exists", () => {
    const orphan = mkdtempSync(join(tmpdir(), "orphan-"));
    expect(resolveRepoRoot(orphan)).toBe(orphan);
    rmSync(orphan, { recursive: true, force: true });
  });
});

describe("the reachable denial path in production (TRD-003 scope, honestly stated)", () => {
  const mine: string[] = [];
  afterAll(() => mine.forEach((d) => rmSync(d, { recursive: true, force: true })));
  it("ungranted NATIVE tools are denied at the tool_call boundary, which Pi does dispatch", () => {
    const root = repoWithBehavior(GRANTS_READ_ONLY);
    mine.push(root);
    const { pi, fireToolCall } = fakePi();
    activateBehaviorPipeline(pi, root, [echoTool]);

    // bash/write/edit are Pi's own tools -- the extension never
    // registers them, so exposure cannot gate them. This boundary is
    // the only thing that can, and it is now live.
    beginBehaviorScope(pi, ["investigate-test-failure"]);
    for (const native of ["bash", "write", "edit"]) {
      expect(fireToolCall(native)?.block).toBe(true);
    }
    expect(fireToolCall("read")).toBeUndefined();
  });

  it("ungranted CUSTOM tools are unreachable by exposure, not by a runtime denial", () => {
    const root = repoWithBehavior(GRANTS_READ_ONLY);
    mine.push(root);
    const { pi, tools } = fakePi();
    activateBehaviorPipeline(pi, root, [echoTool]);

    // echo is available to the harness but ungranted: Pi is never told
    // it exists, so no execute() closure can ever run for it.
    expect(tools.has(echoTool.name)).toBe(false);
  });
});

describe("portability of activation (TRD-008 reachability)", () => {
  const mine: string[] = [];
  afterAll(() => mine.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("loads a behavior from a repo with no packages/ directory", () => {
    // TRD-008 made discovery configurable; this asserts activation
    // actually passes that configuration through, rather than leaving
    // the new capability reachable only from unit tests.
    const root = mkdtempSync(join(tmpdir(), "portable-"));
    mine.push(root);
    const dir = join(root, ".ensemble", "behaviors", "investigate-test-failure");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "behavior.yaml"), GRANTS_READ_ONLY);

    const { pi, commands, fireToolCall } = fakePi();
    const result = activateBehaviorPipeline(pi, root, [echoTool]);

    expect(result.loaded).toEqual(["investigate-test-failure"]);
    expect(commands.has("investigate-test-failure")).toBe(true);
    beginBehaviorScope(pi, result.loaded);
    expect(fireToolCall("bash")?.block).toBe(true);
  });
});
