import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * That the DEFAULT provider is wired, not merely available.
 *
 * This is the exact gap that made step 3 unreachable: the machinery existed
 * and was well tested, but production called createActivate() with no
 * options, proposeConstitutionChange defaulted to undefined, and the whole
 * path was reachable only from tests that injected one. `proposeFix` had the
 * same defect and the same symptom ("fix provider: NOT configured").
 *
 * So this asserts production wiring, using the status command's own report
 * rather than reaching into internals.
 */

const dirs: string[] = [];
const originalCwd = process.cwd();
afterAll(() => {
  process.chdir(originalCwd);
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const BEHAVIOR = `api_version: ensemble.sunstone.dev/v1
kind: Behavior
metadata:
  name: fix-failing-test
  version: 1.0.0
trigger:
  event_type: test.failure.observed
policy:
  mode: auto
  timeout: 30m
capabilities:
  tools:
    - read
  mutation_classes: []
execution:
  graph: fix-failing-test
  test_command: npm test
outcomes:
  - test.failure.fixed
`;

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "default-wiring-"));
  dirs.push(root);
  const dir = join(root, ".ensemble", "behaviors", "fix-failing-test");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "behavior.yaml"), BEHAVIOR);
  mkdirSync(join(root, "docs", "standards"), { recursive: true });
  writeFileSync(join(root, "docs", "standards", "constitution.md"), "# Constitution\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
  return root;
}

function harness() {
  const commands = new Map<string, { handler: (a: unknown, c: unknown) => Promise<void> }>();
  const notices: string[] = [];
  const pi = {
    registerCommand: (name: string, o: unknown) =>
      commands.set(name, o as { handler: (a: unknown, c: unknown) => Promise<void> }),
    registerTool: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => false,
    // #94 made the rollback notice a REQUIRED capability: without it a
    // rolled-back fix is silent, so activate() refuses to start.
    sendMessage: (_m: unknown, _o?: unknown) => undefined,
    sendUserMessage: () => undefined,
    on: () => () => undefined,
  } as unknown as ExtensionAPI;
  const ctx = { hasUI: true, ui: { notify: (t: string) => notices.push(t) } };
  return {
    pi,
    notices,
    run: (name: string) => commands.get(name)?.handler("", ctx),
  };
}

describe("production wiring for step 3", () => {
  it("configures a rule provider with no options supplied", async () => {
    const root = repo();
    process.chdir(root);
    const { createActivate } = await import("../src/extension");
    const h = harness();

    // Production calls this with NO options at all.
    createActivate().activate(h.pi);
    await h.run("ensemble-status");

    const status = h.notices.join("\n");
    expect(status).toContain("rule provider    : configured (agent subprocess)");
    expect(status).not.toContain("rule provider    : NOT configured");
    // The fix provider's line used to hardcode the word "configured" and
    // never look at the provider in use, so it would have gone on claiming
    // "configured (agent subprocess)" with its default wiring deleted --
    // the same lie the rule provider's line told. Both are checked here so
    // neither can regress silently.
    expect(status).toContain("fix provider     : configured (agent subprocess)");
    expect(status).not.toContain("fix provider     : NOT configured");
  });

  it("reports an injected provider as injected, so the status cannot lie", async () => {
    const root = repo();
    process.chdir(root);
    const { createActivate } = await import("../src/extension");
    const h = harness();

    createActivate({ proposeConstitutionChange: () => undefined }).activate(h.pi);
    await h.run("ensemble-status");

    expect(h.notices.join("\n")).toContain("rule provider    : configured (injected)");
  });
});
