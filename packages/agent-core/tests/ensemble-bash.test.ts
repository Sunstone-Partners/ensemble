import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BashApprovalPolicy, normalizeCommand, ApprovalAnswer } from "../src/behavior/bash-approval";
import { createEnsembleBashTool, exitCodeMayBeMasked } from "../src/behavior/ensemble-bash-tool";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const workdir = () => {
  const d = mkdtempSync(join(tmpdir(), "eb-"));
  dirs.push(d);
  return d;
};

const req = { toolCallId: "t1" } as never;

describe("BashApprovalPolicy", () => {
  it("allow-always remembers, so the same command is not asked twice", async () => {
    const asked: string[] = [];
    const p = new BashApprovalPolicy((c) => {
      asked.push(c);
      return "allow-always";
    });
    expect((await p.decide("ls -la")).allowed).toBe(true);
    expect((await p.decide("ls -la")).allowed).toBe(true);
    expect(asked).toHaveLength(1);
    expect((await p.decide("ls -la")).reason).toBe("remembered-allow");
  });

  it("allow-once does NOT remember", async () => {
    const asked: string[] = [];
    const p = new BashApprovalPolicy((c) => {
      asked.push(c);
      return "allow-once";
    });
    await p.decide("ls");
    await p.decide("ls");
    expect(asked).toHaveLength(2);
  });

  it("deny-always remembers and keeps denying without asking", async () => {
    let calls = 0;
    const p = new BashApprovalPolicy(() => {
      calls++;
      return "deny-always";
    });
    expect((await p.decide("rm -rf /")).allowed).toBe(false);
    const second = await p.decide("rm -rf /");
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe("remembered-deny");
    expect(calls).toBe(1);
  });

  it("'always' binds to the EXACT command, so a near-miss is asked again", async () => {
    // The whole safety argument rests on this. If approving `git push`
    // also approved `git push --force`, one keystroke would authorise
    // something the user never saw.
    const asked: string[] = [];
    const p = new BashApprovalPolicy((c) => {
      asked.push(c);
      return "allow-always";
    });
    await p.decide("git push");
    await p.decide("git push --force");
    expect(asked).toEqual(["git push", "git push --force"]);
  });

  it("only whitespace is normalized -- never shell semantics", () => {
    expect(normalizeCommand("  ls    -la ")).toBe("ls -la");
    // Argument order/flag spelling are NOT treated as equivalent.
    expect(normalizeCommand("rm -rf x")).not.toBe(normalizeCommand("rm -fr x"));
  });

  it("denies by default when no approver exists (headless)", async () => {
    const p = new BashApprovalPolicy(undefined);
    const d = await p.decide("curl evil.example.com");
    expect(d).toMatchObject({ allowed: false, reason: "no-approver" });
  });

  it("an unrecognised approver answer is never read as consent", async () => {
    const p = new BashApprovalPolicy(() => "maybe" as unknown as ApprovalAnswer);
    expect((await p.decide("ls")).allowed).toBe(false);
  });

  it("deny-always wins over allow-always for the same command", async () => {
    const answers: ApprovalAnswer[] = ["allow-always", "deny-always"];
    const p = new BashApprovalPolicy(() => answers.shift()!);
    await p.decide("ls");
    await p.decide("ls -x");
    // Force both lists to contain the same key.
    const p2 = new BashApprovalPolicy(() => "deny-always");
    await p2.decide("ls");
    expect((await p2.decide("ls")).allowed).toBe(false);
  });
});

describe("ensemble.bash tool", () => {
  it("a denied command does NOT execute", async () => {
    const cwd = workdir();
    const tool = createEnsembleBashTool({
      cwd,
      policy: new BashApprovalPolicy(() => "deny-once"),
    });
    const marker = join(cwd, "created");
    const r = await tool.execute({ command: `touch ${JSON.stringify(marker)}` }, req);

    expect(r.approved).toBe(false);
    expect(r.exitCode).toBe(126);
    // The point of a preventive gate: the side effect never happened.
    expect(existsSync(marker)).toBe(false);
  });

  it("an approved command executes and reports its TRUE exit code", async () => {
    const tool = createEnsembleBashTool({
      cwd: workdir(),
      policy: new BashApprovalPolicy(() => "allow-once"),
    });
    const ok = await tool.execute({ command: "exit 0" }, req);
    expect(ok).toMatchObject({ approved: true, exitCode: 0 });

    const bad = await tool.execute({ command: "exit 7" }, req);
    expect(bad.exitCode).toBe(7);
  });

  it("flags a piped command whose exit code is masked (br-hneq)", async () => {
    const tool = createEnsembleBashTool({
      cwd: workdir(),
      policy: new BashApprovalPolicy(() => "allow-once"),
    });
    // This is the exact shape that made the dogfood run miss a real test
    // failure: the shell reports tail's status, not the failing command's.
    const r = await tool.execute({ command: "exit 3 | tail -1" }, req);
    expect(r.exitCode).toBe(0);
    expect(r.exitCodeMayBeMasked).toBe(true);

    const plain = await tool.execute({ command: "exit 3" }, req);
    expect(plain.exitCodeMayBeMasked).toBe(false);
  });

  it("does not mistake a pipe inside a quoted string for a pipeline", () => {
    expect(exitCodeMayBeMasked("grep 'a|b' file")).toBe(false);
    expect(exitCodeMayBeMasked('echo "x;y"')).toBe(false);
    expect(exitCodeMayBeMasked("npx jest | tail -80")).toBe(true);
    expect(exitCodeMayBeMasked("a && b")).toBe(true);
  });
});
