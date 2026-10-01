import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMutationGuard,
  compile,
  WorkspaceSnapshot,
  ApprovalGate,
  ApprovalHost,
  BehaviorManifest,
} from "@sunstone-partners/ensemble-agent-core";
import { AutofixLoop, CandidateWrite, SuiteResult } from "../src/autofix-loop";
import { issueKey, normalizeFailureSignature, RetryBudget } from "../src/issue-identity";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "autofix-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "original-a");
  writeFileSync(join(root, "src", "b.ts"), "original-b");
  writeFileSync(join(root, "tests", "a.test.ts"), "expect(sum(1,2)).toBe(3)");
  return root;
}

function guard(mode: "auto" | "propose" = "auto") {
  const manifest: BehaviorManifest = {
    api_version: "ensemble.sunstone.dev/v1",
    kind: "Behavior",
    metadata: { name: "fixer", version: "1.0.0" },
    trigger: { event_type: "test.failure.observed" },
    policy: { mode, timeout: "30m" },
    capabilities: { tools: ["read", "write"], mutation_classes: ["artifact.write"] },
    execution: mode === "auto" ? { graph: "fixer", test_command: "npm test" } : { graph: "fixer" },
    outcomes: ["test.failure.investigated"],
  };
  const { compiled, errors } = compile({ behaviors: [manifest] });
  expect(errors).toEqual([]);
  return createMutationGuard(compiled[0]);
}

function loop(root: string, suite: SuiteResult | (() => SuiteResult), opts: {
  mode?: "auto" | "propose";
  approval?: ApprovalGate;
  budget?: RetryBudget;
  failWriteAt?: number;
} = {}) {
  let writeCount = 0;
  return new AutofixLoop({
    guard: guard(opts.mode ?? "auto"),
    snapshot: () => new WorkspaceSnapshot(root),
    applyWrite: (w: CandidateWrite) => {
      writeCount += 1;
      if (opts.failWriteAt === writeCount) throw new Error("disk full");
      writeFileSync(join(root, w.path), w.contents);
    },
    runSuite: () => (typeof suite === "function" ? suite() : suite),
    approval: opts.approval,
    budget: opts.budget,
  });
}

const write = (path: string, contents: string): CandidateWrite => ({
  path,
  contents,
  mutationClass: "artifact.write",
});

const failure = { testId: "sum > adds", failureOutput: "expected 3 got 4" };

describe("IssueIdentity (TRD-024 / REQ-006)", () => {
  it("AC-006-3: identical normalized signatures produce equal keys", () => {
    expect(issueKey(failure)).toBe(issueKey({ ...failure }));
  });

  it("different signatures produce different keys", () => {
    expect(issueKey(failure)).not.toBe(issueKey({ ...failure, failureOutput: "expected 3 got 5" }));
  });

  it("keys survive timestamps, absolute paths, durations and pids", () => {
    // If these varied the key, the retry counter would reset every
    // attempt and the budget would never escalate.
    const a = {
      testId: "sum > adds",
      failureOutput: "2026-01-02T03:04:05Z /Users/alice/repo/src/a.ts:12:4 failed in 1.23s pid=991 0xdeadbeef",
    };
    const b = {
      testId: "sum > adds",
      failureOutput: "2026-09-09T11:22:33Z /home/bob/other/src/a.ts:88:1 failed in 9.99s pid=12 0xfeedface",
    };
    expect(normalizeFailureSignature(a.failureOutput)).toBe(normalizeFailureSignature(b.failureOutput));
    expect(issueKey(a)).toBe(issueKey(b));
  });

  it("a different test with the same output is still a different issue", () => {
    expect(issueKey(failure)).not.toBe(issueKey({ ...failure, testId: "product > multiplies" }));
  });
});

