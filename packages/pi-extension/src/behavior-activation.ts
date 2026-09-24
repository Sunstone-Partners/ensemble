import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ToolDescriptor,
  compile,
  compileBehaviorToArtifacts,
  discoverBehaviorPackages,
  ACTIVATION_SEARCH_ROOTS,
} from "@sunstone-partners/ensemble-agent-core";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadCompiledBehavior } from "./behavior-loader";

/**
 * Resolves the repository root by walking up from `startDir` to the
 * nearest ancestor containing a `.git` entry.
 *
 * Pi's `ExtensionAPI` exposes no workspace-root accessor at activation
 * time (`cwd` lives on the per-call `ExtensionContext`), so activation
 * would otherwise trust the process launch directory. If Pi were
 * launched from a subdirectory, discovery would silently find zero
 * packages and every governance guarantee would quietly stop applying
 * — structurally present but unreachable, the exact failure this
 * package exists to eliminate. Failing to find a root falls back to
 * `startDir` rather than throwing, so a non-git checkout still
 * activates.
 *
 * TRD-013 (PR 2) makes the search root explicitly configurable.
 */
export function resolveRepoRoot(startDir: string): string {
  let current = startDir;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return startDir;
    current = parent;
  }
}

export interface BehaviorActivationResult {
  discovered: number;
  loaded: string[];
  skipped: { behaviorId: string; reason: string }[];
}

/**
 * Activates the behavior pipeline for a live Pi session (TRD-005).
 *
 * This closes the gap that made every other governance guarantee in
 * this package unreachable: `discoverBehaviorPackages`,
 * `compileBehaviorToArtifacts` and `loadCompiledBehavior` previously
 * had no call sites outside tests. Because `wireToolGrantEnforcement`
 * is invoked from inside `loadCompiledBehavior`, the manifest-driven
 * blocking of native tools (bash/read/write) never ran in a real
 * session — it was unit-tested code that production never executed.
 *
 * Activation is deliberately non-fatal per package: one malformed
 * behavior must not prevent a session from starting (AC-009-3), but
 * every skipped package is reported so the failure is visible rather
 * than silent.
 */

export function activateBehaviorPipeline(
  pi: ExtensionAPI,
  rootDir: string,
  availableTools: readonly ToolDescriptor<Record<string, unknown>, unknown>[] = [],
  searchRoots: string[] = [...ACTIVATION_SEARCH_ROOTS],
): BehaviorActivationResult {
  const result: BehaviorActivationResult = { discovered: 0, loaded: [], skipped: [] };

  let discovered;
  try {
    discovered = discoverBehaviorPackages(rootDir, { searchRoots });
  } catch {
    // A repo with no discoverable layout at all is not an error —
    // the extension must still activate normally (AC-009-3).
    return result;
  }

  result.discovered = discovered.length;

  for (const pkg of discovered) {
    if (!pkg.manifest) {
      result.skipped.push({ behaviorId: pkg.behaviorId, reason: pkg.parseError ?? "no manifest" });
      continue;
    }
    if (pkg.validationErrors && pkg.validationErrors.length > 0) {
      result.skipped.push({ behaviorId: pkg.behaviorId, reason: pkg.validationErrors.join("; ") });
      continue;
    }

    const compileResult = compile({ behaviors: [pkg.manifest] });
    if (compileResult.errors.length > 0 || compileResult.compiled.length === 0) {
      result.skipped.push({
        behaviorId: pkg.behaviorId,
        reason: compileResult.errors.map((e) => e.message).join("; ") || "compile produced no output",
      });
      continue;
    }

    for (const compiled of compileResult.compiled) {
      try {
        const artifacts = compileBehaviorToArtifacts(compiled, availableTools);
        loadCompiledBehavior(pi, compiled, artifacts, availableTools);
        result.loaded.push(compiled.manifest.metadata.name);
      } catch (error) {
        // Includes the TRD-004 fail-closed refusal for an unenforced
        // `mode: auto` manifest — surfaced, never swallowed into a
        // silently degraded session.
        result.skipped.push({
          behaviorId: pkg.behaviorId,
          reason: (error as Error).message,
        });
      }
    }
  }

  return result;
}
