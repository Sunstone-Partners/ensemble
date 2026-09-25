import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createActivate, drainDispatches } from "../src/extension";

/**
 * The continuation dispatch path (pi.sendUserMessage) only ever re-ran the
 * single originally-failing command as verification, never the whole
 * suite -- so a fix that made its target pass while breaking an unrelated
 * caller of the same file was accepted and never rolled back. This is the
 * gap br-o355 tracks and the mutation to outbox.ts is believed to have
 * exploited: `if (this.entries.length > 0) return;` made SOME check pass
 * while silently breaking append() for everyone else.
 *
 * These tests exercise the real continuation path end to end -- real git
 * snapshot/restore, real child-process test commands, only the Pi event
 * surface and the model's own edit are simulated -- and prove the fix:
 * a regression in the behavior's execution.test_command (the whole
 * suite) now overrides an otherwise-passing narrow verdict and triggers
 * rollback, exactly as the governed AutofixLoop path already guarantees.
 */

const BEHAVIOR = `api_version: ensemble.sunstone.dev/v1
kind: Behavior
metadata:
  name: fix-failing-test
  version: 1.0.0
trigger:
  event_type: test.failure.observed
  predicate:
    isError: { equals: true }
policy:
  mode: propose
  timeout: 30m
capabilities:
  tools: [read, edit]
  mutation_classes: [artifact.write]
execution:
  graph: fix-failing-test
  test_command: node run-all.js
outcomes:
  - test.failure.investigated
`;

const RUN_TARGET = `const { add } = require("./src/math.js");
if (add(1, 2) === 3) {
  console.log("Tests:       1 passed, 1 total");
  process.exit(0);
}
console.log("Tests:       1 failed, 0 passed, 1 total");
process.exit(1);
`;

const RUN_ALL = `const { add, subtract } = require("./src/math.js");
let failed = 0;
if (add(1, 2) !== 3) failed++;
if (subtract(5, 2) !== 3) failed++;
const passed = 2 - failed;
if (failed > 0) {
  console.log(\`Tests:       \${failed} failed, \${passed} passed, 2 total\`);
  process.exit(1);
}
console.log("Tests:       2 passed, 2 total");
process.exit(0);
`;

// add() is broken (narrow command fails); subtract() is correct.
const BROKEN = "exports.add = (a, b) => a - b;\nexports.subtract = (a, b) => a - b;\n";
// A fix that repairs add() but, in the same edit, breaks subtract() -- the
// narrow command (which only exercises add()) cannot see this; only the
// whole-suite command can.
const NARROW_FIX_BREAKS_OTHER = "exports.add = (a, b) => a + b;\nexports.subtract = (a, b) => a + b;\n";
// A fix that repairs add() without touching subtract().
const GOOD_FIX = "exports.add = (a, b) => a + b;\nexports.subtract = (a, b) => a - b;\n";

const dirs: string[] = [];
const originalCwd = process.cwd();
afterAll(() => {
  process.chdir(originalCwd);
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "continuation-verify-"));
  dirs.push(root);

  const bdir = join(root, ".ensemble", "behaviors", "fix-failing-test");
  mkdirSync(bdir, { recursive: true });
  writeFileSync(join(bdir, "behavior.yaml"), BEHAVIOR);

  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "math.js"), BROKEN);
  writeFileSync(join(root, "run-target.js"), RUN_TARGET);
  writeFileSync(join(root, "run-all.js"), RUN_ALL);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      { name: "sandbox", version: "1.0.0", scripts: { test: "node run-target.js" } },
      null,
      2,
    ),
  );

  // The continuation path snapshots/restores via `git diff HEAD`. Without a
  // real commit here, that diff is empty against a non-existent HEAD and
  // restoreWorkingTree has nothing to revert to -- the rollback assertion
  // below would pass vacuously even if the whole-suite check were broken.
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "test"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: root });

  return root;
}

function fakePi() {
  // Array per event name, not a single slot: extension.ts itself registers
  // "session_shutdown" twice (endBehaviorScope and drainDispatches), which
  // only works if pi.on() supports multiple listeners per event -- a
  // single-slot mock would silently drop this file's own verification
  // handler whenever session.ts's wireSessionLifecycle registers the same
  // event name afterward (it does, for "agent_end" and "tool_result").
  const handlers = new Map<string, ((e: unknown) => Promise<void> | void)[]>();
  const pi = {
    registerCommand: () => undefined,
    registerTool: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => false,
    sendUserMessage: () => undefined,
    on: (name: string, h: (e: unknown) => Promise<void> | void) => {
      const list = handlers.get(name) ?? [];
      list.push(h);
      handlers.set(name, list);
      return () => undefined;
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    fire: async (n: string, e?: unknown) => {
      for (const h of handlers.get(n) ?? []) {
        await h(e);
      }
      await drainDispatches();
    },
  };
}

describe("continuation path re-verifies the whole suite, not just the narrow command (br-o355)", () => {
  it("rolls back a fix that passes the narrow command but breaks the whole suite", async () => {
    const root = sandbox();

    const instance = createActivate({
      // No candidate from the governed path -- this reproduces the
      // observed run, where dispatch went through continuation only.
      proposeFix: () => undefined,
    });

    process.chdir(root);
    const { pi, fire } = fakePi();
    instance.activate(pi);
    expect(instance.lastActivation()!.loaded).toEqual(["fix-failing-test"]);

    // 1. The real narrow command fails for real.
    await fire("tool_result", {
      type: "tool_result",
      toolCallId: "run-1",
      toolName: "bash",
      input: { command: "npm test" },
      content: [{ type: "text", text: "1 failed" }],
      isError: true,
    });

    // Proof the continuation actually enqueued, not a vacuous pass: the
    // event fired and reached the matcher.
    expect(instance.sink.drain().map((e) => e.event.type)).toContain("test.failure.observed");

    // 2. turn_end pops the continuation and opens the verification window.
    await fire("turn_end");

    // 3. Simulate the model's own edit: repairs add() (the narrow command's
    // only assertion) but breaks subtract() in the same file -- exactly the
    // shape of the outbox.ts mutation, which made some check pass while
    // silently breaking a different caller of the same method.
    writeFileSync(join(root, "src", "math.js"), NARROW_FIX_BREAKS_OTHER);

    // 4. agent_end closes the window and verifies.
    await fire("agent_end");

    // The narrow command alone would have graded this "passed". Proof the
    // whole-suite re-check actually ran and overrode it: the working tree
    // was rolled back to the pre-fix (BROKEN) state.
    expect(readFileSync(join(root, "src", "math.js"), "utf8")).toBe(BROKEN);
  });

  it("accepts a fix that passes both the narrow command and the whole suite", async () => {
    const root = sandbox();

    const instance = createActivate({
      proposeFix: () => undefined,
    });

    process.chdir(root);
    const { pi, fire } = fakePi();
    instance.activate(pi);

    await fire("tool_result", {
      type: "tool_result",
      toolCallId: "run-1",
      toolName: "bash",
      input: { command: "npm test" },
      content: [{ type: "text", text: "1 failed" }],
      isError: true,
    });

    expect(instance.sink.drain().map((e) => e.event.type)).toContain("test.failure.observed");

    await fire("turn_end");

    writeFileSync(join(root, "src", "math.js"), GOOD_FIX);

    await fire("agent_end");

    // A genuinely good fix must not be rolled back by the new check.
    expect(readFileSync(join(root, "src", "math.js"), "utf8")).toBe(GOOD_FIX);
  });
});
