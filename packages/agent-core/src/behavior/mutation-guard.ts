import { CompiledBehaviorPackage } from "./compiler";

/**
 * The single authorization chokepoint for mutations (TRD-002).
 *
 * Before this existed, `CompiledBehaviorPackage.hasMutationAuthority()`
 * was defined with zero call sites: `capabilities.mutation_classes`
 * was parsed, validated, compiled, and then never consulted by
 * anything. Declaring a mutation class had no runtime consequence, so
 * the governance model was documentation rather than enforcement.
 *
 * Everything that mutates state must route through `authorize()`.
 * Scattering equivalent checks across individual call sites is exactly
 * the failure mode this replaces — one reachable chokepoint is
 * auditable; N optional wrappers are not.
 *
 * `policy.mode` branching (propose/auto/shadow) is deliberately NOT
 * handled here yet — that is TRD-017. This class answers only the
 * mutation-class question, and reports via `enforcementActive` that it
 * is in fact wired, so the loader can fail closed (TRD-004).
 */

export type MutationKind = "write" | "delete" | "commit";

export interface MutationRequest {
  /** Declared class of the mutation, e.g. "artifact.write". */
  mutationClass: string;
  /** Target path, when the mutation is path-scoped. */
  path?: string;
  kind: MutationKind;
}

export type MutationDecision =
  | { allowed: true }
  | { allowed: false; reason: string; escalate: boolean };

export interface MutationGuard {
  /**
   * True when this guard is actually consulted at a real mutation
   * boundary. The loader refuses `mode: auto` manifests when this is
   * false rather than degrading to unenforced auto-apply (TRD-004).
   */
  readonly enforcementActive: boolean;
  authorize(request: MutationRequest): MutationDecision;
}

export function createMutationGuard(compiled: CompiledBehaviorPackage): MutationGuard {
  const behaviorName = compiled.manifest.metadata.name;
  const declared = compiled.manifest.capabilities.mutation_classes;

  return {
    enforcementActive: true,
    authorize(request: MutationRequest): MutationDecision {
      if (!request.mutationClass) {
        return {
          allowed: false,
          reason: `mutation denied for behavior "${behaviorName}": no mutation class declared on the request`,
          escalate: false,
        };
      }

      // Deliberately consults hasMutationAuthority() and never
      // hasTool(): a bash grant must never be mistakable for
      // artifact-write authority (AC-011-3). A behavior that holds
      // `bash` but not `artifact.write` is denied here even though it
      // could physically shell out — the denial is what makes the
      // separation real rather than nominal.
      if (!compiled.hasMutationAuthority(request.mutationClass)) {
        return {
          allowed: false,
          reason:
            `mutation class "${request.mutationClass}" is not granted to behavior "${behaviorName}" ` +
            `(capabilities.mutation_classes: [${declared.join(", ")}])`,
          escalate: true,
        };
      }

      return { allowed: true };
    },
  };
}
