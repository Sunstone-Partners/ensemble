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
