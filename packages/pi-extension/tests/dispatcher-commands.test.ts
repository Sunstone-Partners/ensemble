import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadDispatchSubcommands, registerDispatcherCommand } from "../src/dispatcher-commands";

/**
 * /ensemble-prd, /ensemble-trd, /ensemble-issue's native completion layer.
 *
 * This extension loads in every repo the host opens (it is installed
 * globally, not scoped to this monorepo), so the no-op-when-absent behavior
 * is exercised as deliberately as the present-and-working path -- an
 * unrelated repo must never see these commands just because the extension
 * loaded there.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function fixtureRepo(yamlRelPath: string, yamlContent: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "dispatcher-cmd-"));
  dirs.push(root);
  if (yamlContent !== null) {
    mkdirSync(join(root, ...yamlRelPath.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(root, yamlRelPath), yamlContent);
  }
  return root;
}

const ISSUE_YAML = `metadata:
  name: ensemble:issue
dispatch:
  subcommands:
    - keyword: fix
      ref: fix-issue
      description: Fix a bug or small issue end to end
    - keyword: list
      ref: list-issue
      description: List open Beads issues via br/bv
`;

describe("loadDispatchSubcommands", () => {
  const YAML_PATH = "packages/development/commands/issue.yaml";

  it("parses dispatch.subcommands from a real YAML file", () => {
    const root = fixtureRepo(YAML_PATH, ISSUE_YAML);
    expect(loadDispatchSubcommands(root, YAML_PATH)).toEqual([
      { keyword: "fix", ref: "fix-issue", description: "Fix a bug or small issue end to end" },
      { keyword: "list", ref: "list-issue", description: "List open Beads issues via br/bv" },
    ]);
  });

  it("returns an empty array when the file doesn't exist", () => {
    const root = fixtureRepo(YAML_PATH, null);
    expect(loadDispatchSubcommands(root, YAML_PATH)).toEqual([]);
  });

  it("returns an empty array when the YAML has no dispatch field", () => {
    const root = fixtureRepo(YAML_PATH, "metadata:\n  name: ensemble:fix-issue\n");
    expect(loadDispatchSubcommands(root, YAML_PATH)).toEqual([]);
  });

  it("returns an empty array, not a throw, for unparsable YAML", () => {
    const root = fixtureRepo(YAML_PATH, "metadata: [unterminated\n");
    expect(loadDispatchSubcommands(root, YAML_PATH)).toEqual([]);
  });
});

function harness() {
  const commands = new Map<
    string,
    { description?: string; getArgumentCompletions?: (p: string) => unknown; handler: (a: string, c: unknown) => Promise<void> }
  >();
  const sent: { content: string; options?: unknown }[] = [];
  const pi = {
    registerCommand: (name: string, o: unknown) => commands.set(name, o as never),
    sendUserMessage: (content: unknown, options?: unknown) => {
      sent.push({ content: String(content), options });
    },
  } as unknown as ExtensionAPI;
  return { pi, commands, sent };
}

describe("registerDispatcherCommand", () => {
  const YAML_PATH = "packages/development/commands/issue.yaml";

  it("does not register when the backing YAML doesn't exist in this repo", () => {
    const root = fixtureRepo(YAML_PATH, null);
    const { pi, commands } = harness();
    registerDispatcherCommand(pi, root, {
      name: "ensemble-issue",
      yamlRelPath: YAML_PATH,
      forwardTo: "ensemble:issue",
      description: "d",
    });
    expect(commands.size).toBe(0);
  });

  it("registers with the given name and description when the backing YAML exists", () => {
    const root = fixtureRepo(YAML_PATH, ISSUE_YAML);
    const { pi, commands } = harness();
    registerDispatcherCommand(pi, root, {
      name: "ensemble-issue",
      yamlRelPath: YAML_PATH,
      forwardTo: "ensemble:issue",
      description: "Dispatch to an issue-management subcommand",
    });
    expect(commands.get("ensemble-issue")?.description).toBe("Dispatch to an issue-management subcommand");
  });

  it("getArgumentCompletions returns every subcommand for an empty prefix, filtered for a partial one", () => {
    const root = fixtureRepo(YAML_PATH, ISSUE_YAML);
    const { pi, commands } = harness();
    registerDispatcherCommand(pi, root, {
      name: "ensemble-issue",
      yamlRelPath: YAML_PATH,
      forwardTo: "ensemble:issue",
      description: "d",
    });
    const getArgumentCompletions = commands.get("ensemble-issue")?.getArgumentCompletions as (p: string) => {
      value: string;
      label: string;
      description?: string;
    }[];

    expect(getArgumentCompletions("")).toEqual([
      { value: "fix", label: "fix", description: "Fix a bug or small issue end to end" },
      { value: "list", label: "list", description: "List open Beads issues via br/bv" },
    ]);
    expect(getArgumentCompletions("li")).toEqual([
      { value: "list", label: "list", description: "List open Beads issues via br/bv" },
    ]);
    expect(getArgumentCompletions("zz")).toEqual([]);
  });

  it("handler forwards the typed text verbatim into the colon-named markdown command, with prompt-template expansion on", async () => {
    const root = fixtureRepo(YAML_PATH, ISSUE_YAML);
    const { pi, commands, sent } = harness();
    registerDispatcherCommand(pi, root, {
      name: "ensemble-issue",
      yamlRelPath: YAML_PATH,
      forwardTo: "ensemble:issue",
      description: "d",
    });
    const handler = commands.get("ensemble-issue")!.handler;

    await handler("list", {});
    expect(sent).toEqual([{ content: "/ensemble:issue list", options: { expandPromptTemplates: true } }]);
  });

  it("handler forwards with no trailing text when invoked with empty args", async () => {
    const root = fixtureRepo(YAML_PATH, ISSUE_YAML);
    const { pi, commands, sent } = harness();
    registerDispatcherCommand(pi, root, {
      name: "ensemble-issue",
      yamlRelPath: YAML_PATH,
      forwardTo: "ensemble:issue",
      description: "d",
    });
    const handler = commands.get("ensemble-issue")!.handler;

    await handler("   ", {});
    expect(sent).toEqual([{ content: "/ensemble:issue", options: { expandPromptTemplates: true } }]);
  });

});
