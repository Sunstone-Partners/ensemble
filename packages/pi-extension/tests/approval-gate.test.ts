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
  const p = new ConstitutionProposal({
    approval: new ApprovalGate(h),
    openPullRequest: (c): PullRequestRef => {
      onOpen?.();
      opened.push(c);
      return { url: "https://example.test/pr/1", branch: "ensemble/constitution/1" };
    },
  });
  return { p, opened };
}

describe("constitution proposals are gated (TRD-029 / REQ-007)", () => {
  it("AC-007-1: a 'no' answer opens no PR", async () => {
    const h = host(true, false);
    const { p, opened } = proposal(h);

    const out = await p.propose(change);

    expect(out.status).toBe("declined");
    expect(opened).toEqual([]);
    expect(h.asked).toEqual(["Propose constitution change"]);
  });

  it("AC-007-2: a 'yes' answer opens a PR and does not modify the constitution in place", async () => {
    const { p, opened } = proposal(host(true, true));

    const out = await p.propose(change);

    expect(out.status).toBe("proposed");
    if (out.status !== "proposed") throw new Error("unreachable");
    expect(out.pr.url).toMatch(/^https:/);
    expect(opened).toHaveLength(1);
    // The only write path is the PR; nothing here touches the file.
    expect(JSON.stringify(out)).not.toMatch(/constitution\.md/);
  });

  it("AC-007-3: hasUI === false matches the 'no' branch exactly", async () => {
    const h = host(false);
    const { p, opened } = proposal(h);

    const headless = await p.propose(change);
    const declined = await proposal(host(true, false)).p.propose(change);

    expect(headless.status).toBe(declined.status);
    expect(opened).toEqual([]);
    // Never asked, because there is nothing to ask on.
    expect(h.asked).toEqual([]);
  });

  it("the PR is never opened before the answer is known", async () => {
    // Guards against an implementation that opens optimistically and
    // closes on refusal, which would still create review noise.
    let openedEarly = false;
    const h: ApprovalHost = {
      hasUI: true,
      async confirm() {
        expect(openedEarly).toBe(false);
        return false;
      },
    };
    const { p } = proposal(h, () => {
      openedEarly = true;
    });

    await p.propose(change);
    expect(openedEarly).toBe(false);
  });
});
