import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BehaviorInvocation, CompiledBehaviorPackage } from "@sunstone-partners/ensemble-agent-core";
import { BehaviorRunRecord, createBehaviorInvoker, FixProvider } from "../src/behavior-runner";

/**
 * A fix provider runs for minutes while the session keeps working. Its
 * candidate carries whole-file contents computed from what the files held
 * when it STARTED. These tests pin that a candidate is never written over a
 * file that changed during generation -- observed live, where AutofixLoop's
 * apply-time snapshot captured an already-changed file and "restored" it to
 * the change.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "runner-baseline-"));
  dirs.push(d);
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "a.ts"), "export const a = 1;\n");
  return d;
}

function gitRepo(): string {
  const d = tempDir();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: d, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  return d;
}

const compiled = {
  manifest: {
    metadata: { name: "fixer" },
    policy: { mode: "auto" },
    capabilities: { tools: [], mutation_classes: ["artifact.write"] },
    execution: { test_command: "true" },
  },
  hasMutationAuthority: (cls: string) => cls === "artifact.write",
} as unknown as CompiledBehaviorPackage;

const invocation = {
  behavior: { metadata: { name: "fixer" } },
  event: { type: "test.failure.observed", payload: { toolName: "bash", command: "npx jest", output: "Tests: 1 failed" } },
} as unknown as BehaviorInvocation;

async function run(rootDir: string, proposeFix: FixProvider): Promise<BehaviorRunRecord> {
  const records: BehaviorRunRecord[] = [];
  const invoke = createBehaviorInvoker({
    rootDir,
    compiled: () => [compiled],
    proposeFix,
    runSuite: () => ({ failures: 0, targetPasses: true, output: "Tests: 1 passed" }),
    records,
  });
  await invoke(invocation);
  return records[0] as BehaviorRunRecord;
}

const fix = (path: string, contents: string) => ({
  writes: [{ path, contents, mutationClass: "artifact.write" }],
});

describe("behavior runner: pre-provider baseline", () => {
  it("refuses a candidate whose target changed while the fix was being generated", async () => {
    const root = gitRepo();
    const record = await run(root, () => {
      // A concurrent edit lands while the provider is still thinking.
      writeFileSync(join(root, "src", "a.ts"), "export const a = 'human';\n");
      return fix("src/a.ts", "export const a = 2;\n");
    });

    expect(record.outcome?.status).toBe("rejected");
    expect(record.outcome?.status === "rejected" && record.outcome.reason).toMatch(
      /working tree changed at src\/a\.ts while the fix was being generated/,
    );
    // The concurrent edit survives: not overwritten, not "restored" away.
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("export const a = 'human';\n");
  });

  it("applies a candidate whose target did not change", async () => {
    const root = gitRepo();
    const record = await run(root, () => fix("src/a.ts", "export const a = 2;\n"));

    expect(record.outcome?.status).toBe("accepted");
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
  });

  it("compares against uncommitted state, not HEAD", async () => {
    // The tree is often dirty when a test fails; the baseline must be the
    // working tree as it was, or every dirty target would read as stale.
    const root = gitRepo();
    writeFileSync(join(root, "src", "a.ts"), "export const a = 'dirty';\n");
    writeFileSync(join(root, "src", "new.ts"), "untracked\n");
    const record = await run(root, () => ({
      writes: [
        { path: "src/a.ts", contents: "export const a = 3;\n", mutationClass: "artifact.write" },
        { path: "src/new.ts", contents: "fixed\n", mutationClass: "artifact.write" },
      ],
    }));

    expect(record.outcome?.status).toBe("accepted");
  });

  it("detects an untracked target that changed during generation", async () => {
    const root = gitRepo();
    writeFileSync(join(root, "src", "new.ts"), "before\n");
    const record = await run(root, () => {
      writeFileSync(join(root, "src", "new.ts"), "during\n");
      return fix("src/new.ts", "fixed\n");
    });

    expect(record.outcome?.status).toBe("rejected");
    expect(readFileSync(join(root, "src", "new.ts"), "utf8")).toBe("during\n");
  });

  it("says so when no baseline can be taken, rather than silently skipping", async () => {
    const root = tempDir(); // not a git work tree
    const record = await run(root, () => fix("src/a.ts", "export const a = 2;\n"));

    expect(record.note).toMatch(/baseline unavailable/);
    expect(record.outcome?.status).toBe("accepted");
  });
});

/**
 * The before/after check. A fix provider REPLIES with a candidate; it never
 * writes. Observed live: a fix-agent child with write tools edited the main
 * checkout directly. The read-only tool allowlist is one layer; this is the
 * second, and it trusts nothing about the provider -- it looks at the tree.
 */
describe("behavior runner: tree before/after the provider", () => {
  it("refuses the candidate when a non-target file changed during generation", async () => {
    const root = gitRepo();
    const record = await run(root, () => {
      writeFileSync(join(root, "src", "other.ts"), "written by the provider\n");
      return fix("src/a.ts", "export const a = 2;\n");
    });

    expect(record.outcome?.status).toBe("rejected");
    expect(record.outcome?.status === "rejected" && record.outcome.reason).toMatch(
      /working tree changed while the fix was being generated \(src\/other\.ts\)/,
    );
    expect(record.treeDrift).toEqual(["src/other.ts"]);
    // Nothing written, nothing reverted.
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(readFileSync(join(root, "src", "other.ts"), "utf8")).toBe("written by the provider\n");
  });

  it("catches a modified and a deleted tracked file", async () => {
    const root = gitRepo();
    writeFileSync(join(root, "src", "b.ts"), "b\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "b"], { cwd: root });
    const record = await run(root, () => {
      writeFileSync(join(root, "src", "b.ts"), "changed\n");
      rmSync(join(root, "src", "a.ts"));
      return fix("src/c.ts", "c\n");
    });

    expect(record.outcome?.status).toBe("rejected");
    expect(record.treeDrift).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("reports writes even when the provider offers no candidate", async () => {
    // A child that wrote and then replied nothing parseable.
    const root = gitRepo();
    const record = await run(root, () => {
      writeFileSync(join(root, "src", "a.ts"), "export const a = 'child';\n");
      return undefined;
    });

    expect(record.outcome).toBeUndefined();
    expect(record.treeDrift).toEqual(["src/a.ts"]);
    expect(record.note).toMatch(/no fix candidate offered; working tree changed while the provider ran \(src\/a\.ts\)/);
  });

  it("ignores runtime state the session itself writes", async () => {
    const root = gitRepo();
    mkdirSync(join(root, ".beads"));
    writeFileSync(join(root, ".beads", "issues.jsonl"), "{}\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "beads"], { cwd: root });
    const record = await run(root, () => {
      writeFileSync(join(root, ".beads", "issues.jsonl"), "{}\n{}\n");
      mkdirSync(join(root, ".ensemble"));
      writeFileSync(join(root, ".ensemble", "runtime-log.jsonl"), "{}\n");
      return fix("src/a.ts", "export const a = 2;\n");
    });

    expect(record.treeDrift).toBeUndefined();
    expect(record.outcome?.status).toBe("accepted");
  });

  it("does not treat staging an unchanged file as a change", async () => {
    const root = gitRepo();
    writeFileSync(join(root, "src", "new.ts"), "same\n");
    const record = await run(root, () => {
      execFileSync("git", ["add", "src/new.ts"], { cwd: root });
      return fix("src/a.ts", "export const a = 2;\n");
    });

    expect(record.treeDrift).toBeUndefined();
    expect(record.outcome?.status).toBe("accepted");
  });
});
