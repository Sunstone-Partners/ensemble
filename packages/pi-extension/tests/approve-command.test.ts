import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * /ensemble-approve, exercised through the real createActivate() (br-9uqd).
 *
 * Why a test and not just the live probe: a `-p` session cannot invoke a
 * slash command, so the live run could only ever prove the REVERT half. The
 * approve half -- the part that ends the maintainer's lockout -- would
 * otherwise ship unexercised.
 *
 * The write boundary is driven by real files in a real git repository, and
 * the command handler is the one registered by production activation. Only
 * the Pi host is faked, because there is no host to run against in a test.
 */

const dirs: string[] = [];
const originalCwd = process.cwd();
afterAll(() => {
  process.chdir(originalCwd);
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const GUARD = join("packages", "agent-core", "src", "behavior", "mutation-guard.ts");

function repoWithGuardrail(): string {
  const root = mkdtempSync(join(tmpdir(), "approve-cmd-"));
  dirs.push(root);
  mkdirSync(join(root, "packages", "agent-core", "src", "behavior"), { recursive: true });
  writeFileSync(join(root, GUARD), "export const original = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
  return root;
}
function harness() {
  // Handlers are stored per event name as a LIST, not a Map entry.
  //
  // A Map keyed by name silently drops all but the last registration, and
  // this extension registers TWO tool_result handlers: the write boundary in
  // extension.ts and the event translator in session.ts. Overwriting meant
  // the boundary handler never ran and the test failed against working code.
  const handlers = new Map<string, ((e: unknown) => Promise<unknown> | unknown)[]>();
  const commands = new Map<string, { handler: (args: unknown, ctx: unknown) => Promise<void> }>();
  const notices: string[] = [];
  const pi = {
    registerCommand: (name: string, o: unknown) =>
      commands.set(name, o as { handler: (a: unknown, c: unknown) => Promise<void> }),
    registerTool: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => false,
    sendUserMessage: () => undefined,
    on: (name: string, h: (e: unknown) => Promise<unknown> | unknown) => {
      const list = handlers.get(name) ?? [];
      list.push(h);
      handlers.set(name, list);
      return () => undefined;
    },
  } as unknown as ExtensionAPI;

  const ctx = { hasUI: true, ui: { notify: (t: string) => notices.push(t) } };
  return {
    pi,
    notices,
    // Fires every registered handler and returns the first result that is
    // defined, which is how the host treats a result-rewriting handler.
    fire: async (n: string, e: unknown) => {
      let out: unknown;
      for (const h of handlers.get(n) ?? []) {
        const r = await h(e);
        if (r !== undefined && out === undefined) out = r;
      }
      return out;
    },
    run: async (name: string, args: unknown) => commands.get(name)?.handler(args, ctx),
    registered: () => [...commands.keys()],
  };
}

describe("/ensemble-approve", () => {
  it("re-applies a reverted guardrail change, and only when asked", async () => {
    const root = repoWithGuardrail();
    process.chdir(root);
    const { createActivate } = await import("../src/extension");
    const h = harness();
    createActivate().activate(h.pi);

    expect(h.registered()).toContain("ensemble-approve");

    // A protected write, then the boundary check that reverts it.
    writeFileSync(join(root, GUARD), "export const original = 1;\n// maintainer edit\n");
    const result = (await h.fire("tool_result", {})) as
      | { isError: boolean; content: { text: string }[] }
      | undefined;

    // Reverted, and the model was told how the USER can reinstate it.
    expect(readFileSync(join(root, GUARD), "utf8")).not.toContain("maintainer edit");
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain("/ensemble-approve");

    // Listing is non-destructive and shows the pending change.
    await h.run("ensemble-approve", "");
    expect(h.notices.join("\n")).toContain(GUARD);

    // Approving re-applies it.
    const id = /ensemble-approve (\d+)/.exec(result!.content[0].text)![1];
    await h.run("ensemble-approve", id);
    expect(readFileSync(join(root, GUARD), "utf8")).toContain("maintainer edit");

    // And it now survives the boundary, because it is the new baseline.
    await h.fire("tool_result", {});
    expect(readFileSync(join(root, GUARD), "utf8")).toContain("maintainer edit");
  });

  it("an approval is consumed, so it cannot bless a later edit", async () => {
    const root = repoWithGuardrail();
    process.chdir(root);
    const { createActivate } = await import("../src/extension");
    const h = harness();
    createActivate().activate(h.pi);

    writeFileSync(join(root, GUARD), "export const original = 1;\n// first\n");
    const first = (await h.fire("tool_result", {})) as { content: { text: string }[] };
    const id = /ensemble-approve (\d+)/.exec(first.content[0].text)![1];
    await h.run("ensemble-approve", id);
    expect(readFileSync(join(root, GUARD), "utf8")).toContain("first");

    // Replaying the SAME id must not re-apply anything after a new edit.
    writeFileSync(join(root, GUARD), "export const original = 1;\n// second\n");
    await h.fire("tool_result", {});
    await h.run("ensemble-approve", id);

    const final = readFileSync(join(root, GUARD), "utf8");
    expect(final).toContain("first");
    expect(final).not.toContain("second");
  });

  it("an unknown id changes nothing", async () => {
    const root = repoWithGuardrail();
    process.chdir(root);
    const { createActivate } = await import("../src/extension");
    const h = harness();
    createActivate().activate(h.pi);

    await h.run("ensemble-approve", "999");

    expect(h.notices.join("\n")).toContain("No quarantined change");
    expect(readFileSync(join(root, GUARD), "utf8")).toBe("export const original = 1;\n");
  });
});
