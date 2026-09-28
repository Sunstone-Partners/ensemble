import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BehaviorInvocation, CompiledBehaviorPackage } from "@sunstone-partners/ensemble-agent-core";
import { BehaviorRunRecord, createBehaviorInvoker, FixProvider } from "../src/behavior-runner";

/**
 * br-x36p. The governed dispatch resolved every root from the EXTENSION
 * HOST's process.cwd(), while the failing command's own cwd travelled in the
 * event payload and was used only by the continuation path.
 *
 * Observed live: failing commands ran in /private/tmp/wt-autofix-fix, and
 * fix-agent children wrote into the maintainer's MAIN CHECKOUT --
 * event-translator.ts and agent-fix-provider.ts were both modified there, on
 * the strength of a failure that happened somewhere else entirely.
 *
 * These tests pin that the repo under repair is the one the failure came
 * from. Two separate git repos are used, because the whole defect is the two
 * being confused: asserting against a single directory could not fail.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function gitRepo(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `dispatch-root-${label}-`));
  dirs.push(d);
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "a.ts"), `export const from = "${label}";\n`);
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

function invocationWithCwd(cwd?: string): BehaviorInvocation {
  return {
    behavior: { metadata: { name: "fixer" } },
    event: {
      id: "e1",
      type: "test.failure.observed",
      source: "test",
      occurredAt: new Date().toISOString(),
      payload: {
        toolName: "bash",
        command: "npx jest",
        output: "Tests: 1 failed",
        ...(cwd ? { cwd } : {}),
      },
    },
  } as unknown as BehaviorInvocation;
}

async function run(
  hostRoot: string,
  invocation: BehaviorInvocation,
  proposeFix: FixProvider,
): Promise<BehaviorRunRecord> {
  const records: BehaviorRunRecord[] = [];
  const invoke = createBehaviorInvoker({
    rootDir: hostRoot,
    compiled: () => [compiled],
    proposeFix,
    runSuite: () => ({ failures: 0, targetPasses: true, output: "Tests: 1 passed" }),
    records,
  });
  await invoke(invocation);
  return records[0] as BehaviorRunRecord;
}

const fix: FixProvider = () => ({
  writes: [{ path: "src/a.ts", contents: 'export const from = "fixed";\n', mutationClass: "artifact.write" }],
});

describe("governed dispatch uses the failing command's repo (br-x36p)", () => {
  it("writes into the repo the failure came from, not the extension host's", async () => {
    const host = gitRepo("host");
    const failing = gitRepo("failing");

    await run(host, invocationWithCwd(failing), fix);

    expect(readFileSync(join(failing, "src", "a.ts"), "utf8")).toContain("fixed");
    // The live symptom: the maintainer's checkout modified by a failure that
    // happened elsewhere.
    expect(readFileSync(join(host, "src", "a.ts"), "utf8")).toContain('"host"');
  });

  it("falls back to the configured root when the event carries no cwd", async () => {
    // Events without a cwd must behave exactly as before rather than
    // silently doing nothing.
    const host = gitRepo("host-fallback");

    await run(host, invocationWithCwd(undefined), fix);

    expect(readFileSync(join(host, "src", "a.ts"), "utf8")).toContain("fixed");
  });

  it("ignores a non-string or empty cwd rather than resolving against it", async () => {
    // An empty string would resolve to the process cwd, which is the bug
    // wearing a different hat.
    const host = gitRepo("host-empty");
    const invocation = invocationWithCwd(undefined);
    (invocation.event.payload as Record<string, unknown>).cwd = "";

    await run(host, invocation, fix);

    expect(readFileSync(join(host, "src", "a.ts"), "utf8")).toContain("fixed");
  });

  it("runs the verification suite in the failing repo, not the host's", async () => {
    // The verdict has to come from the tree that was actually repaired.
    // runSuite is NOT injected here, so this exercises the real spawn path
    // and the command records where it ran.
    const host = gitRepo("host-suite");
    const failing = gitRepo("failing-suite");

    const suiteCompiled = {
      manifest: {
        metadata: { name: "fixer" },
        policy: { mode: "auto" },
        capabilities: { tools: [], mutation_classes: ["artifact.write"] },
        execution: {
          test_command: 'pwd > suite-ran-here.txt && echo "Tests:       1 passed, 1 total"',
        },
      },
      hasMutationAuthority: (cls: string) => cls === "artifact.write",
    } as unknown as CompiledBehaviorPackage;

    const records: BehaviorRunRecord[] = [];
    const invoke = createBehaviorInvoker({
      rootDir: host,
      compiled: () => [suiteCompiled],
      proposeFix: fix,
      records,
    });
    await invoke(invocationWithCwd(failing));

    expect(existsSync(join(failing, "suite-ran-here.txt"))).toBe(true);
    expect(existsSync(join(host, "suite-ran-here.txt"))).toBe(false);
  });
});
