/**
 * Inline approval for consequential actions, failing closed (TRD-022 / REQ-014).
 *
 * The failure this prevents: a headless session (`hasUI === false`) has
 * no way to ask, and the tempting default is to proceed unasked —
 * which turns "the user confirms every constitution change" into "the
 * user confirms it only when someone is watching." Absence of a UI is
 * therefore a denial, never an implicit yes.
 */

export interface ApprovalRequest {
  title: string;
  message: string;
}

export interface ApprovalDecision {
  approved: boolean;
  reason: string;
}

export interface ApprovalHost {
  /** Mirrors Pi's ExtensionContext.hasUI. */
  readonly hasUI: boolean;
  /** Mirrors Pi's ui.confirm(title, message): Promise<boolean>. */
  confirm(title: string, message: string): Promise<boolean>;
}

export class ApprovalGate {
  constructor(private readonly host: ApprovalHost) {}

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (!this.host.hasUI) {
      return {
        approved: false,
        reason:
          `approval required for "${request.title}" but this session has no UI ` +
          `(hasUI === false); failing closed rather than proceeding unasked`,
      };
    }

    let answer: boolean;
    try {
      answer = await this.host.confirm(request.title, request.message);
    } catch (error) {
      // An error asking is not consent.
      return {
        approved: false,
        reason: `approval prompt failed for "${request.title}": ${(error as Error).message}`,
      };
    }

    return answer
      ? { approved: true, reason: `approved by user: ${request.title}` }
      : { approved: false, reason: `declined by user: ${request.title}` };
  }
}
