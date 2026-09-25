import { CompiledBehaviorPackage } from "./compiler";

/**
 * A compiled behavior's provider-neutral output artifacts: a prompt
 * template (rendered from trigger/policy/outcomes), a skill document
 * (SKILL.md-shaped markdown, matching packages/pi's own skill
 * conventions), and governed tool descriptors reusing agent-core's
 * existing ToolDescriptor contract (TRD-003/TRD-005) — no provider-
 * specific registration call lives here; that belongs to the adapter
 * loading these artifacts (see pi-extension/src/behavior-loader.ts).
 */
export interface CompiledBehaviorArtifacts {
  behaviorName: string;
  commandName: string;
  promptMarkdown: string;
  skillMarkdown: string;
  toolNames: string[];
  /**
   * Declared in `capabilities.tools` but resolvable to nothing: neither a
   * registered ToolDescriptor nor a known native host tool. Previously such
   * names were filtered out silently, so a behavior could declare a
   * capability it could never exercise and look correctly configured.
   * `bash.test` sat in investigate-test-failure's grant list this way --
   * the behavior meant to run tests and had no means to run anything.
   */
  unresolvedTools: string[];
  /** TRD-009/AC-012-1: the behavior's own declared test command, never an npm guess. */
  testCommand?: string;
}

/**
 * Host-provided tools that legitimately have no ToolDescriptor of ours.
 * A declared tool is only "unresolved" when it is neither registered nor
 * one of these -- otherwise every behavior would warn about `read`, and a
 * noisy warning is an ignored warning.
 *
 * EVERY NAME HERE HAS A SOURCE. Do not add guesses: a wrong entry hides a
 * real phantom, and a missing entry invents a false one.
 *
 * Group 1 -- Pi's typed ToolCallEvent union, read from
 * @earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:790.
 * Authoritative for the Pi host.
 */
const PI_TYPED_NATIVE_TOOLS = [
  "bash",
  "powershell",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
] as const;

/**
 * Group 2 -- host tools not present in Pi's typed union. These arrive as
 * CustomToolCallEvent (toolName: string), so no type declares them, yet
 * they are genuinely available and must not be reported as unresolved.
 *
 * ADMISSION RULE: a name enters this list ONLY when it has been seen
 * dispatching as `toolName` in a real session's runtime log. Both entries
 * below were observed in .ensemble/runtime-log.jsonl on 2026-09-25.
 *
 * task/todo/replace/hashline/skill were briefly added here on the strength
 * of appearing as quoted strings in omp's bundled cli.js, and then removed:
 * a bare string literal in a minified bundle does not establish that a name
 * is a registered tool. An authoritative registry is not extractable -- omp
 * ships minified and the tool definitions do not survive in a greppable
 * shape -- so raw frequency was the only "evidence" available, and it is
 * not evidence.
 *
 * The asymmetry decides the default: an unlisted host tool produces a
 * warning that is merely wrong and self-correcting once observed, whereas a
 * wrongly-listed name permanently hides a real phantom capability -- the
 * exact defect this whole mechanism exists to surface. So when in doubt,
 * leave it out.
 */
const OBSERVED_HOST_TOOLS = ["glob", "learn"] as const;

const NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...PI_TYPED_NATIVE_TOOLS,
  ...OBSERVED_HOST_TOOLS,
]);

export function compileBehaviorToArtifacts(
  compiled: CompiledBehaviorPackage,
  availableTools: readonly { name: string }[] = [],
): CompiledBehaviorArtifacts {
  const { manifest } = compiled;
  const behaviorName = manifest.metadata.name;
  const commandName = behaviorName.replace(/[^a-z0-9-]/gi, "-");

  const promptMarkdown = [
    `# ${behaviorName}`,
    "",
    `Trigger: \`${manifest.trigger.event_type}\``,
    `Mode: \`${manifest.policy.mode}\` (timeout: \`${manifest.policy.timeout}\`)`,
    "",
    "## Outcomes",
    "",
    ...manifest.outcomes.map((outcome) => `- ${outcome}`),
  ].join("\n");

  const skillMarkdown = [
    "---",
    `name: ${commandName}`,
    `description: Behavior package "${behaviorName}" compiled from behavior.yaml (digest ${compiled.digest.slice(0, 12)})`,
    "---",
    "",
    promptMarkdown,
    "",
    "## Governed tools",
    "",
    ...manifest.capabilities.tools.map((tool) => `- \`${tool}\``),
  ].join("\n");

  const availableToolNames = new Set(availableTools.map((tool) => tool.name));
  const toolNames = manifest.capabilities.tools.filter((tool) => availableToolNames.has(tool));
  const unresolvedTools = manifest.capabilities.tools.filter(
    (tool) => !availableToolNames.has(tool) && !NATIVE_TOOL_NAMES.has(tool),
  );

  return {
    behaviorName,
    commandName,
    promptMarkdown,
    skillMarkdown,
    toolNames,
    unresolvedTools,
    testCommand: manifest.execution.test_command,
  };
}
