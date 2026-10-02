/**
 * Behavior package manifest schema (source:
 * docs/architecture/ensemble-behavior-runtime-plan.md §7), matching a
 * real `behavior.yaml` file's shape exactly. `capabilities.tools` and
 * `capabilities.mutation_classes` are deliberately separate lists — a
 * tool grant never implies mutation authority (TRD-011/AC-011-1).
 */

/**
 * One condition per payload field. `glob` matches a `/`-separated
 * repo-relative path (`*`, `?`, `**`); it is how an `artifact.changed`
 * trigger names a set of files (TRD-001), and its semantics live in
 * `path-glob.ts` so the matcher and the adapter cannot disagree.
 */
export interface BehaviorTriggerPredicate {
  [field: string]: { matches?: string; not?: unknown; equals?: unknown; glob?: string };
}

export interface BehaviorTrigger {
  event_type: string;
  predicate?: BehaviorTriggerPredicate;
}

export type BehaviorPolicyMode = "propose" | "auto" | "shadow";

export interface BehaviorPolicy {
  mode: BehaviorPolicyMode;
  timeout: string;
}

export interface BehaviorCapabilities {
  tools: string[];
  mutation_classes: string[];
  /**
   * Typed commands this behavior may request (REQ-CQRS-001).
   *
   * A third list rather than a reuse of `tools`, because the three authorities
   * are genuinely independent: holding `bash` must not imply authority to run
   * `fix.apply`, and holding `artifact.write` must not imply the right to ask
   * for it through any particular command (REQ-SAFE-003). Absent means the
   * behavior may call no commands — the safe default for every manifest
   * written before commands existed.
   */
  commands?: string[];
}

export interface BehaviorExecution {
  /**
   * Legacy identifier naming the behavior's execution graph. Retained so
   * existing manifests keep validating (REQ-BEH-005); it selects nothing.
   * A manifest that declares `workflow` is interpreted from that data.
   */
  graph: string;
  /**
   * The declarative workflow (REQ-BEH-002). When present, the shared
   * interpreter runs these steps and no runtime branch is consulted. Typed as
   * `unknown` here on purpose: the workflow validator owns its shape, and
   * letting the manifest type assert a shape nothing checked is how invalid
   * package data reaches an interpreter.
   */
  workflow?: unknown;
  /**
   * The command this package's own repository uses to run its full
   * test suite (e.g. `npm test`, `mix test`, `pytest`).
   *
   * Required for `mode: auto` (TRD-010): an auto-applying behavior
   * re-verifies its own fix, and guessing the command from the
   * ambient package manager would silently do the wrong thing in any
   * non-npm repository. Optional for `propose`/`shadow`, which never
   * apply a fix themselves.
   */
  test_command?: string;
}

export interface BehaviorMetadata {
  name: string;
  version: string;
  /** Immutable digest of the manifest content (TRD-011/AC-011-2), excluding this field itself. */
  digest?: string;
  /**
   * Digest over the manifest AND every package asset it references
   * (REQ-BEH-003). Prompt text is editable without a rebuild, so "what ran"
   * would otherwise be unidentifiable: two runs with the same manifest
   * digest could have used different prompts. Computed at load time and
   * reported by status output; it is not declared in the YAML.
   */
  packageDigest?: string;
}

export interface BehaviorManifest {
  api_version: string;
  kind: "Behavior";
  metadata: BehaviorMetadata;
  trigger: BehaviorTrigger;
  policy: BehaviorPolicy;
  capabilities: BehaviorCapabilities;
  execution: BehaviorExecution;
  outcomes: string[];
}

export interface BehaviorPackage {
  behaviors: BehaviorManifest[];
}
