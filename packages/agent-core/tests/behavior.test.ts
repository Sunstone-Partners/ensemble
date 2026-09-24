import { normalizeEvent } from "../src/normalize";
import { compile, computeManifestDigest } from "../src/behavior/compiler";
import { match } from "../src/behavior/discovery";
import { simulate, conformance_run } from "../src/behavior/conformance";
import { BehaviorManifest, BehaviorPackage } from "../src/behavior/schema";

function fixtureManifest(overrides: Partial<BehaviorManifest> = {}): BehaviorManifest {
  return {
    api_version: "ensemble.sunstone.dev/v1",
    kind: "Behavior",
    metadata: { name: "investigate-test-failure", version: "1.0.0" },
    trigger: {
      event_type: "test.failure.observed",
      predicate: { exit_code: { not: 0 } },
    },
    policy: { mode: "propose", timeout: "30m" },
    capabilities: { tools: ["read", "grep", "bash.test"], mutation_classes: [] },
    execution: { graph: "investigate-test-failure" },
    outcomes: ["test.failure.investigated"],
    ...overrides,
  };
}

describe("behavior package schema/compiler (TRD-011)", () => {
  it("compiles a well-formed manifest with no errors and computes its digest", () => {
    const pkg: BehaviorPackage = { behaviors: [fixtureManifest()] };
    const result = compile(pkg);
    expect(result.ok).toBe(true);
    expect(result.compiled).toHaveLength(1);
    expect(result.compiled[0].digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("AC-011-1: a tool grant (bash.test) never implies mutation authority (artifact.write) it wasn't given", () => {
    const manifest = fixtureManifest({
      capabilities: { tools: ["bash.test"], mutation_classes: [] },
    });
    const pkg: BehaviorPackage = { behaviors: [manifest] };
    const { compiled } = compile(pkg);

    expect(compiled[0].hasTool("bash.test")).toBe(true);
    expect(compiled[0].hasMutationAuthority("artifact.write")).toBe(false);
  });

  it("AC-011-1: mutation authority is granted only when explicitly declared", () => {
    const manifest = fixtureManifest({
      capabilities: { tools: ["bash.test"], mutation_classes: ["artifact.write"] },
    });
    const { compiled } = compile({ behaviors: [manifest] });
    expect(compiled[0].hasMutationAuthority("artifact.write")).toBe(true);
  });

  it("AC-011-2: two manifests with identical metadata.version but different content fail validation on digest mismatch", () => {
    const original = fixtureManifest();
    const digest = computeManifestDigest(original);
    const stamped = { ...original, metadata: { ...original.metadata, digest } };

    // Same version, but content tampered with after the digest was stamped.
    const tampered: BehaviorManifest = {
      ...stamped,
      capabilities: { ...stamped.capabilities, mutation_classes: ["artifact.write"] },
    };

    const result = compile({ behaviors: [tampered] });
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/digest mismatch/);
  });

  it("a manifest with a correctly stamped digest passes validation", () => {
    const original = fixtureManifest();
    const digest = computeManifestDigest(original);
    const stamped: BehaviorManifest = { ...original, metadata: { ...original.metadata, digest } };

    const result = compile({ behaviors: [stamped] });
    expect(result.ok).toBe(true);
  });

  it("AC-012-2: rejects a manifest missing a required field with a specific field-level error", () => {
    const invalid = fixtureManifest({ trigger: { event_type: "" } });
    const result = compile({ behaviors: [invalid] });
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toBe("field 'trigger.event_type' is required");
  });

  it("matches an event against a compiled behavior's trigger and predicate", () => {
    const pkg: BehaviorPackage = { behaviors: [fixtureManifest()] };
    const matchingEvent = normalizeEvent({
      type: "test.failure.observed",
      source: "ci",
      payload: { exit_code: 1 },
    });
    const nonMatchingEvent = normalizeEvent({
      type: "test.failure.observed",
      source: "ci",
      payload: { exit_code: 0 },
    });

    expect(match(pkg, matchingEvent).map((b) => b.metadata.name)).toEqual([
      "investigate-test-failure",
    ]);
    expect(match(pkg, nonMatchingEvent)).toEqual([]);
  });

  it("simulates and reports missing tool grants without any live adapter", () => {
    const pkg: BehaviorPackage = { behaviors: [fixtureManifest()] };
    const event = normalizeEvent({ type: "test.failure.observed", source: "ci", payload: { exit_code: 1 } });
    const result = simulate(pkg, event, ["read"]);
    expect(result.matchedBehaviors.map((b) => b.metadata.name)).toEqual([
      "investigate-test-failure",
    ]);
    expect(result.missingToolGrants.sort()).toEqual(["bash.test", "grep"]);
  });

  it("runs conformance fixtures and reports pass/fail per behavior", () => {
    const pkg: BehaviorPackage = { behaviors: [fixtureManifest()] };
    const event = normalizeEvent({ type: "test.failure.observed", source: "ci", payload: { exit_code: 1 } });
    const reports = conformance_run(pkg, [
      { event, expectedBehaviorNames: ["investigate-test-failure"] },
    ]);
    expect(reports).toEqual([
      {
        behaviorName: "investigate-test-failure",
        passed: true,
        details: "all 1 fixture(s) matched",
      },
    ]);
  });
});
