import { ApprovalGate, ApprovalHost } from "@sunstone-partners/ensemble-agent-core";
import { ConstitutionProposal, ConstitutionChange, PullRequestRef } from "../src/constitution-proposal";

function host(hasUI: boolean, answer = true): ApprovalHost & { asked: string[] } {
  return {
    hasUI,
    asked: [],
    async confirm(title: string) {
      (this as { asked: string[] }).asked.push(title);
      return answer;
    },
  };
}

const change: ConstitutionChange = {
  behaviorName: "investigate-test-failure",
  rationale: "recurring flake class is unaddressed",
  diff: "+ tests must not depend on wall-clock ordering",
};

function proposal(h: ApprovalHost, onOpen?: () => void) {
  const opened: ConstitutionChange[] = [];
  const applied: ConstitutionChange[] = [];
  const p = new ConstitutionProposal({
    approval: new ApprovalGate(h),
    applyChange: (c) => {
      applied.push(c);
      return { path: "docs/standards/constitution.md", detail: "appended" };
    },
    openPullRequest: (c): PullRequestRef => {
      onOpen?.();
      opened.push(c);
      return { url: "https://example.test/pr/1", branch: "ensemble/constitution/1" };
    },
  });
  return { p, opened, applied };
}

/**
 * br-9uqd supersedes TRD-029 / REQ-007's invariant that constitution.md is
 * "never modified in place". Approval now APPLIES the change and the pull
 * request became delivery rather than permission.
 *
 * Why the invariant went: it made step 3 of the product loop -- detect, RCA,
 * UPDATE THE CONSTITUTION, fix, verify -- unfinishable in-session. The rule
 * meant to prevent recurrence lived only on an unmerged branch, so the next
 * run met the same failure with the same constitution.
 *
 * What did NOT go, and is still asserted below: approval is explicit, "no"
 * applies nothing, and a headless session behaves exactly like "no".
 */
describe("constitution changes are gated, then applied (br-9uqd)", () => {
  it("AC-007-1 (retained): a 'no' answer applies nothing and opens no PR", async () => {
    const h = host(true, false);
    const { p, opened, applied } = proposal(h);

    const out = await p.propose(change);

    expect(out.status).toBe("declined");
    expect(applied).toEqual([]);
    expect(opened).toEqual([]);
    expect(h.asked).toEqual(["Apply constitution change"]);
  });

  it("a 'yes' answer applies the change in place, and delivers it", async () => {
    const { p, opened, applied } = proposal(host(true, true));

    const out = await p.propose(change);

    expect(out.status).toBe("applied");
    if (out.status !== "applied") throw new Error("unreachable");
    expect(applied).toHaveLength(1);
    expect(out.applied.path).toBe("docs/standards/constitution.md");
    // The PR still happens; it is now delivery of an applied change.
    expect(out.pr?.url).toMatch(/^https:/);
    expect(opened).toHaveLength(1);
  });

  it("applies even with no PR backend configured at all", async () => {
    // Delivery is optional; consent is not. A repo with no PR mechanism
    // must still be able to record a decision its maintainer made.
    const applied: ConstitutionChange[] = [];
    const p = new ConstitutionProposal({
      approval: new ApprovalGate(host(true, true)),
      applyChange: (c) => {
        applied.push(c);
        return { path: "docs/standards/constitution.md", detail: "appended" };
      },
    });

    const out = await p.propose(change);

    expect(out.status).toBe("applied");
    expect(applied).toHaveLength(1);
  });

  it("keeps an approved change when delivery fails", async () => {
    // Losing the maintainer's decision is worse than delivering it late.
    const p = new ConstitutionProposal({
      approval: new ApprovalGate(host(true, true)),
      applyChange: () => ({ path: "docs/standards/constitution.md", detail: "appended" }),
      openPullRequest: () => {
        throw new Error("gh not authenticated");
      },
    });

    const out = await p.propose(change);

    expect(out.status).toBe("applied");
    if (out.status !== "applied") throw new Error("unreachable");
    expect(out.deliveryError).toContain("gh not authenticated");
  });

  it("AC-007-3 (retained): hasUI === false matches the 'no' branch exactly", async () => {
    const h = host(false);
    const { p, opened, applied } = proposal(h);

    const headless = await p.propose(change);
    const declined = await proposal(host(true, false)).p.propose(change);

    expect(headless.status).toBe(declined.status);
    expect(applied).toEqual([]);
    expect(opened).toEqual([]);
    // Never asked, because there is nothing to ask on.
    expect(h.asked).toEqual([]);
  });

  it("nothing is applied or opened before the answer is known", async () => {
    let openedEarly = false;
    let appliedEarly = false;
    const h: ApprovalHost = {
      hasUI: true,
      async confirm() {
        expect(openedEarly).toBe(false);
        expect(appliedEarly).toBe(false);
        return false;
      },
    };
    const p = new ConstitutionProposal({
      approval: new ApprovalGate(h),
      applyChange: () => {
        appliedEarly = true;
        return { path: "docs/standards/constitution.md", detail: "appended" };
      },
      openPullRequest: () => {
        openedEarly = true;
        return { url: "u", branch: "b" };
      },
    });

    await p.propose(change);

    expect(openedEarly).toBe(false);
    expect(appliedEarly).toBe(false);
  });
});

describe("when the approved change cannot be applied", () => {
  it("reports failure instead of rejecting, and does not claim the human declined", async () => {
    let prOpened = false;
    const p = new ConstitutionProposal({
      approval: new ApprovalGate(host(true, true)),
      applyChange: () => {
        // e.g. the file is gone, the disk is full, or re-baselining the
        // write boundary throws.
        throw new Error("EACCES: permission denied, open 'docs/standards/constitution.md'");
      },
      openPullRequest: (): PullRequestRef => {
        prOpened = true;
        return { url: "x", branch: "y" };
      },
    });

    const outcome = await p.propose(change);

    // Not "declined": nobody refused anything. Blaming the maintainer for a
    // broken applier would hide the bug behind a normal-looking outcome.
    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.reason).toContain("EACCES");
    // And nothing is delivered for a change that never landed.
    expect(prOpened).toBe(false);
  });
});
