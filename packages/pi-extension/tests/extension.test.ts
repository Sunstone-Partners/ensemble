import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../src/extension";

// AC-004-1 (real activation through Pi's loader with no load-time errors) is
// proved by scripts/smoke-activate.mjs, run as a subprocess: jest (via
// ts-jest, CommonJS target) cannot load @earendil-works/pi-coding-agent
// because it ships ESM-only (no `require` export condition) — even a
// dynamic `import()` gets compiled back to `require` under a CJS jest
// transform. A real Node ESM process sidesteps that resolver limitation
// entirely instead of mocking around it.
describe("pi-extension activation (AC-004-1/AC-004-2)", () => {
  it("throws a documented blocking-gap error instead of degrading silently if registerTool is missing (AC-004-2)", async () => {
    const brokenPi = {
      on: () => undefined,
    } as unknown as Pick<ExtensionAPI, "on"> as ExtensionAPI;
    expect(() => activate(brokenPi)).toThrow(/BLOCKING GAP/);
  });
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginBehaviorScope } from "../src/tool-grant-enforcement";

const READ_ONLY_BEHAVIOR = `api_version: ensemble.sunstone.dev/v1
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

describe("production activate() wires the behavior pipeline (TRD-005 / AC-009-1, AC-009-2)", () => {
  const dirs: string[] = [];
  const originalCwd = process.cwd();
  afterAll(() => {
    process.chdir(originalCwd);
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  function fakePi() {
    const commands = new Map<string, unknown>();
    const handlers: ((e: { type: string; toolCallId: string; toolName: string }) =>
      | { block?: boolean; reason?: string }
      | undefined)[] = [];
    const pi = {
      registerCommand: (name: string, o: unknown) => commands.set(name, o),
      registerTool: () => undefined,
      registerFlag: () => undefined,
      getFlag: () => false,
      sendUserMessage: () => undefined,
      on: (name: string, h: (e: { type: string; toolCallId: string; toolName: string }) =>
        | { block?: boolean; reason?: string }
        | undefined) => {
        if (name === "tool_call") handlers.push(h);
        return () => undefined;
      },
    } as unknown as ExtensionAPI;
    return {
      pi,
      commands,
      fireToolCall: (toolName: string) => {
        for (const h of handlers) {
          const r = h({ type: "tool_call", toolCallId: "c1", toolName });
          if (r?.block) return r;
        }
        return undefined;
      },
    };
  }

  it("AC-009-2: an ungranted native bash call is blocked in a session created by the real activate()", () => {
    // Deliberately routed through the default-exported activate() that
    // Pi itself calls -- not through activateBehaviorPipeline. If the
    // wiring is removed from extension.ts, this test fails even though
    // the pipeline modules still work in isolation. That distinction is
    // the entire point of REQ-009.
    const root = mkdtempSync(join(tmpdir(), "activate-e2e-"));
    dirs.push(root);
    const dir = join(root, "packages", "agent-core", "behaviors", "investigate-test-failure");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "behavior.yaml"), READ_ONLY_BEHAVIOR);

    process.chdir(root);
    const { pi, commands, fireToolCall } = fakePi();
    activate(pi);

    expect(commands.has("investigate-test-failure")).toBe(true);
    beginBehaviorScope(pi, ["investigate-test-failure"]);

    const blocked = fireToolCall("bash");
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toMatch(/not granted/);
    expect(fireToolCall("read")).toBeUndefined();
  });

  it("AC-009-3: activate() succeeds in a repo with no behavior packages", () => {
    const empty = mkdtempSync(join(tmpdir(), "activate-empty-"));
    dirs.push(empty);
    process.chdir(empty);
    const { pi } = fakePi();
    expect(() => activate(pi)).not.toThrow();
  });
});

describe("live dispatch reaches a behavior through the real activate() (TRD-015 / REQ-003)", () => {
  const dirs: string[] = [];
  const originalCwd = process.cwd();
  afterAll(() => {
    process.chdir(originalCwd);
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  function dispatchPi() {
    const handlers = new Map<string, (e: unknown) => Promise<void> | void>();
    const pi = {
      registerCommand: () => undefined,
      registerTool: () => undefined,
      registerFlag: () => undefined,
      getFlag: () => false,
      sendUserMessage: () => undefined,
      on: (name: string, h: (e: unknown) => Promise<void> | void) => {
        handlers.set(name, h);
        return () => undefined;
      },
    } as unknown as ExtensionAPI;
    return { pi, fire: async (n: string, e: unknown) => { await handlers.get(n)?.(e); } };
  }

  it("a failing test command fires the behavior, with no hand-built semantic event", async () => {
    // The full production path: real createActivate() -> session
    // wiring -> translator -> matcher -> behavior. Only a raw Pi
    // tool_result is injected; everything else must be real.
    const root = mkdtempSync(join(tmpdir(), "dispatch-e2e-"));
    dirs.push(root);
    const dir = join(root, "packages", "agent-core", "behaviors", "investigate-test-failure");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "behavior.yaml"), READ_ONLY_BEHAVIOR);

    process.chdir(root);
    const { createActivate } = await import("../src/extension");
    const instance = createActivate();
    const { pi, fire } = dispatchPi();
    instance.activate(pi);

    const invoked: string[] = [];
    instance.lastActivation()!.matcher!["options"].invoke = (i: { behavior: { metadata: { name: string } } }) => {
      invoked.push(i.behavior.metadata.name);
    };

    await fire("tool_result", {
      type: "tool_result",
      toolCallId: "t1",
      toolName: "bash",
      input: { command: "npm test" },
      content: [{ type: "text", text: "1 failing" }],
      isError: true,
    });

    expect(invoked).toEqual(["investigate-test-failure"]);
  });
});
