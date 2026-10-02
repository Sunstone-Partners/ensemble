import { createHash } from "node:crypto";
import { artifactTriggerViolation } from "./file-source-adapter";
import { BehaviorManifest, BehaviorPackage } from "./schema";
import { WorkflowDefinition, WorkflowDiagnostic, validateWorkflow } from "../workflow";

export interface CompileError {
  behaviorName: string;
  message: string;
}

export interface CompileResult {
  ok: boolean;
  errors: CompileError[];
  compiled: CompiledBehaviorPackage[];
}

/**
 * Options a caller supplies so workflow validation can be complete.
 *
 * Without them, `execution.workflow` is still structurally validated but
 * command bindings cannot be checked, because the compiler does not own the
 * command registry. Callers that can supply them get a stricter compile; the
 * library default stays usable for manifest-only checks.
 */
export interface CompileOptions {
  /** Registered command IDs, for REQ-BEH-004 fail-closed binding checks. */
  readonly knownCommands?: readonly string[];
  /** Capability each known command requires. */
  readonly commandCapability?: (commandId: string) => string | undefined;
  /** Reads a package-relative prompt file, so a missing prompt fails compile. */
  readonly readPrompt?: (behaviorName: string, relativePath: string) => string | undefined;
}

/**
 * A compiled, validated manifest. `hasMutationAuthority` is the only
 * supported way to check mutation authority — it is intentionally
 * distinct from tool access (`hasTool`), so a bash grant can never be
 * mistaken for artifact-write authority (TRD-011/AC-011-1).
 *
 * `hasCommand` is a third, equally independent axis (REQ-SAFE-003): a
 * behavior holding `bash` and `artifact.write` still cannot request
 * `fix.apply` unless it declares it.
 */
export interface CompiledBehaviorPackage {
  manifest: BehaviorManifest;
  digest: string;
  /** Present only when the manifest declares a valid `execution.workflow`. */
  workflow?: WorkflowDefinition;
  hasTool(toolName: string): boolean;
  hasMutationAuthority(mutationClass: string): boolean;
  hasCommand(commandId: string): boolean;
  /** Command capabilities declared by the manifest, in declaration order. */
  readonly commands: readonly string[];
}

/**
 * Computes an immutable digest over a manifest's content, excluding
 * `metadata.digest` itself (the digest cannot include its own value).
 * Canonical JSON (recursively sorted object keys) makes the digest
 * independent of source key ordering.
 *
 * Tolerates a manifest with no `metadata` block at all. That is an invalid
 * manifest and `compileOne` reports it as such — but this function runs
 * BEFORE those errors are returned, and destructuring `undefined` threw a
 * TypeError that escaped discovery entirely. One malformed package then
 * suppressed every valid sibling in the repository, which is precisely what
 * REQ-BEH-004 forbids. A crash is not a diagnostic.
 */
