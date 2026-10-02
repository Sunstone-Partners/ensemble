import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AuthoringRecord } from "@sunstone-partners/ensemble-agent-core";
import activate from "../src/extension";

// AC-004-1 (real activation through Pi's loader with no load-time errors) is
// proved by scripts/smoke-activate.mjs, run as a subprocess: jest (via
// ts-jest, CommonJS target) cannot load @earendil-works/pi-coding-agent
// because it ships ESM-only (no `require` export condition) — even a
// dynamic `import()` gets compiled back to `require` under a CJS jest
// transform. A real Node ESM process sidesteps that resolver limitation
// entirely instead of mocking around it.
/** Arms a fixture repository; see br-fvmq. Refusal is covered separately. */
function arm(root: string): string {
  mkdirSync(join(root, ".ensemble"), { recursive: true });
  writeFileSync(join(root, ".ensemble", "config.yaml"), "behaviors:\n  armed: true\n");
  return root;
}

describe("pi-extension activation (AC-004-1/AC-004-2)", () => {
  it("throws a documented blocking-gap error instead of degrading silently if registerTool is missing (AC-004-2)", async () => {
    const brokenPi = {
      on: () => undefined,
    } as unknown as Pick<ExtensionAPI, "on"> as ExtensionAPI;
    expect(() => activate(brokenPi)).toThrow(/BLOCKING GAP/);
  });

  // REVERSES dev 609e790 (br-o9j1), which made pi.sendMessage a required
  // capability so a rolled-back continuation fix could be announced. On this
  // runtime no fix is applied to the live tree before it is verified --
  // fix.verify runs in a throwaway worktree and fix-failing-test only
  // proposes -- so there is no rollback to announce, and the extension sends
  // nothing into the session at all. Refusing to load for want of an API it
  // never calls would turn a missing capability into a missing extension.
  it("loads fully without pi.sendMessage: nothing is rolled back, so nothing needs announcing", () => {
    const registered: string[] = [];
    const noSendMessage = {
      on: () => undefined,
      registerTool: () => undefined,
      registerCommand: (name: string) => registered.push(name),
      registerFlag: () => undefined,
      getFlag: () => false,
    } as unknown as ExtensionAPI;
    const cwd = process.cwd();
    const scratch = mkdtempSync(join(tmpdir(), "no-send-message-"));
    try {
      process.chdir(scratch);
      activate(noSendMessage);
    } finally {
      process.chdir(cwd);
      rmSync(scratch, { recursive: true, force: true });
    }
    expect(registered).toEqual(expect.arrayContaining(["ensemble-approve", "ensemble-status"]));
  });
});

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
    const root = arm(mkdtempSync(join(tmpdir(), "activate-e2e-")));
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

  it("TRD-023 / AC-029-1: the real activate() records a discovered package's authoring start", () => {
    // Through the entry point Pi calls (Rule 6). If activation stopped opting
    // into recording, discovery would still work and nothing would be recorded.
    const root = arm(mkdtempSync(join(tmpdir(), "activate-authoring-")));
    dirs.push(root);
    const dir = join(root, ".ensemble", "behaviors", "investigate-test-failure");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "behavior.yaml"), READ_ONLY_BEHAVIOR);

    process.chdir(root);
    const before = Date.now();
    activate(fakePi().pi);

    const state: { schema_version: string; entries: AuthoringRecord[] } = JSON.parse(
      readFileSync(join(root, ".ensemble", "state", "authoring.json"), "utf8"),
    );
    expect(state.schema_version).toBe("1.0.0");
    expect(state.entries).toEqual([
      { package: "investigate-test-failure", startedAt: expect.any(String), completedAt: null },
    ]);
    expect(Date.parse(state.entries[0].startedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(state.entries[0].startedAt)).toBeLessThanOrEqual(Date.now());
  });

  it("TRD-023 / AC-029-1: the real activate() records completion for a package whose fixtures pass, and not for one whose fixtures fail", () => {
    // Nobody calls conformance by hand here: activation runs it. If that
    // wiring were removed, both packages would keep `completedAt: null`.
    const root = arm(mkdtempSync(join(tmpdir(), "activate-completion-")));
    dirs.push(root);
    for (const [id, agree] of [["passing-fixtures", true], ["failing-fixtures", false]] as const) {
      const dir = join(root, ".ensemble", "behaviors", id);
      for (const sub of ["events", "expected-matches", "expected-outcomes"]) {
        mkdirSync(join(dir, "fixtures", sub), { recursive: true });
      }
      writeFileSync(join(dir, "behavior.yaml"), READ_ONLY_BEHAVIOR.replace(/investigate-test-failure/g, id));
      writeFileSync(
        join(dir, "fixtures", "events", "npm-test-failed.json"),
        JSON.stringify({ type: "test.failure.observed", source: "fixture", payload: { command: "npm test", isError: true } }),
      );
      writeFileSync(join(dir, "fixtures", "expected-matches", "npm-test-failed.json"), JSON.stringify(agree ? [id] : []));
      writeFileSync(
        join(dir, "fixtures", "expected-outcomes", "npm-test-failed.json"),
        JSON.stringify(agree ? ["test.failure.investigated"] : []),
      );
    }

    process.chdir(root);
    activate(fakePi().pi);

    const state: { schema_version: string; entries: AuthoringRecord[] } = JSON.parse(
      readFileSync(join(root, ".ensemble", "state", "authoring.json"), "utf8"),
    );
    const passing = state.entries.find((entry) => entry.package === "passing-fixtures");
    const failing = state.entries.find((entry) => entry.package === "failing-fixtures");
    expect(failing).toEqual({ package: "failing-fixtures", startedAt: expect.any(String), completedAt: null });
    expect(passing).toEqual({ package: "passing-fixtures", startedAt: expect.any(String), completedAt: expect.any(String) });
    expect(Date.parse(passing?.completedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(passing?.startedAt ?? ""));
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
    const root = arm(mkdtempSync(join(tmpdir(), "dispatch-e2e-")));
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
