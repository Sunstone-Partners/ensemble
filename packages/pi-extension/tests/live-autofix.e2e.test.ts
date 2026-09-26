import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ApprovalHost } from "@sunstone-partners/ensemble-agent-core";
import { createActivate, drainDispatches } from "../src/extension";
import { ConstitutionChange } from "../src/constitution-proposal";

/**
 * The experiment the whole PRD exists to make possible: break a real
 * test, run it for real, and see whether the event fires all the way
 * through to a repaired test and a constitution change.
 *
 * Nothing here is mocked except the Pi event surface itself. The suite
 * is a real child process, the failure output is real, and the fix is
 * applied to a real file through MutationGuard.
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
  mode: auto
  timeout: 30m
capabilities:
  tools: [read]
  mutation_classes: [artifact.write, constitution.propose]
execution:
  graph: fix-failing-test
  test_command: npm test
outcomes:
  - test.failure.investigated
  - constitution.change.proposed
`;

const RUNNER = `const assert = require("assert");
const { add } = require("./src/math.js");
try {
  assert.strictEqual(add(1, 2), 3);
  console.log("Tests:       1 passed, 1 total");
  process.exit(0);
} catch (e) {
  console.log("FAIL src/math.js");
  console.log("  expected 3, received " + add(1, 2));
  console.log("Tests:       1 failed, 0 passed, 1 total");
  process.exit(1);
}
`;

const BROKEN = "exports.add = (a, b) => a - b;\n";
const FIXED = "exports.add = (a, b) => a + b;\n";

const CONSTITUTION = `# Project Constitution: Sandbox

## Non-Negotiable Rules

1. **No secrets in code**
`;

const dirs: string[] = [];
const originalCwd = process.cwd();
afterAll(() => {
  process.chdir(originalCwd);
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "live-autofix-"));
  dirs.push(root);

  const bdir = join(root, ".ensemble", "behaviors", "fix-failing-test");
  mkdirSync(bdir, { recursive: true });
  writeFileSync(join(bdir, "behavior.yaml"), BEHAVIOR);

  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs", "standards"), { recursive: true });
  writeFileSync(join(root, "src", "math.js"), BROKEN);
  writeFileSync(join(root, "run-tests.js"), RUNNER);
  writeFileSync(join(root, "docs", "standards", "constitution.md"), CONSTITUTION);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "sandbox", version: "1.0.0", scripts: { test: "node run-tests.js" } }, null, 2),
  );
  return root;
}

function fakePi() {
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
  return {
    pi,
    // Drains out-of-band dispatch: it is no longer awaited inside the
    // handler, because Pi kills handlers at 30s and a real fix provider
    // spawns an agent subprocess.
    fire: async (n: string, e: unknown) => {
      const r = await handlers.get(n)?.(e);
      await drainDispatches();
      return r;
    },
  };
}

/** Runs the sandbox suite exactly as a developer would. */
function runSuiteForReal(root: string): { code: number; output: string } {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const r = spawnSync("node", ["run-tests.js"], { cwd: root, encoding: "utf8" });
  return { code: r.status ?? 1, output: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("break a test, run it, and follow the event all the way through", () => {
  jest.setTimeout(30000);

  it("the deliberately broken test really fails before anything runs", () => {
    const root = sandbox();
    const before = runSuiteForReal(root);
    expect(before.code).toBe(1);
    expect(before.output).toContain("1 failed");
  });

  it("the failure fires the event, the loop repairs the test, and the constitution is updated", async () => {
    const root = sandbox();

    // 1. The real, currently-failing suite.
    const before = runSuiteForReal(root);
    expect(before.code).toBe(1);

    const change: ConstitutionChange = {
      behaviorName: "fix-failing-test",
      rationale: "a fix is only trustworthy if the suite could have failed",
      diff: "2. **Auto-applied fixes must be verified by a suite that can fail**",
    };

    const approvals: string[] = [];
    const host: ApprovalHost = {
      hasUI: true,
      async confirm(title: string) {
        approvals.push(title);
        return true;
      },
    };

    let merged = false;
    const instance = createActivate({
      // Stands in for the agent proposing a patch.
      proposeFix: () => ({
        writes: [{ path: "src/math.js", contents: FIXED, mutationClass: "artifact.write" }],
      }),
      proposeConstitutionChange: () => change,
      approvalHost: host,
      openPullRequest: (c) => {
        // The sanctioned route: the behavior itself may not write
        // constitution.md (it is a protected path). Landing the change
        // is a human-approved merge, modelled here.
        const file = join(root, "docs", "standards", "constitution.md");
        writeFileSync(file, readFileSync(file, "utf8") + c.diff + "\n");
        merged = true;
        return { url: "https://example.test/pr/7", branch: "ensemble/constitution/7" };
      },
    });

    process.chdir(root);
    const { pi, fire } = fakePi();
    instance.activate(pi);
    expect(instance.lastActivation()!.loaded).toEqual(["fix-failing-test"]);

    // 2. Pi reports the real failing run.
    await fire("tool_result", {
      type: "tool_result",
      toolCallId: "run-1",
      toolName: "bash",
      input: { command: "npm test" },
      content: [{ type: "text", text: before.output }],
      isError: true,
    });

    // 3. The event fired and reached a real invoker, not a stub.
    const types = instance.sink.drain().map((e) => e.event.type);
    expect(types).toContain("runtime.tool_call.completed");
    expect(types).toContain("test.failure.observed");

    expect(instance.runRecords).toHaveLength(1);
    const record = instance.runRecords[0];
    expect(record.behavior).toBe("fix-failing-test");

    // 4. The auto-fix loop ran the REAL suite and accepted the fix.
    expect(record.outcome?.status).toBe("accepted");
    expect(readFileSync(join(root, "src", "math.js"), "utf8")).toBe(FIXED);

    // 5. The test is actually fixed, verified by running it again.
    const after = runSuiteForReal(root);
    expect(after.code).toBe(0);
    expect(after.output).toContain("1 passed");

    // 6. The constitution was updated through the approval gate.
    expect(approvals).toEqual(["Propose constitution change"]);
    expect(record.constitution?.status).toBe("proposed");
    expect(merged).toBe(true);
    expect(readFileSync(join(root, "docs", "standards", "constitution.md"), "utf8")).toContain(
      "verified by a suite that can fail",
    );
  });

  it("without approval the constitution is left alone and the fix still lands", async () => {
    const root = sandbox();
    const before = runSuiteForReal(root);

    let opened = false;
    const instance = createActivate({
      proposeFix: () => ({
        writes: [{ path: "src/math.js", contents: FIXED, mutationClass: "artifact.write" }],
      }),
      proposeConstitutionChange: () => ({
        behaviorName: "fix-failing-test",
        rationale: "r",
        diff: "should not land",
      }),
      // No approvalHost: headless, so the gate fails closed.
      openPullRequest: () => {
        opened = true;
        return { url: "x", branch: "y" };
      },
    });

    process.chdir(root);
    const { pi, fire } = fakePi();
    instance.activate(pi);

    await fire("tool_result", {
      type: "tool_result",
      toolCallId: "run-2",
      toolName: "bash",
      input: { command: "npm test" },
      content: [{ type: "text", text: before.output }],
      isError: true,
    });

    const record = instance.runRecords[0];
    expect(record.outcome?.status).toBe("accepted");
    expect(record.constitution?.status).toBe("declined");
    expect(opened).toBe(false);
    expect(readFileSync(join(root, "docs", "standards", "constitution.md"), "utf8")).not.toContain("should not land");
  });
});