describe("staged apply through MutationGuard (TRD-025 / AC-005-1)", () => {
  it("accepts a clean candidate when the full suite is green", async () => {
    const root = repo();
    const out = await loop(root, { failures: 0, targetPasses: true })
      .attempt(failure, { writes: [write("src/a.ts", "fixed-a")] });

    expect(out.status).toBe("accepted");
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("fixed-a");
  });

  it("aborts at the first denial with no partial write surviving", async () => {
    const root = repo();
    // Write 3 targets a test file: refused by the protected-path
    // boundary. Writes 1 and 2 must not survive.
    const out = await loop(root, { failures: 0, targetPasses: true }).attempt(failure, {
      writes: [
        write("src/a.ts", "clobbered-a"),
        write("src/b.ts", "clobbered-b"),
        write("tests/a.test.ts", "expect(true).toBe(true)"),
      ],
    });

    expect(out.status).toBe("rejected");
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("original-a");
    expect(readFileSync(join(root, "src/b.ts"), "utf8")).toBe("original-b");
    expect(readFileSync(join(root, "tests/a.test.ts"), "utf8")).toBe("expect(sum(1,2)).toBe(3)");
  });

  it("a candidate creating a new file has that file removed on rejection", async () => {
    const root = repo();
    await loop(root, { failures: 1, targetPasses: true }).attempt(failure, {
      writes: [write("src/new.ts", "created")],
    });
    expect(existsSync(join(root, "src/new.ts"))).toBe(false);
  });

  it("the loop gets no privileged path: propose mode denies it too", async () => {
    const root = repo();
    const out = await loop(root, { failures: 0, targetPasses: true }, { mode: "propose" })
      .attempt(failure, { writes: [write("src/a.ts", "fixed-a")] });

    expect(out.status).toBe("rejected");
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("original-a");
  });
});

describe("full-suite verification (TRD-026 / AC-005-2)", () => {
  it("rejects when the target passes but an unrelated test fails", async () => {
    const root = repo();
    const out = await loop(root, { failures: 1, targetPasses: true })
      .attempt(failure, { writes: [write("src/a.ts", "fixed-a")] });

    expect(out.status).toBe("rejected");
    if (out.status !== "rejected") throw new Error("unreachable");
    expect(out.reason).toMatch(/1 failure/);
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("original-a");
  });

  it("rejects when the target test itself still fails", async () => {
    const root = repo();
    const out = await loop(root, { failures: 1, targetPasses: false })
      .attempt(failure, { writes: [write("src/a.ts", "not-a-fix")] });

    expect(out.status).toBe("rejected");
    if (out.status !== "rejected") throw new Error("unreachable");
    expect(out.reason).toMatch(/target test still fails/);
  });
});

describe("adversarial rejection (TRD-027 / AC-005-4)", () => {
  it("the gut-the-assertion candidate is refused mechanically, with the suite green", async () => {
    // The candidate deletes the failing assertion. The suite would
    // report zero failures, so any model-judgment-based check would
    // accept it. It must be refused by the write boundary before the
    // suite is ever consulted.
    const root = repo();
    let suiteRan = false;
    const out = await loop(root, () => {
      suiteRan = true;
      return { failures: 0, targetPasses: true };
    }).attempt(failure, { writes: [write("tests/a.test.ts", "// assertion removed")] });

    expect(out.status).toBe("rejected");
    if (out.status !== "rejected") throw new Error("unreachable");
    expect(out.reason).toMatch(/protected path/);
    expect(suiteRan).toBe(false);
    expect(readFileSync(join(root, "tests/a.test.ts"), "utf8")).toBe("expect(sum(1,2)).toBe(3)");
  });

  it("a rejected attempt leaves the tree byte-identical and still counts against the budget", async () => {
    const root = repo();
    const before = ["src/a.ts", "src/b.ts", "tests/a.test.ts"].map((p) => readFileSync(join(root, p)));
    const l = loop(root, { failures: 2, targetPasses: true });

    await l.attempt(failure, { writes: [write("src/a.ts", "x"), write("src/b.ts", "y")] });

    const after = ["src/a.ts", "src/b.ts", "tests/a.test.ts"].map((p) => readFileSync(join(root, p)));
    after.forEach((buf, i) => expect(buf.equals(before[i])).toBe(true));
    expect(l.retryBudget.attemptsFor(issueKey(failure))).toBe(1);
  });
});

