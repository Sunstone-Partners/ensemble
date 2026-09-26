/**
 * Branch and attribution policy for auto-fix commits (TRD-023 / REQ-016).
 *
 * Two rules, both of which exist because an autonomous commit is only
 * acceptable if it is trivially reviewable and trivially revertable:
 *
 * 1. Never commit in place on the repository default branch. An
 *    auto-fix landing directly on main is indistinguishable from a
 *    human commit and cannot be dropped without rewriting shared
 *    history.
 * 2. Every message carries the behavior name, the source event id and
 *    the attempt number, so anyone reading `git log` can tell what
 *    produced the change and trace it back.
 */

export interface CommitRequest {
  currentBranch: string;
  behaviorName: string;
  eventId: string;
  attempt: number;
  summary: string;
}

export type CommitDecision =
  | { allowed: true; branch: string; createBranch: boolean; message: string }
  | { allowed: false; reason: string };

export interface CommitPolicyOptions {
  /**
   * Branch names treated as protected. Defaults cover the common
   * defaults plus the configured repository default.
   */
  protectedBranches?: string[];
  /** The repository's default branch, when known. */
  defaultBranch?: string;
  /** Produces the dedicated branch name for an issue. */
  branchNameFor?: (request: CommitRequest) => string;
}

export const DEFAULT_PROTECTED_BRANCHES = ["main", "master", "trunk", "develop", "release"];

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export class CommitPolicy {
  private readonly protectedBranches: Set<string>;

  constructor(private readonly options: CommitPolicyOptions = {}) {
    this.protectedBranches = new Set(
      [...(options.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES), options.defaultBranch]
        .filter((b): b is string => typeof b === "string" && b.length > 0)
        .map((b) => b.toLowerCase()),
    );
  }

  isProtected(branch: string): boolean {
    return this.protectedBranches.has(branch.trim().toLowerCase());
  }

  /** Builds the attributed commit message (AC-016-3). */
  buildMessage(request: CommitRequest): string {
    return [
      `fix(${request.behaviorName}): ${request.summary}`,
      "",
      `Applied automatically by the ensemble behavior runtime.`,
      "",
      `Behavior: ${request.behaviorName}`,
      `Source-Event: ${request.eventId}`,
      `Attempt: ${request.attempt}`,
    ].join("\n");
  }

  /**
   * Decides where an accepted fix may be committed.
   *
   * On a protected branch the commit is redirected to a dedicated
   * branch rather than refused outright: refusing would discard a
   * verified fix, while committing in place is what REQ-016 forbids.
   */
  authorize(request: CommitRequest): CommitDecision {
    if (!request.behaviorName || !request.eventId || !Number.isFinite(request.attempt)) {
      return {
        allowed: false,
        reason: "commit refused: behavior name, source event id and attempt number are all required for attribution",
      };
    }

    const message = this.buildMessage(request);

    if (this.isProtected(request.currentBranch)) {
      const branch =
        this.options.branchNameFor?.(request) ??
        `ensemble/autofix/${slug(request.behaviorName)}-${slug(request.eventId)}`;

      return { allowed: true, branch, createBranch: true, message };
    }

    return { allowed: true, branch: request.currentBranch, createBranch: false, message };
  }
}