export function computeManifestDigest(manifest: BehaviorManifest): string {
  const { metadata, ...rest } = manifest;
  // `packageDigest` is computed at load time from files on disk, never
  // declared in YAML. Including it would make the manifest digest depend on
  // a value derived from the manifest digest.
  const { digest: _digest, packageDigest: _packageDigest, ...metadataWithoutDigest } = metadata ?? {};
  const canonical = canonicalize({ ...rest, metadata: metadataWithoutDigest });
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
    );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function compileOne(
  manifest: BehaviorManifest,
  options: CompileOptions,
): { errors: CompileError[]; compiled?: CompiledBehaviorPackage } {
  const errors: CompileError[] = [];
  const name = manifest.metadata?.name ?? "<unnamed>";

  // AC-012-2: each failure names its specific field path, not a generic
  // "invalid manifest" message.
  if (!manifest.api_version) {
    errors.push({ behaviorName: name, message: "field 'api_version' is required" });
  }
  if (manifest.kind !== "Behavior") {
    errors.push({ behaviorName: name, message: `field 'kind' must be "Behavior", got: ${String(manifest.kind)}` });
  }
  if (!manifest.metadata?.name) {
    errors.push({ behaviorName: name, message: "field 'metadata.name' is required" });
  }
  if (!manifest.metadata?.version) {
    errors.push({ behaviorName: name, message: "field 'metadata.version' is required" });
  }
  if (!manifest.trigger?.event_type) {
    errors.push({ behaviorName: name, message: "field 'trigger.event_type' is required" });
  }
  // TRD-001/AC-001-2: an artifact trigger with no concrete path, or one that
  // escapes the repository, is rejected here, so no watch is ever derived
  // from it.
  const artifactProblem = artifactTriggerViolation(manifest);
  if (artifactProblem) {
    errors.push({ behaviorName: name, message: artifactProblem });
  }
  if (!manifest.policy?.mode) {
    errors.push({ behaviorName: name, message: "field 'policy.mode' is required" });
  }
  if (!manifest.execution?.graph) {
    errors.push({ behaviorName: name, message: "field 'execution.graph' is required" });
  }
  // TRD-010/AC-012-2: an auto-applying behavior must declare how to
  // re-verify its own fix. Falling back to a package-manager guess
  // would silently run the wrong suite (or none) in a non-npm repo
  // and report a fix as verified when nothing was verified.
  if (manifest.policy?.mode === "auto" && !manifest.execution?.test_command) {
    errors.push({
      behaviorName: name,
      message: "field 'execution.test_command' is required when policy.mode is \"auto\"",
    });
  }
  if (!Array.isArray(manifest.capabilities?.tools)) {
    errors.push({ behaviorName: name, message: "field 'capabilities.tools' must be an array" });
  }
  if (!Array.isArray(manifest.capabilities?.mutation_classes)) {
    errors.push({ behaviorName: name, message: "field 'capabilities.mutation_classes' must be an array" });
  }
  if (
    manifest.capabilities?.commands !== undefined &&
    !Array.isArray(manifest.capabilities.commands)
  ) {
    errors.push({ behaviorName: name, message: "field 'capabilities.commands' must be an array when present" });
  }
  if (!Array.isArray(manifest.outcomes)) {
    errors.push({ behaviorName: name, message: "field 'outcomes' must be an array" });
  }

  const digest = computeManifestDigest(manifest);
  if (manifest.metadata?.digest && manifest.metadata.digest !== digest) {
    // AC-011-2: identical metadata.version, different content -> digest
    // mismatch fails validation, rather than silently trusting a stale
    // or forged digest.
    errors.push({
      behaviorName: name,
      message: `digest mismatch for version ${manifest.metadata.version}: manifest declares "${manifest.metadata.digest}", content hashes to "${digest}"`,
    });
  }

  if (errors.length > 0) {
    return { errors };
  }

  const toolSet = new Set(manifest.capabilities.tools);
  const mutationSet = new Set(manifest.capabilities.mutation_classes);
  const commands = manifest.capabilities.commands ?? [];
  const commandSet = new Set(commands);

  // Workflow validation runs only when the manifest declares one. A manifest
  // without `execution.workflow` is a legacy package and stays valid
  // (REQ-BEH-005); a manifest WITH one that is invalid is rejected outright,
  // because a partially-interpreted workflow is the failure mode REQ-BEH-004
  // exists to prevent.
  let workflow: WorkflowDefinition | undefined;
  if (manifest.execution.workflow !== undefined) {
    const result = validateWorkflow({
      behaviorName: name,
      workflow: manifest.execution.workflow,
      behaviorTools: manifest.capabilities.tools,
      behaviorCommands: commands,
      declaredOutcomes: manifest.outcomes,
      knownCommands: options.knownCommands,
      commandCapability: options.commandCapability,
      readPrompt: options.readPrompt ? (p) => options.readPrompt?.(name, p) : undefined,
    });
    if (!result.valid) {
      return { errors: result.diagnostics.map(toCompileError) };
    }
    workflow = result.workflow;
  }

  return {
    errors,
    compiled: {
      manifest,
      digest,
      workflow,
      hasTool: (toolName) => toolSet.has(toolName),
      // Deliberately independent of hasTool: mutation authority is
      // never derived from tool access.
      hasMutationAuthority: (mutationClass) => mutationSet.has(mutationClass),
      // And independent of both: command authority is its own axis.
      hasCommand: (commandId) => commandSet.has(commandId),
      commands,
    },
  };
}

/** Renders a workflow diagnostic as a compile error naming behavior and step. */
function toCompileError(diagnostic: WorkflowDiagnostic): CompileError {
  return {
    behaviorName: diagnostic.behavior,
    message: `execution.workflow step '${diagnostic.step}': ${diagnostic.message}`,
  };
}

export function compile(pkg: BehaviorPackage, options: CompileOptions = {}): CompileResult {
  const errors: CompileError[] = [];
  const compiled: CompiledBehaviorPackage[] = [];
  const seenNames = new Set<string>();

  for (const manifest of pkg.behaviors) {
    const name = manifest.metadata?.name ?? "<unnamed>";
    if (seenNames.has(name)) {
      errors.push({ behaviorName: name, message: "duplicate behavior name" });
      continue;
    }
    seenNames.add(name);

    // One invalid package never suppresses a valid sibling (REQ-BEH-004):
    // errors accumulate and the loop always continues.
    const result = compileOne(manifest, options);
    errors.push(...result.errors);
    if (result.compiled) {
      compiled.push(result.compiled);
    }
  }

  return { ok: errors.length === 0, errors, compiled };
}

export function validate(manifest: BehaviorManifest, options: CompileOptions = {}): CompileError[] {
  return compile({ behaviors: [manifest] }, options).errors;
}
