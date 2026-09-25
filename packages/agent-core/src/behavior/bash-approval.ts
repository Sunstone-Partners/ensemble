/**
 * Approval policy for `ensemble.bash`.
 *
 * WHY THIS EXISTS
 *
 * The write boundary is *corrective*: it detects what a command changed and
 * reverts protected paths afterwards. That is the right design for edits to
 * files, because shell text cannot be soundly parsed to predict them. But it
 * cannot cover effects that have no undo -- network calls, `git push`,
 * deleting things outside the repo. Those need a decision made *before* the
 * command runs, which means a human in the loop.
 *
 * WHY A CUSTOM TOOL CAN ACTUALLY ENFORCE THIS
 *
 * A custom tool normally cannot constrain anything, because the model can
 * ignore it and call native `bash`. It works here only because grant
 * enforcement blocks native `bash` at the `tool_call` boundary when a
 * behavior omits it from `capabilities.tools`. The model is not *asked* to
 * use `ensemble.bash`; it is left with no alternative. Remove the grant
 * enforcement and this becomes decorative.
 *
 * WHAT "ALWAYS" BINDS TO
 *
 * `allow-always` binds to the EXACT command string, not a prefix and not
 * argv[0]. This is deliberately the narrowest possible rule. Binding to
 * argv[0] would make one approval of `npx` an approval of every package npx
 * can run, and one approval of `git` an approval of `git push --force`.
 * Broader patterns are a real feature request, but they must be designed
 * rather than fallen into -- a too-broad "always" silently switches
 * enforcement off forever, which is worse than having no prompt at all.
 */

export type ApprovalAnswer = "allow-once" | "allow-always" | "deny-once" | "deny-always";

export type BashApprovalDecision =
  | { allowed: true; reason: "remembered-allow" | "approved-now" }
  | { allowed: false; reason: "remembered-deny" | "denied-now" | "no-approver" };

/** Answers a single approval request, or null when no human can be asked. */
export type Approver = (command: string) => Promise<ApprovalAnswer> | ApprovalAnswer;

export interface BashApprovalPolicyOptions {
  /**
   * What to do when there is no approver (headless `-p` runs, CI). Defaults
   * to "deny": a non-interactive session must not silently gain the
   * authority a human was supposed to grant. Set "allow" ONLY where the
   * sandbox itself is the control.
   */
  readonly nonInteractive?: "deny" | "allow";
}

export class BashApprovalPolicy {
  private readonly allowAlways = new Set<string>();
  private readonly denyAlways = new Set<string>();
  private readonly nonInteractive: "deny" | "allow";

  constructor(
    private readonly approver: Approver | undefined,
    options: BashApprovalPolicyOptions = {},
  ) {
    this.nonInteractive = options.nonInteractive ?? "deny";
  }

  /** Remembered rules, exposed for session UI and tests. */
  get remembered(): { allow: string[]; deny: string[] } {
    return { allow: [...this.allowAlways], deny: [...this.denyAlways] };
  }

  async decide(command: string): Promise<BashApprovalDecision> {
    const key = normalizeCommand(command);

    // Deny wins over allow: if a command is on both lists, the safe
    // reading is that someone meant to stop it.
    if (this.denyAlways.has(key)) return { allowed: false, reason: "remembered-deny" };
    if (this.allowAlways.has(key)) return { allowed: true, reason: "remembered-allow" };

    if (!this.approver) {
      return this.nonInteractive === "allow"
        ? { allowed: true, reason: "approved-now" }
        : { allowed: false, reason: "no-approver" };
    }

    const answer = await this.approver(command);
    switch (answer) {
      case "allow-always":
        this.allowAlways.add(key);
        return { allowed: true, reason: "approved-now" };
      case "allow-once":
        return { allowed: true, reason: "approved-now" };
      case "deny-always":
        this.denyAlways.add(key);
        return { allowed: false, reason: "denied-now" };
      case "deny-once":
        return { allowed: false, reason: "denied-now" };
      default:
        // An approver returning something unrecognised must not be read as
        // consent.
        return { allowed: false, reason: "denied-now" };
    }
  }
}

/**
 * Normalizes whitespace only. Deliberately NOT a semantic normalizer:
 * pretending `rm -rf x` and `rm -fr x` are the same key would mean an
 * approval of one silently authorises the other, and any partial semantic
 * model of shell syntax is a source of exactly that kind of surprise.
 */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}


/**
 * Labels shown in Pi's `ui.select`. The leading letters mirror the familiar
 * a/A/d/D convention while remaining readable in a list dialog.
 */
export const BASH_APPROVAL_CHOICES: Record<ApprovalAnswer, string> = {
  "allow-once": "(a) Allow once",
  "allow-always": "(A) Allow always - remember this exact command",
  "deny-once": "(d) Deny once",
  "deny-always": "(D) Deny always - remember this exact command",
};

/**
 * Maps a chosen label back to an answer. An unrecognised or absent choice
 * (the user pressed escape) is deny-once: dismissing a dialog is not
 * consent, and must not be promoted to a remembered rule either.
 */
export function answerFromChoice(choice: string | undefined): ApprovalAnswer {
  const found = (Object.keys(BASH_APPROVAL_CHOICES) as ApprovalAnswer[]).find(
    (answer) => BASH_APPROVAL_CHOICES[answer] === choice,
  );
  return found ?? "deny-once";
}