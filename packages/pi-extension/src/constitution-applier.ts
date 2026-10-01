import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppliedChange, ConstitutionChange } from "./constitution-proposal";

export const CONSTITUTION_PATH = "docs/standards/constitution.md";

/**
 * Writes an APPROVED constitution change into the working tree.
 *
 * The subtlety that makes this work at all: constitution.md is a protected
 * path, so WriteBoundaryMonitor reverts writes to it -- correctly, and
 * demonstrably. Applying an approved change therefore has to do two things
 * together, or it does nothing at all:
 *
 *   1. write the file, and
 *   2. re-baseline the boundary for that path, so the change is the new
 *      pristine state rather than the next violation.
 *
 * Without (2) the sequence is: maintainer approves -> file is written ->
 * next tool call reverts it -> the loop reports success and the constitution
 * is unchanged. That is the failure this whole exercise exists to remove,
 * and it would be invisible.
 *
 * `accept` is the same single-change consent used by /ensemble-approve: it
 * authorises THIS state of the file, not the path in general, so a later
 * unapproved edit is still reverted to what the maintainer approved.
 *
 * Amendments are APPENDED rather than rewritten. A model editing the whole
 * document can silently drop rules while "adding" one; appending is the
 * narrowest operation that still records the decision, and it leaves the
 * existing text byte-identical.
 */
export interface ConstitutionApplierDeps {
  rootDir: string;
  accept: (relPath: string) => void;
  /** Injectable for tests; defaults to the real clock. */
  now?: () => Date;
}

export function createConstitutionApplier(
  deps: ConstitutionApplierDeps,
): (change: ConstitutionChange, rootDir?: string) => AppliedChange {
  return (change: ConstitutionChange, rootDir?: string): AppliedChange => {
    // The constitution that governs the repo the failure came from, not the
    // one the extension host happens to sit in (br-x36p). Falls back to the
    // configured root when the caller supplies none.
    const abs = resolve(rootDir ?? deps.rootDir, CONSTITUTION_PATH);
    if (!existsSync(abs)) {
      throw new Error(`constitution not found at ${CONSTITUTION_PATH}`);
    }

    const stamp = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
    const before = readFileSync(abs, "utf8");
    const body = [
      "",
      `## Amendment ${stamp}: ${change.behaviorName}`,
      "",
      `Rationale: ${change.rationale}`,
      "",
      change.diff.trim(),
      "",
    ].join("\n");

    appendFileSync(abs, before.endsWith("\n") ? body : `\n${body}`);

    // Order matters. Accepting BEFORE the write would re-baseline the old
    // content and leave the new content looking like a violation.
    deps.accept(CONSTITUTION_PATH);

    return {
      path: CONSTITUTION_PATH,
      detail: `appended amendment for ${change.behaviorName}`,
    };
  };
}
