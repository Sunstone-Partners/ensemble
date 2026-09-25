import { compile, createMutationGuard, BehaviorManifest } from "../src";

function manifestWith(tools: string[], mutationClasses: string[], mode: "auto" | "propose" | "shadow" = "propose"): BehaviorManifest {
  return {
    api_version: "ensemble.sunstone.dev/v1",
    kind: "Behavior",
    metadata: { name: "investigate-test-failure", version: "1.0.0" },
    trigger: { event_type: "test.failure.observed" },
    policy: { mode, timeout: "30m" },
    capabilities: { tools, mutation_classes: mutationClasses },
    execution: { graph: "investigate-test-failure" },
    outcomes: ["test.failure.investigated"],
  };
}

function guardFor(tools: string[], mutationClasses: string[], mode: "auto" | "propose" | "shadow" = "propose") {
  const m = manifestWith(tools, mutationClasses, mode);
  if (mode === "auto") m.execution.test_command = "npm test";
  const { compiled, errors } = compile({ behaviors: [m] });
  expect(errors).toEqual([]);
  return createMutationGuard(compiled[0]);
}

describe("MutationGuard (TRD-002 / REQ-011)", () => {
  it("AC-011-1: denies a mutation class the manifest does not declare, naming the missing class", () => {
    const guard = guardFor(["read"], []);
    const decision = guard.authorize({ mutationClass: "artifact.write", kind: "write" });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.reason).toContain("artifact.write");
    expect(decision.reason).toContain("investigate-test-failure");
  });

  it("AC-011-1: permits a mutation class the manifest does declare", () => {
    // Asserted under mode:auto. Since TRD-017 a `propose` behavior is
    // denied direct writes regardless of declared classes, so the
    // class-grant question is only observable in auto.
    const guard = guardFor(["read"], ["artifact.write"], "auto");
    expect(guard.authorize({ mutationClass: "artifact.write", kind: "write" }).allowed).toBe(true);
  });

  it("AC-011-3: a bash grant is never mistakable for artifact-write authority", () => {
    // The behavior holds `bash` — with which it could physically write a
    // file — but declares no mutation classes. Tool access must not
    // confer mutation authority, or the two lists are decorative.
    const guard = guardFor(["bash"], []);
    const decision = guard.authorize({
      mutationClass: "artifact.write",
      path: "src/thing.ts",
      kind: "write",
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.escalate).toBe(true);
  });

  it("AC-011-3: holding every tool still grants no mutation authority", () => {
    const guard = guardFor(["bash", "read", "write", "edit"], []);
    for (const mutationClass of ["artifact.write", "artifact.delete", "repo.commit"]) {
      expect(guard.authorize({ mutationClass, kind: "write" }).allowed).toBe(false);
    }
  });

  it("denies a request that declares no mutation class at all (fail closed)", () => {
    const guard = guardFor(["bash"], ["artifact.write"]);
    expect(guard.authorize({ mutationClass: "", kind: "write" }).allowed).toBe(false);
  });

  it("reports enforcementActive so the loader can fail closed on mode:auto (AC-011-2 precondition)", () => {
    expect(guardFor(["read"], []).enforcementActive).toBe(true);
  });
});