describe("retry budget and escalation (TRD-028 / AC-006-1, AC-006-2)", () => {
  function approvalHost(): ApprovalHost & { asked: string[] } {
    return {
      hasUI: true,
      asked: [],
      async confirm(title: string) {
        (this as { asked: string[] }).asked.push(title);
        return true;
      },
    };
  }

  it("AC-006-2: a third rejection escalates and no fourth attempt occurs", async () => {
    const root = repo();
    const host = approvalHost();
    let suiteRuns = 0;
    const l = loop(root, () => {
      suiteRuns += 1;
      return { failures: 1, targetPasses: true };
    }, { approval: new ApprovalGate(host) });

    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await l.attempt(failure, { writes: [write("src/a.ts", `try-${i}`)] }));
    }

    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "escalated", "escalated"]);
    expect(host.asked).toHaveLength(2);
    // The suite is not re-run once the budget is spent.
    expect(suiteRuns).toBe(3);
  });

  it("AC-006-1: success on attempt two resets that issue's counter", async () => {
    const root = repo();
    let call = 0;
    const l = loop(root, () => {
      call += 1;
      return call === 1 ? { failures: 1, targetPasses: true } : { failures: 0, targetPasses: true };
    });

    expect((await l.attempt(failure, { writes: [write("src/a.ts", "t1")] })).status).toBe("rejected");
    expect((await l.attempt(failure, { writes: [write("src/a.ts", "t2")] })).status).toBe("accepted");
    expect(l.retryBudget.attemptsFor(issueKey(failure))).toBe(0);
  });

  it("budgets are per-issue: one exhausted issue does not block another", async () => {
    const root = repo();
    const l = loop(root, { failures: 1, targetPasses: true });
    const other = { testId: "other > case", failureOutput: "boom" };

    for (let i = 0; i < 3; i += 1) await l.attempt(failure, { writes: [write("src/a.ts", `x${i}`)] });

    expect(l.retryBudget.canAttempt(issueKey(failure))).toBe(false);
    expect(l.retryBudget.canAttempt(issueKey(other))).toBe(true);
  });

  it("escalation still reports when no approval gate is configured", async () => {
    const root = repo();
    const budget = new RetryBudget(1);
    const l = loop(root, { failures: 1, targetPasses: true }, { budget });

    await l.attempt(failure, { writes: [write("src/a.ts", "x")] });
    const out = await l.attempt(failure, { writes: [write("src/a.ts", "y")] });

    expect(out.status).toBe("escalated");
    if (out.status !== "escalated") throw new Error("unreachable");
    expect(out.approvalRequested).toBe(false);
  });
});

describe("issue keys do not collide across different relative paths", () => {
  it("two different failing files are two different issues", () => {
    // An unanchored path rule collapsed src/moduleA/index.ts and
    // src/moduleB/index.ts to the same signature, so unrelated
    // failures shared one retry budget.
    const a = { testId: "suite > case", failureOutput: "at src/moduleA/index.ts expected 1" };
    const b = { testId: "suite > case", failureOutput: "at src/moduleB/index.ts expected 1" };

    expect(normalizeFailureSignature(a.failureOutput)).not.toBe(normalizeFailureSignature(b.failureOutput));
    expect(issueKey(a)).not.toBe(issueKey(b));
  });

  it("still strips absolute prefixes so the same file in different checkouts matches", () => {
    const a = { testId: "t", failureOutput: "at /Users/alice/repo/src/a.ts boom" };
    const b = { testId: "t", failureOutput: "at /home/bob/work/src/a.ts boom" };
    expect(issueKey(a)).toBe(issueKey(b));
  });

  it("budgets stay separate for colliding-looking paths", async () => {
    const root = repo();
    const l = loop(root, { failures: 1, targetPasses: true });
    const a = { testId: "s", failureOutput: "at src/moduleA/index.ts" };
    const b = { testId: "s", failureOutput: "at src/moduleB/index.ts" };

    for (let i = 0; i < 3; i += 1) await l.attempt(a, { writes: [write("src/a.ts", `x${i}`)] });

    expect(l.retryBudget.canAttempt(issueKey(a))).toBe(false);
    expect(l.retryBudget.canAttempt(issueKey(b))).toBe(true);
  });
});

describe("an I/O failure mid-apply is handled like a denial", () => {
  it("restores the tree and spends budget instead of propagating", async () => {
    const root = repo();
    const l = loop(root, { failures: 0, targetPasses: true }, { failWriteAt: 2 });

    const out = await l.attempt(failure, {
      writes: [write("src/a.ts", "partial"), write("src/b.ts", "never")],
    });

    expect(out.status).toBe("rejected");
    if (out.status !== "rejected") throw new Error("unreachable");
    expect(out.reason).toMatch(/disk full/);
    // AC-005-1: no partial write survives.
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("original-a");
    expect(l.retryBudget.attemptsFor(issueKey(failure))).toBe(1);
  });
});

