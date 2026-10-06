import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface DispatchSubcommand {
  keyword: string;
  ref: string;
  description?: string;
}

interface DispatcherYaml {
  dispatch?: {
    subcommands?: DispatchSubcommand[];
  };
}

/**
 * Reads a dispatcher command YAML's `dispatch.subcommands[]` list -- the
 * same field schemas/command-yaml-schema.json defines and every generator
 * (Claude Code/Pi/Codex/OpenCode markdown output) already renders from.
 * Reusing it here, rather than hand-duplicating the keyword/description
 * list in TypeScript, keeps one source of truth.
 *
 * Returns an empty array -- never throws -- when the file is missing,
 * unparsable, or has no dispatch field. This only backs completion-dropdown
 * sugar; a read/parse failure must degrade to "no suggestions", not crash
 * command registration or the extension itself.
 */
export function loadDispatchSubcommands(repoRoot: string, yamlRelPath: string): DispatchSubcommand[] {
  try {
    const absPath = resolve(repoRoot, yamlRelPath);
    if (!existsSync(absPath)) return [];
    const parsed = yaml.load(readFileSync(absPath, "utf8")) as DispatcherYaml | undefined;
    return parsed?.dispatch?.subcommands ?? [];
  } catch {
    return [];
  }
}

export interface RegisterDispatcherCommandOptions {
  /**
   * Hyphenated native command name, e.g. "ensemble-prd". Deliberately not
   * colon-separated like the markdown-prompt commands (`ensemble:prd`):
   * colons are reserved in Windows paths and have caused problems there.
   */
  name: string;
  /** Repo-root-relative path to the dispatcher's own YAML source. */
  yamlRelPath: string;
  /**
   * The existing, colon-named markdown-prompt command this forwards into
   * (bare, no leading slash -- e.g. "ensemble:prd").
   */
  forwardTo: string;
  description: string;
}

/**
 * Registers a native command whose only job is to give a markdown-prompt
 * dispatcher command (prd/trd/issue) the same live, space-triggered
 * subcommand completion /mcp has -- a capability markdown prompts cannot
 * reach on their own, since `getArgumentCompletions` is reachable only
 * through `pi.registerCommand`, not through the generic prompts/skills
 * loading mechanism every ensemble command (including these dispatchers)
 * otherwise uses.
 *
 * The handler does not duplicate any dispatch/routing logic: it forwards
 * the typed text, verbatim, into the existing, already-tested
 * `/ensemble:<name>` markdown command via `sendUserMessage`, which remains
 * the single source of truth for actual subcommand routing (including its
 * own "print the keyword table and halt" behavior on empty/unmatched
 * input) -- this registration only ever adds the completion dropdown.
 *
 * This extension loads in every session, in every repo the host opens
 * (it is installed globally, not scoped to this monorepo), so a no-op
 * skip -- not registration -- is correct when `opts.yamlRelPath` doesn't
 * exist under `repoRoot`: an unrelated repo must never see `ensemble-prd`
 * et al. in its command list just because this extension happened to load.
 */
export function registerDispatcherCommand(
  pi: ExtensionAPI,
  repoRoot: string,
  opts: RegisterDispatcherCommandOptions,
): void {
  if (!existsSync(resolve(repoRoot, opts.yamlRelPath))) return;
  pi.registerCommand(opts.name, {
    description: opts.description,
    getArgumentCompletions: (argumentPrefix: string) => {
      const prefix = argumentPrefix.trim().toLowerCase();
      return loadDispatchSubcommands(repoRoot, opts.yamlRelPath)
        .filter((s) => s.keyword.toLowerCase().startsWith(prefix))
        .map((s) => ({
          value: s.keyword,
          label: s.keyword,
          description: s.description,
        }));
    },
    handler: async (args: string, _ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      pi.sendUserMessage(trimmed ? `/${opts.forwardTo} ${trimmed}` : `/${opts.forwardTo}`, {
        expandPromptTemplates: true,
      });
    },
  });
}
