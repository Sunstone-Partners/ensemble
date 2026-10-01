import { ApprovalGate } from "@sunstone-partners/ensemble-agent-core";

/**
 * Gates constitution changes behind an explicit confirmation, then APPLIES
 * the approved change (br-9uqd, superseding TRD-029 / REQ-007).
 *
 * WHAT CHANGED AND WHY. The original invariant was that constitution.md is
 * never modified in place: "yes" opened a PR and the file changed only when
 * a human merged it. That made the fifth step of the product loop --
 * detect, RCA, UPDATE THE CONSTITUTION, fix, verify -- permanently
 * unfinishable in-session. The rule that was supposed to prevent recurrence
 * only existed as an unmerged branch, so the next run hit the same failure
 * with the same constitution.
 *
 * Review structurally still exists, and that is what makes this safe to
 * change: the repository now runs a protected `main` fed only by `dev`,
 * with required checks and enforce_admins. A change landing in the working
 * tree is not a change landing in the release channel.
 *
 * WHAT DID NOT CHANGE. Approval is still explicit and still fail-closed: a
 * "no" applies nothing, and a headless session (hasUI === false) takes the
 * same branch as "no" rather than a softer maybe. The write boundary still
 * covers constitution.md, so this gate remains the sanctioned route rather
 * than the only guard -- a behavior writing the file directly is still
 * reverted.
 *
 * The pull request is now DELIVERY, not permission: it is opened after the
 * change is applied, and is optional. Failing to open one does not undo an
 * approved change, because losing the maintainer's decision is worse than
 * delivering it late.
 */

export interface ConstitutionChange {
  behaviorName: string;
  rationale: string;
  diff: string;
}

export interface PullRequestRef {
  url: string;
  branch: string;
}

/** Where an approved change landed. */
export interface AppliedChange {
  path: string;
  detail: string;
}

export interface ConstitutionProposalDeps {
  approval: ApprovalGate;
  /** Applies the change. Called only after an explicit "yes". */
  applyChange: (change: ConstitutionChange, rootDir?: string) => AppliedChange | Promise<AppliedChange>;
  /** Optional delivery of an already-applied change. */
  openPullRequest?: (change: ConstitutionChange) => PullRequestRef | Promise<PullRequestRef>;
}

export type ProposalOutcome =
  | { status: "applied"; applied: AppliedChange; pr?: PullRequestRef; deliveryError?: string }
  | { status: "declined"; reason: string }
  /**
   * Approved, but the write did not land. Distinct from "declined" on
   * purpose: reporting a failed write as a refusal would blame a maintainer
   * for a decision they did not make, and would hide a broken applier behind
   * a perfectly normal-looking outcome.
   */
  | { status: "failed"; reason: string };

export class ConstitutionProposal {
  constructor(private readonly deps: ConstitutionProposalDeps) {}

  async propose(change: ConstitutionChange): Promise<ProposalOutcome> {
    const decision = await this.deps.approval.request({
      title: "Apply constitution change",
      message:
        `Behavior "${change.behaviorName}" proposes a constitution change.\n\n` +
        `Rationale: ${change.rationale}\n\n${change.diff}\n\n` +
        `Approving edits docs/standards/constitution.md in this working tree. ` +
        `It reaches the release channel only through the normal dev -> main ` +
        `review, which is unchanged.`,
    });

    if (!decision.approved) {
      // A headless session and an explicit "no" collapse to the same branch
      // on purpose: absence of a human is not consent.
      return { status: "declined", reason: decision.reason };
    }

    let applied: AppliedChange;
    try {
      applied = await this.deps.applyChange(change);
    } catch (error) {
      // The consequential step: a human said yes and the write to a
      // protected path was attempted. A rejected promise here escapes the
      // runner entirely, losing the run record along with any report of what
      // happened, so this failure is returned as an outcome like any other.
      return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }

    if (!this.deps.openPullRequest) return { status: "applied", applied };

    try {
      return { status: "applied", applied, pr: await this.deps.openPullRequest(change) };
    } catch (error) {
      // Delivery failed AFTER the change was applied. Reported, not undone:
      // the approval was real and reverting it would silently discard a
      // decision the maintainer actually made.
      return {
        status: "applied",
        applied,
        deliveryError: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
