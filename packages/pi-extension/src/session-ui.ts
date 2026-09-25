import { ApprovalHost } from "@sunstone-partners/ensemble-agent-core";

/**
 * Bridges Pi's per-call UI context to the approval gate (REQ-014/REQ-007).
 *
 * `ui.confirm` lives on `ExtensionContext`, which Pi supplies per tool
 * call and per command — not at activation time. That timing mismatch
 * is why `ApprovalGate` previously had no production host at all: the
 * gate was constructed during activation, when no context existed, so
 * it was only ever given a host by tests. The result was a system that
 * could never ask a human anything, failing closed forever while
 * appearing correct.
 *
 * This holds the most recent context and answers through it.
 */

export interface UiContextLike {
  hasUI: boolean;
  ui?: {
    confirm(title: string, message: string): Promise<boolean>;
    /** Pi's multi-choice dialog (ExtensionUIContext.select). */
    select?(title: string, options: string[]): Promise<string | undefined>;
  };
}

export class SessionUiBridge implements ApprovalHost {
  private current?: UiContextLike;

  /** Records the latest context Pi handed us. */
  capture(ctx: UiContextLike | undefined): void {
    if (ctx && typeof ctx.hasUI === "boolean") this.current = ctx;
  }

  get hasUI(): boolean {
    return Boolean(this.current?.hasUI && this.current?.ui?.confirm);
  }

  async confirm(title: string, message: string): Promise<boolean> {
    const ctx = this.current;
    if (!ctx?.hasUI || !ctx.ui?.confirm) {
      // No captured UI means no human to ask. ApprovalGate treats this
      // as a denial; returning true here would silently auto-approve.
      return false;
    }
    return ctx.ui.confirm(title, message);
  }

  /** True when a 4-way choice can actually be put to a human. */
  get canSelect(): boolean {
    return Boolean(this.current?.hasUI && this.current?.ui?.select);
  }

  /**
   * Asks a multi-choice question. Returns undefined when there is no UI or
   * the user dismissed the dialog -- callers MUST treat that as "no answer",
   * never as a default yes.
   */
  async select(title: string, options: string[]): Promise<string | undefined> {
    const ctx = this.current;
    if (!ctx?.hasUI || !ctx.ui?.select) return undefined;
    return ctx.ui.select(title, options);
  }
}
