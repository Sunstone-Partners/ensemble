import { createHash } from "node:crypto";
import { BehaviorManifest, BehaviorPackage } from "./schema";

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
 * A compiled, validated manifest. `hasMutationAuthority` is the only
 * supported way to check mutation authority — it is intentionally
 * distinct from tool access (`hasTool`), so a bash grant can never be
 * mistaken for artifact-write authority (TRD-011/AC-011-1).
 */
export interface CompiledBehaviorPackage {
  manifest: BehaviorManifest;
  digest: string;
  hasTool(toolName: string): boolean;
  hasMutationAuthority(mutationClass: string): boolean;
}

/**
 * Computes an immutable digest over a manifest's content, excluding
 * `metadata.digest` itself (the digest cannot include its own value).
 * Canonical JSON (recursively sorted object keys) makes the digest
 * independent of source key ordering.
 */
export function computeManifestDigest(manifest: BehaviorManifest): string {
  const { metadata, ...rest } = manifest;
  const { digest: _digest, ...metadataWithoutDigest } = metadata;
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

function compileOne(manifest: BehaviorManifest): { errors: CompileError[]; compiled?: CompiledBehaviorPackage } {
  const errors: CompileError[] = [];
  const name = manifest.metadata?.name ?? "<unnamed>";

  if (manifest.kind !== "Behavior") {
    errors.push({ behaviorName: name, message: `unsupported kind: ${String(manifest.kind)}` });
  }
  if (!manifest.trigger?.event_type) {
    errors.push({ behaviorName: name, message: "behavior has no trigger.event_type" });
  }
  if (!Array.isArray(manifest.capabilities?.tools)) {
    errors.push({ behaviorName: name, message: "capabilities.tools must be an array" });
  }
  if (!Array.isArray(manifest.capabilities?.mutation_classes)) {
    errors.push({ behaviorName: name, message: "capabilities.mutation_classes must be an array" });
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

  return {
    errors,
    compiled: {
      manifest,
      digest,
      hasTool: (toolName) => toolSet.has(toolName),
      // Deliberately independent of hasTool: mutation authority is
      // never derived from tool access.
      hasMutationAuthority: (mutationClass) => mutationSet.has(mutationClass),
    },
  };
}

export function compile(pkg: BehaviorPackage): CompileResult {
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

    const result = compileOne(manifest);
    errors.push(...result.errors);
    if (result.compiled) {
      compiled.push(result.compiled);
    }
  }

  return { ok: errors.length === 0, errors, compiled };
}

export function validate(manifest: BehaviorManifest): CompileError[] {
  return compile({ behaviors: [manifest] }).errors;
}
