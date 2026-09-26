import { createHash } from "node:crypto";

/**
 * Stable identity for a test failure (TRD-024 / REQ-006).
 *
 * The retry budget is per-issue, so the key must survive incidental
 * churn: if a key changed between attempts, the counter would reset
 * every time and "three attempts then escalate" would become an
 * infinite loop that never escalates. That is the failure this
 * normalization exists to prevent.
 */

/** Replaces content that varies run-to-run without changing the failure. */
export function normalizeFailureSignature(raw: string): string {
  return raw
    // Absolute path prefixes -> "". Anchored at a leading "/" (or a
    // Windows drive) so only a genuine root prefix is stripped. An
    // unanchored rule also ate directory segments out of RELATIVE
    // paths, collapsing src/moduleA/index.ts and src/moduleB/index.ts
    // to the same string -- two different failing files would then
    // share one issue key and spend each other's retry budget.
    .replace(/(^|[\s("'[])(?:[A-Za-z]:)?(?:\/[\w.@ -]+)*\/(?=[\w.@-]*[\w-]\/)/g, "$1")
    .replace(/(^|[\s("'[])(?:[A-Za-z]:)?(?:\/[\w.@-]+)+\/(?=[\w.@-]+\.[\w]+)/g, "$1")
    // ISO timestamps.
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "<ts>")
    // Clock times and durations.
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|seconds)\b/g, "<dur>")
    // Hex ids, uuids, and object addresses.
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<addr>")
    .replace(/\b[0-9a-f]{32,}\b/gi, "<hash>")
    // Process/worker ids and line:col noise from stack frames.
    .replace(/\b(pid|worker)[ =:]+\d+/gi, "$1=<n>")
    .replace(/:\d+:\d+\b/g, ":<line>:<col>")
    .replace(/\s+/g, " ")
    .trim();
}

export interface IssueKeyInput {
  /** Stable test identifier, e.g. "suite > case name". */
  testId: string;
  /** Raw failure output for this run. */
  failureOutput: string;
}

export function issueKey(input: IssueKeyInput): string {
  const signature = normalizeFailureSignature(input.failureOutput);
  return createHash("sha256")
    .update(input.testId)
    .update("\u0000")
    .update(signature)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Per-issue attempt counters for one session.
 *
 * Not persisted, for the same reason the matcher is not: a durable
 * counter implies recovery semantics this design does not provide.
 */
export class RetryBudget {
  private readonly attempts = new Map<string, number>();

  constructor(public readonly limit: number = 3) {}

  attemptsFor(key: string): number {
    return this.attempts.get(key) ?? 0;
  }

  /** True when another attempt is permitted for this issue. */
  canAttempt(key: string): boolean {
    return this.attemptsFor(key) < this.limit;
  }

  recordFailure(key: string): number {
    const next = this.attemptsFor(key) + 1;
    this.attempts.set(key, next);
    return next;
  }

  /** Clears the counter after a success, so a later unrelated failure gets a full budget. */
  reset(key: string): void {
    this.attempts.delete(key);
  }

  get exhausted(): string[] {
    return [...this.attempts.entries()].filter(([, n]) => n >= this.limit).map(([k]) => k);
  }
}
