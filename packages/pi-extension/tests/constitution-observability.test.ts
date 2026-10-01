import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BehaviorInvocation, CompiledBehaviorPackage } from "@sunstone-partners/ensemble-agent-core";
import { BehaviorRunRecord, ConstitutionProvider, createBehaviorInvoker } from "../src/behavior-runner";

/**
 * br-zcxb. The constitution step used to record NOTHING when no change came
 * back, so three different situations were indistinguishable in the runtime
 * log -- all of them an absent `constitution` field:
 *
 *   the behavior was never granted constitution.propose
 *   no rule provider was configured
 *   the provider ran and judged no rule change was warranted
 *
 * That is not a cosmetic gap. It is why a live run was read as "the
 * constitution step never fires", and a P1 bead was filed on that reading,
 * when the step may have run and correctly declined: the failure under
 * repair was `a - b` where `a + b` was meant, and a typo does not imply a
 * constitutional rule.
 *
 * These tests pin that each outcome is separately identifiable, because a
 * step that leaves no trace cannot be debugged -- only guessed at.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function gitRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "constitution-obs-"));
  dirs.push(d);
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "a.ts"), "export const a = 1;\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: d, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  return d;
}

function behavior(mutationClasses: string[]): CompiledBehaviorPackage {
  return {
    manifest: {
      metadata: { name: "fixer" },
      policy: { mode: "auto" },
      capabilities: { tools: [], mutation_classes: mutationClasses },
      execution: { test_command: "true" },
    },
    hasMutationAuthority: (cls: string) => mutationClasses.includes(cls),
  } as unknown as CompiledBehaviorPackage;
}

const invocation = {
  behavior: { metadata: { name: "fixer" } },
  event: {
    type: "test.failure.observed",
    payload: { toolName: "bash", command: "npx jest", output: "Tests: 1 failed" },
  },
} as unknown as BehaviorInvocation;

async function run(
  mutationClasses: string[],
  proposeConstitutionChange?: ConstitutionProvider,
): Promise<BehaviorRunRecord> {
  const records: BehaviorRunRecord[] = [];
  const invoke = createBehaviorInvoker({
    rootDir: gitRepo(),
    compiled: () => [behavior(mutationClasses)],
    // No fix candidate: this is exactly the shape of the live run that
    // prompted the bead, where the repair happened on the continuation path
    // and the governed invoker recorded "no fix candidate offered".
    proposeFix: () => undefined,
    proposeConstitutionChange,
    runSuite: () => ({ failures: 0, targetPasses: true, output: "Tests: 1 passed" }),
    records,
  });
  await invoke(invocation);
  return records[0] as BehaviorRunRecord;
}

describe("constitution step is observable in every outcome (br-zcxb)", () => {
  it("records that the provider ran and implied no change", async () => {
    let called = false;
    const record = await run(["artifact.write", "constitution.propose"], () => {
      called = true;
      return undefined;
    });

    // The distinction the log could not previously make: the provider DID
    // run. Without this the absent field reads as "never fired".
    expect(called).toBe(true);
    expect(record.constitution?.status).toBe("none");
    expect(record.constitution?.detail).toMatch(/implied no constitution change/);
  });

  it("records a capability skip, and does not call the provider", async () => {
    let called = false;
    const record = await run(["artifact.write"], () => {
      called = true;
      return undefined;
    });

    // The gate is the point: asking a model on behalf of a behavior that was
    // never granted the capability is both ungoverned and a wasted
    // subprocess per run.
    expect(called).toBe(false);
    expect(record.constitution?.status).toBe("skipped");
    expect(record.constitution?.detail).toMatch(/does not declare constitution\.propose/);
  });

  it("records a granted-but-unconfigured provider as a distinct state", async () => {
    const record = await run(["artifact.write", "constitution.propose"], undefined);

    // Granted the capability and then given nothing to exercise it: a
    // misconfiguration, not a decision, and it must not read as "declined".
    expect(record.constitution?.status).toBe("unavailable");
    expect(record.constitution?.detail).toMatch(/no rule provider is configured/);
  });

  it("distinguishes all three no-change outcomes from each other", async () => {
    const ran = await run(["artifact.write", "constitution.propose"], () => undefined);
    const skipped = await run(["artifact.write"], () => undefined);
    const unconfigured = await run(["artifact.write", "constitution.propose"], undefined);

    const statuses = [ran, skipped, unconfigured].map((r) => r.constitution?.status);
    expect(new Set(statuses).size).toBe(3);
    expect(statuses).not.toContain(undefined);
  });
});
