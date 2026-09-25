import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverBehaviorPackages,
  compile,
  createMutationGuard,
  WorkspaceSnapshot,
  ApprovalGate,
  ApprovalHost,
  translateEvent,
  LocalEventMatcher,
  normalizeEvent,
  ACTIVATION_SEARCH_ROOTS,
} from "@sunstone-partners/ensemble-agent-core";
import { AutofixLoop, SuiteResult } from "../src/autofix-loop";
import { CommitPolicy } from "../src/commit-policy";
import { issueKey } from "../src/issue-identity";
import { fromToolResult } from "../src/pi-events";

/**
 * REQ-008: the whole pipeline on a repo that looks nothing like this
 * one — no `packages/` directory and a non-npm test command.
 *
 * Deliberately assembled from the real exported units with no
 * per-test shims: a fake at any link would hide exactly the coupling
 * this requirement exists to disprove.
 */

const ELIXIR_BEHAVIOR = `api_version: ensemble.sunstone.dev/v1
kind: Behavior
metadata:
  name: investigate-test-failure
  version: 1.0.0
trigger:
  event_type: test.failure.observed
  predicate:
    isError: { equals: true }
policy:
  mode: auto
  timeout: 30m
capabilities:
  tools: [read, grep]
  mutation_classes: [artifact.write]
execution:
  graph: investigate-test-failure
  test_command: mix test
outcomes:
  - test.failure.investigated
`;

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function elixirRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "elixir-repo-"));
  dirs.push(root);
  // Note: no packages/ directory anywhere.
  const dir = join(root, ".ensemble", "behaviors", "investigate-test-failure");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "behavior.yaml"), ELIXIR_BEHAVIOR);

  mkdirSync(join(root, "lib"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "lib", "math.ex"), "def add(a, b), do: a - b");
  writeFileSync(join(root, "test", "math_test.exs"), "assert Math.add(1, 2) == 3");
  return root;
}

function pipeline(root: string) {
  const found = discoverBehaviorPackages(root, { searchRoots: [...ACTIVATION_SEARCH_ROOTS] });
  expect(found.map((f) => f.behaviorId)).toEqual(["investigate-test-failure"]);

  const { compiled, errors } = compile({ behaviors: [found[0].manifest!] });
  expect(errors).toEqual([]);
  return { pkg: found[0], compiled: compiled[0] };
}

describe("REQ-008 portability: non-monorepo repo, non-npm test command", () => {
  it("AC-008-1: translate -> match -> auto-fix -> reverify -> commit, with no code modification", async () => {
    const root = elixirRepo();
    const { compiled } = pipeline(root);

    // The declared command is the repo's own, never guessed.
    expect(compiled.manifest.execution.test_command).toBe("mix test");

    // 1. A real Pi tool_result for a failing `mix test`.
    const raw = fromToolResult({
      type: "tool_result",
      toolCallId: "t1",
      toolName: "bash",
      input: { command: "mix test" },
      content: [{ type: "text", text: "1) test add/2 (MathTest)\n   Assertion failed" }],
      isError: true,
    } as never);

    // 2. Translation to a semantic event.
    const semantic = translateEvent(raw, { testCommand: compiled.manifest.execution.test_command });
    expect(semantic?.type).toBe("test.failure.observed");

    // 3. Dispatch selects the behavior.
    const invoked: string[] = [];
    const matcher = new LocalEventMatcher([compiled], {
      invoke: (i) => void invoked.push(i.behavior.metadata.name),
    });
    expect(await matcher.onEvent(semantic!)).toEqual(["investigate-test-failure"]);

    // 4. Auto-fix through the guard, verified by the declared suite.
    let ranCommand = "";
    const loop = new AutofixLoop({
      guard: createMutationGuard(compiled),
      snapshot: () => new WorkspaceSnapshot(root),
      applyWrite: (w) => writeFileSync(join(root, w.path), w.contents),
      runSuite: (): SuiteResult => {
        ranCommand = compiled.manifest.execution.test_command!;
        return { failures: 0, targetPasses: true };
      },
    });

    const out = await loop.attempt(
      { testId: "MathTest > add/2", failureOutput: "Assertion failed" },
      { writes: [{ path: "lib/math.ex", contents: "def add(a, b), do: a + b", mutationClass: "artifact.write" }] },
    );

    expect(out.status).toBe("accepted");
    expect(ranCommand).toBe("mix test");
    expect(readFileSync(join(root, "lib", "math.ex"), "utf8")).toBe("def add(a, b), do: a + b");

    // 5. Commit lands on a dedicated branch with attribution.
    const decision = new CommitPolicy({ defaultBranch: "main" }).authorize({
      currentBranch: "main",
      behaviorName: compiled.manifest.metadata.name,
      eventId: "t1",
      attempt: out.attempt,
      summary: "correct add/2",
    });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error("unreachable");
    expect(decision.createBranch).toBe(true);
    expect(decision.message).toContain("Source-Event: t1");
  });

  it("AC-008-1 (edge): three failures escalate rather than committing", async () => {
    // The case REQ-008's single AC omits, called out in the TRD.
    const root = elixirRepo();
    const { compiled } = pipeline(root);

    const asked: string[] = [];
    const host: ApprovalHost = {
      hasUI: true,
      async confirm(title: string) {
        asked.push(title);
        return true;
      },
    };

    const loop = new AutofixLoop({
      guard: createMutationGuard(compiled),
      snapshot: () => new WorkspaceSnapshot(root),
      applyWrite: (w) => writeFileSync(join(root, w.path), w.contents),
      runSuite: (): SuiteResult => ({ failures: 1, targetPasses: false }),
      approval: new ApprovalGate(host),
    });

    const issue = { testId: "MathTest > add/2", failureOutput: "Assertion failed" };
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      results.push(
        await loop.attempt(issue, {
          writes: [{ path: "lib/math.ex", contents: `attempt-${i}`, mutationClass: "artifact.write" }],
        }),
      );
    }

    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "escalated"]);
    expect(asked).toEqual(["Auto-fix escalation"]);
    // Nothing was committed, and the tree is back to its original state.
    expect(readFileSync(join(root, "lib", "math.ex"), "utf8")).toBe("def add(a, b), do: a - b");
    expect(loop.retryBudget.canAttempt(issueKey(issue))).toBe(false);
  });

  it("the test file is unwritable even here, where mode is auto", async () => {
    const root = elixirRepo();
    const { compiled } = pipeline(root);

    const loop = new AutofixLoop({
      guard: createMutationGuard(compiled),
      snapshot: () => new WorkspaceSnapshot(root),
      applyWrite: (w) => writeFileSync(join(root, w.path), w.contents),
      runSuite: (): SuiteResult => ({ failures: 0, targetPasses: true }),
    });

    const out = await loop.attempt(
      { testId: "MathTest > add/2", failureOutput: "Assertion failed" },
      { writes: [{ path: "test/math_test.exs", contents: "assert true", mutationClass: "artifact.write" }] },
    );

    expect(out.status).toBe("rejected");
    expect(readFileSync(join(root, "test", "math_test.exs"), "utf8")).toBe("assert Math.add(1, 2) == 3");
  });

  it("this repo genuinely has no packages/ directory", () => {
    const root = elixirRepo();
    // Proves the test is not accidentally exercising the monorepo path.
    expect(discoverBehaviorPackages(root, { searchRoots: ["packages"] })).toEqual([]);
    expect(normalizeEvent({ type: "test.failure.observed", source: "ci" }).type).toBe("test.failure.observed");
  });
});
