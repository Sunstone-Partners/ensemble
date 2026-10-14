/**
 * Shared TypeScript interfaces for the Pi generator.
 *
 * Defines input shapes (CommandYaml, AgentYaml), output shapes (TransformResult),
 * and runtime configuration (GeneratorOptions).
 *
 * @module ensemble-pi/types
 */

export interface GeneratorOptions {
  dryRun: boolean;
  verbose: boolean;
  validate: boolean;
  /** Monorepo root path. Defaults to process.cwd(). */
  sourceRoot: string;
  /** packages/pi path. Defaults to __dirname/.. */
  outputRoot: string;
}

export interface Phase {
  id: number;
  name: string;
  steps: Step[];
}

export interface Step {
  id: number;
  title: string;
  description?: string;
  /**
   * Actions are declared as strings in YAML but js-yaml may parse unquoted
   * "key: value" entries as single-key objects. Use `unknown[]` to accept
   * both and coerce to string during rendering.
   */
  actions?: unknown[];
}

export interface CommandParameter {
  name: string;
  type?: string;
  required?: boolean;
  default?: unknown;
  description?: string;
}

/** One entry in a dispatcher command's dispatch.subcommands[] list. */
export interface DispatchSubcommand {
  /** First-argument token the user types to select this subcommand. */
  keyword: string;
  /** Referenced sibling command's metadata.name with "ensemble:" stripped. */
  ref: string;
  /** Optional override; defaults to the referenced command's own description. */
  description?: string;
}

export interface CommandYaml {
  metadata: {
    name: string;
    description: string;
    version: string;
  };
  workflow: {
    phases: Phase[];
  };
  constraints?: string[];
  mission?: {
    summary?: string;
  };
  parameters?: CommandParameter[];
  /** Marks this command as a thin dispatcher routing to sibling commands. */
  dispatch?: {
    subcommands: DispatchSubcommand[];
  };
}

export interface AgentYaml {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  /** Body content after frontmatter */
  body?: string;
}

export interface TransformResult {
  sourcePath: string;
  outputPath: string;
  content: string;
  type: 'command' | 'agent' | 'skill' | 'agents-md' | 'lib';
}
