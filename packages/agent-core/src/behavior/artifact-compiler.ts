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
}

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

  return { behaviorName, commandName, promptMarkdown, skillMarkdown, toolNames };
}
