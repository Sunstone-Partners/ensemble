import { CommitPolicy, CommitRequest, DEFAULT_PROTECTED_BRANCHES } from "../src/commit-policy";

const base: CommitRequest = {
  currentBranch: "feature/x",
  behaviorName: "investigate-test-failure",
  eventId: "evt-123",
  attempt: 2,
  summary: "repair sum rounding",
};

describe("CommitPolicy branch rules (TRD-023 / AC-016-1, AC-016-2)", () => {
  it("never commits in place on the repository default branch", () => {
    for (const branch of DEFAULT_PROTECTED_BRANCHES) {
      const d = new CommitPolicy().authorize({ ...base, currentBranch: branch });
      expect(d.allowed).toBe(true);
      if (!d.allowed) throw new Error("unreachable");
      expect(d.createBranch).toBe(true);
      expect(d.branch).not.toBe(branch);
      expect(d.branch).toMatch(/^ensemble\/autofix\//);
    }
  });

  it("honours a configured default branch that is not a common name", () => {
    const p = new CommitPolicy({ defaultBranch: "production" });
    const d = p.authorize({ ...base, currentBranch: "production" });
    if (!d.allowed) throw new Error("unreachable");
    expect(d.createBranch).toBe(true);
  });

  it("is case-insensitive, so Main is still protected", () => {
    expect(new CommitPolicy().isProtected("Main")).toBe(true);
    expect(new CommitPolicy().isProtected("  MASTER ")).toBe(true);
  });

  it("commits in place on an ordinary feature branch", () => {
    const d = new CommitPolicy().authorize(base);
    if (!d.allowed) throw new Error("unreachable");
    expect(d.createBranch).toBe(false);
    expect(d.branch).toBe("feature/x");
  });
});

describe("CommitPolicy attribution (AC-016-3)", () => {
  it("the message carries behavior name, source event id and attempt number", () => {
    const d = new CommitPolicy().authorize(base);
    if (!d.allowed) throw new Error("unreachable");
    expect(d.message).toContain("investigate-test-failure");
    expect(d.message).toContain("Source-Event: evt-123");
    expect(d.message).toContain("Attempt: 2");
    expect(d.message).toMatch(/Applied automatically/);
  });

  it("refuses when attribution data is missing rather than committing anonymously", () => {
    for (const bad of [{ behaviorName: "" }, { eventId: "" }, { attempt: NaN }]) {
      const d = new CommitPolicy().authorize({ ...base, ...bad } as CommitRequest);
      expect(d.allowed).toBe(false);
    }
  });
});
