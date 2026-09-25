import {
  MutationGuard,
  WorkspaceSnapshot,
  ApprovalGate,
} from "@sunstone-partners/ensemble-agent-core";
import { RetryBudget, issueKey, IssueKeyInput } from "./issue-identity";

/**
 * The bounded auto-fix loop (TRD-025..028 / REQ-005, REQ-006).
 *
 * Every write goes through `MutationGuard`, so the protected-path
 * boundary and mode semantics apply to the loop exactly as they apply
 * to anything else — the loop gets no privileged path. A rejected
 * attempt restores the tree from a `WorkspaceSnapshot` and still counts
 * against the retry budget: an attempt that costs nothing would let a
 * model retry forever by failing in a way that "doesn't count."
 */

export interface CandidateWrite {
  path: string;
  contents: string;
  mutationClass: string;
}

export interface FixCandidate {
  writes: CandidateWrite[];
}

export interface SuiteResult {
  /** Total failing tests across the whole declared suite. */
  failures: number;
  /** True when the specific target test now passes. */
  targetPasses: boolean;
  output?: string;
}

export interface AutofixDeps {
  guard: MutationGuard;
  snapshot: () => WorkspaceSnapshot;
  /** Applies one authorized write. Separated so tests can fail a specific write. */
  applyWrite: (write: CandidateWrite) => void;
  /** Runs the behavior-declared test command over the full suite. */
  runSuite: () => SuiteResult | Promise<SuiteResult>;
  approval?: ApprovalGate;
  budget?: RetryBudget;
}

export type AttemptOutcome =
  | { status: "accepted"; attempt: number; issue: string }
  | { status: "rejected"; attempt: number; issue: string; reason: string; restored: string[] }
  | { status: "escalated"; attempt: number; issue: string; reason: string; approvalRequested: boolean };

export class AutofixLoop {
  private readonly budget: RetryBudget;

  constructor(private readonly deps: AutofixDeps) {
    this.budget = deps.budget ?? new RetryBudget(3);
  }

  get retryBudget(): RetryBudget {
    return this.budget;
  }

  /**
   * Runs one attempt for one issue.
   *
   * Returns `escalated` without attempting when the budget for this
   * issue is already spent (AC-006-2).
   */
  async attempt(input: IssueKeyInput, candidate: FixCandidate): Promise<AttemptOutcome> {
    const issue = issueKey(input);

    if (!this.budget.canAttempt(issue)) {
      return this.escalate(issue, `retry budget of ${this.budget.limit} attempts exhausted`);
    }

    const snapshot = this.deps.snapshot();
    const attemptNumber = this.budget.attemptsFor(issue) + 1;

    // Capture before the first write, so a denial on write #1 still
    // has a restore point.
    snapshot.captureAll(candidate.writes.map((w) => w.path));

    for (const write of candidate.writes) {
      const decision = this.deps.guard.authorize({
        mutationClass: write.mutationClass,
        path: write.path,
        kind: "write",
      });

      if (!decision.allowed) {
        // Abort at the FIRST denial and revert everything already
        // written, so no partial application survives (AC-005-1).
        const report = snapshot.restore();
        const n = this.budget.recordFailure(issue);
        if (n >= this.budget.limit) {
          return this.escalate(issue, decision.reason, n);
        }
        return {
          status: "rejected",
          attempt: attemptNumber,
          issue,
          reason: decision.reason,
          restored: [...report.restored, ...report.deleted],
        };
      }

      this.deps.applyWrite(write);
    }

    const suite = await this.deps.runSuite();

    // Acceptance requires the whole suite green, not just the target
    // test: a fix that repairs one test and breaks another is a
    // regression, and accepting it would be how the loop makes things
    // worse while reporting success (AC-005-2).
    if (suite.targetPasses && suite.failures === 0) {
      this.budget.reset(issue);
      return { status: "accepted", attempt: attemptNumber, issue };
    }

    const report = snapshot.restore();
    const reason = !suite.targetPasses
      ? "target test still fails"
      : `suite reports ${suite.failures} failure(s) elsewhere`;

    const n = this.budget.recordFailure(issue);
    if (n >= this.budget.limit) {
      return this.escalate(issue, reason, n);
    }

    return {
      status: "rejected",
      attempt: attemptNumber,
      issue,
      reason,
      restored: [...report.restored, ...report.deleted],
    };
  }

  private async escalate(issue: string, reason: string, attempt = this.budget.limit): Promise<AttemptOutcome> {
    let approvalRequested = false;
    if (this.deps.approval) {
      await this.deps.approval.request({
        title: "Auto-fix escalation",
        message: `Issue ${issue} was not fixed after ${this.budget.limit} attempts: ${reason}`,
      });
      approvalRequested = true;
    }
    return { status: "escalated", attempt, issue, reason, approvalRequested };
  }
}
