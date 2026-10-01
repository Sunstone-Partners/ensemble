/**
 * Identifies "the same failing test" across cosmetic command variations.
 *
 * The cap keyed on the literal command string, which the model varies freely.
 * Observed: the same failure was retried as `npx jest live-e2e 2>&1 | tail -5`
 * and then `npx jest live-e2e 2>&1 | sed -n 1,60p`. Those are one issue, but
 * counted as two, so a cap of 1 permitted two fix attempts.
 *
 * Normalisation strips the parts that do not change WHICH tests run:
 * output plumbing (pipes, redirections) and surrounding whitespace.
 * It deliberately does NOT strip test-selection arguments -- `jest auth` and
 * `jest billing` are different issues and must keep separate budgets.
 */
export function normalizeIssueKey(command: string): string {
  let s = command.trim();
  // Drop everything from the first unquoted pipe: `| tail -5`, `| sed …`.
  const pipe = s.search(/(?<!\|)\|(?!\|)/);
  if (pipe >= 0) s = s.slice(0, pipe);
  // Drop stream redirections: `2>&1`, `> out.txt`, `2> err`.
  s = s.replace(/\d?>\s*&?\s*\S+/g, " ");
  return s.trim().replace(/\s+/g, " ");
}

export interface BudgetDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * Bounds autofix retries on two independent axes.
 *
 * Per-issue alone is not enough: a run that keeps surfacing DIFFERENT failing
 * commands would spawn an unbounded number of continuations while never
 * exceeding any single issue's cap. The session budget is the backstop that
 * makes the loop terminate regardless of how the failures are spelled.
 */
export class ContinuationBudget {
  private readonly perIssue = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly maxPerIssue = 1,
    private readonly maxPerSession = 3,
  ) {}

  /** Records and authorises an attempt, or explains the refusal. */
  claim(command: string): BudgetDecision {
    const key = normalizeIssueKey(command);
    const used = this.perIssue.get(key) ?? 0;

    if (used >= this.maxPerIssue) {
      return { allowed: false, reason: `issue budget exhausted (${used}/${this.maxPerIssue}): ${key}` };
    }
    if (this.total >= this.maxPerSession) {
      return {
        allowed: false,
        reason: `session budget exhausted (${this.total}/${this.maxPerSession})`,
      };
    }

    this.perIssue.set(key, used + 1);
    this.total += 1;
    return { allowed: true, reason: `attempt ${used + 1}/${this.maxPerIssue} for ${key}` };
  }

  get spent(): number {
    return this.total;
  }
}
