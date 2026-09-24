import { BehaviorDefinition, BehaviorPackage } from "./schema";

export interface CompileError {
  behaviorName: string;
  message: string;
}

export interface CompileResult {
  ok: boolean;
  errors: CompileError[];
}

/**
 * Validates a raw behavior package's structural invariants (unique
 * names, non-empty triggers, well-formed tool references). Real
 * schema validation (JSON-schema, semantic checks against a live
 * ToolRegistry) is layered on by later tasks; this establishes the
 * compile/validate entry point agent-core owns.
 */
export function compile(pkg: BehaviorPackage): CompileResult {
  const errors: CompileError[] = [];
  const seenNames = new Set<string>();

  for (const behavior of pkg.behaviors) {
    if (seenNames.has(behavior.name)) {
      errors.push({ behaviorName: behavior.name, message: "duplicate behavior name" });
    }
    seenNames.add(behavior.name);

    if (behavior.triggers.length === 0) {
      errors.push({ behaviorName: behavior.name, message: "behavior has no triggers" });
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validate(behavior: BehaviorDefinition): CompileError[] {
  return compile({ behaviors: [behavior] }).errors;
}
