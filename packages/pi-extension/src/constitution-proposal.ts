import { ApprovalGate } from "@sunstone-partners/ensemble-agent-core";

/**
 * Gates constitution changes behind an explicit inline confirmation
 * (TRD-029 / REQ-007).
 *
 * The invariant that matters: `constitution.md` is never modified in
 * place by this path, on either answer. "Yes" opens a PR and the file
 * changes only if a human merges it; "no" does nothing. The file is
 * also covered by the protected-path boundary, so even a behavior that
 * tried to write it directly is refused — this gate is the sanctioned
 * route, not the only guard.
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

export interface ConstitutionProposalDeps {
  approval: ApprovalGate;
  /** Opens the PR. Called only after an explicit "yes". */
  openPullRequest: (change: ConstitutionChange) => PullRequestRef | Promise<PullRequestRef>;
}

export type ProposalOutcome =
  | { status: "proposed"; pr: PullRequestRef }
  | { status: "declined"; reason: string };

export class ConstitutionProposal {
  constructor(private readonly deps: ConstitutionProposalDeps) {}

  async propose(change: ConstitutionChange): Promise<ProposalOutcome> {
    const decision = await this.deps.approval.request({
      title: "Propose constitution change",
      message:
        `Behavior "${change.behaviorName}" proposes a constitution change.\n\n` +
        `Rationale: ${change.rationale}\n\n${change.diff}\n\n` +
        `Approving opens a pull request. docs/standards/constitution.md is not ` +
        `modified until that pull request is merged.`,
    });

    if (!decision.approved) {
      // AC-007-1 and AC-007-3 collapse to the same branch on purpose:
      // a headless session must behave exactly like an explicit "no",
      // not like a softer maybe.
      return { status: "declined", reason: decision.reason };
    }

    return { status: "proposed", pr: await this.deps.openPullRequest(change) };
  }
}
