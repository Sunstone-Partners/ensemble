import { normalizeIssueKey, ContinuationBudget } from "../src/continuation-budget";

describe("normalizeIssueKey collapses cosmetic command variation", () => {
  // The exact pair observed live: one failure, retried with different output
  // plumbing, counted as two issues and so granted two attempts under a cap of 1.
  it("treats differently-piped runs of the same command as one issue", () => {
    expect(normalizeIssueKey("npx jest live-e2e 2>&1 | tail -5")).toBe(
      normalizeIssueKey("npx jest live-e2e 2>&1 | sed -n 1,60p"),
    );
  });

  it("ignores redirections and whitespace", () => {
    expect(normalizeIssueKey("  npx jest   live-e2e > /tmp/o.txt 2>&1 ")).toBe("npx jest live-e2e");
  });

  // The opposite error would be worse than the bug: collapsing distinct
  // suites into one key would silently refuse to fix the second failure.
  it("keeps genuinely different suites apart", () => {
    expect(normalizeIssueKey("npx jest auth")).not.toBe(normalizeIssueKey("npx jest billing"));
  });
});

describe("ContinuationBudget bounds retries on both axes", () => {
  it("refuses a second attempt at the same issue however it is spelled", () => {
    const b = new ContinuationBudget(1, 10);
    expect(b.claim("npx jest live-e2e | tail -5").allowed).toBe(true);
    const second = b.claim("npx jest live-e2e 2>&1 | sed -n 1,60p");
    expect(second.allowed).toBe(false);
    expect(second.reason).toMatch(/issue budget/);
  });

  // Per-issue caps alone cannot terminate a run that keeps producing new
  // failing commands; the session budget is the backstop that does.
  it("stops an unbounded stream of DIFFERENT failures", () => {
    const b = new ContinuationBudget(1, 2);
    expect(b.claim("npx jest a").allowed).toBe(true);
    expect(b.claim("npx jest b").allowed).toBe(true);
    const third = b.claim("npx jest c");
    expect(third.allowed).toBe(false);
    expect(third.reason).toMatch(/session budget/);
    expect(b.spent).toBe(2);
  });

  it("does not consume budget for a refused attempt", () => {
    const b = new ContinuationBudget(1, 5);
    b.claim("npx jest a");
    b.claim("npx jest a"); // refused
    expect(b.spent).toBe(1);
  });
});