describe("verification time budget (TRD-030 / NFR-4)", () => {
  function timedLoop(root: string, perRunMs: number, timeoutMs: number) {
    let clock = 0;
    const l = new AutofixLoop({
      guard: guard("auto"),
      snapshot: () => new WorkspaceSnapshot(root),
      applyWrite: (w: CandidateWrite) => writeFileSync(join(root, w.path), w.contents),
      runSuite: () => {
        clock += perRunMs;
        return { failures: 1, targetPasses: true };
      },
      timeoutMs,
      now: () => clock,
    });
    return l;
  }

  it("a suite overrunning the declared timeout escalates instead of vouching for the fix", async () => {
    const root = repo();
    const l = timedLoop(root, 5000, 1000);

    const out = await l.attempt(failure, { writes: [write("src/a.ts", "x")] });

    expect(out.status).toBe("escalated");
    if (out.status !== "escalated") throw new Error("unreachable");
    expect(out.reason).toMatch(/exceeded the declared timeout/);
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("original-a");
  });

  it("the budget is across attempts, not per attempt", async () => {
    // Three attempts each under the limit must not be allowed to run
    // three times the declared total.
    const root = repo();
    const l = timedLoop(root, 400, 1000);

    const first = await l.attempt(failure, { writes: [write("src/a.ts", "1")] });
    const second = await l.attempt(failure, { writes: [write("src/a.ts", "2")] });
    const third = await l.attempt(failure, { writes: [write("src/a.ts", "3")] });

    expect(first.status).toBe("rejected");
    expect(second.status).toBe("rejected");
    expect(third.status).toBe("escalated");
    expect(l.elapsedFor(issueKey(failure))).toBeGreaterThanOrEqual(1000);
  });

  it("no timeout configured means no time-based escalation", async () => {
    const root = repo();
    const out = await loop(root, { failures: 0, targetPasses: true })
      .attempt(failure, { writes: [write("src/a.ts", "x")] });
    expect(out.status).toBe("accepted");
  });
});

describe("the timeout actually terminates the run (TRD-030 AC: no orphaned process)", () => {
  it("aborts a hanging suite instead of waiting for it forever", async () => {
    const root = repo();
    let aborted = false;

    const l = new AutofixLoop({
      guard: guard("auto"),
      snapshot: () => new WorkspaceSnapshot(root),
      applyWrite: (w: CandidateWrite) => writeFileSync(join(root, w.path), w.contents),
      // Never resolves on its own. If the loop only measured elapsed
      // time after resolution, this test would hang forever.
      runSuite: (signal: AbortSignal) =>
        new Promise<SuiteResult>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
      timeoutMs: 50,
    });

    const out = await l.attempt(failure, { writes: [write("src/a.ts", "x")] });

    expect(aborted).toBe(true);
    expect(out.status).toBe("escalated");
    if (out.status !== "escalated") throw new Error("unreachable");
    expect(out.reason).toMatch(/aborted/);
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("original-a");
  });

  it("kills a real child process rather than orphaning it", async () => {
    const root = repo();
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    let child: import("node:child_process").ChildProcess | undefined;

    const l = new AutofixLoop({
      guard: guard("auto"),
      snapshot: () => new WorkspaceSnapshot(root),
      applyWrite: (w: CandidateWrite) => writeFileSync(join(root, w.path), w.contents),
      runSuite: (signal: AbortSignal) =>
        new Promise<SuiteResult>((resolve) => {
          // A real process that would outlive the budget.
          child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { signal });
          child.on("error", () => undefined);
          child.on("exit", () => resolve({ failures: 0, targetPasses: true }));
        }),
      timeoutMs: 100,
    });

    await l.attempt(failure, { writes: [write("src/a.ts", "x")] });

    // The AbortSignal reached the child and it is gone.
    await new Promise((r) => setTimeout(r, 100));
    expect(child).toBeDefined();
    expect(child!.killed || child!.exitCode !== null || child!.signalCode !== null).toBe(true);
  });

  it("a suite that throws is a failed attempt, not a crash", async () => {
    const root = repo();
    const l = loop(root, () => {
      throw new Error("mix: command not found");
    });

    const out = await l.attempt(failure, { writes: [write("src/a.ts", "x")] });
    expect(out.status).toBe("rejected");
    if (out.status !== "rejected") throw new Error("unreachable");
    expect(out.reason).toMatch(/command not found/);
  });
});
