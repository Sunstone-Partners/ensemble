/**
 * Behavior package manifest schema (source:
 * docs/architecture/ensemble-behavior-runtime-plan.md §7), matching a
 * real `behavior.yaml` file's shape exactly. `capabilities.tools` and
 * `capabilities.mutation_classes` are deliberately separate lists — a
 * tool grant never implies mutation authority (TRD-011/AC-011-1).
 */

export interface BehaviorTriggerPredicate {
  [field: string]: { matches?: string; not?: unknown; equals?: unknown };
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
}

export interface BehaviorExecution {
  graph: string;
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
