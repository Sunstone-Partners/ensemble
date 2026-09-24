import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixtureConformance } from "../src/behavior/fixture-conformance";
import { BehaviorManifest, BehaviorPackage } from "../src/behavior/schema";

const manifest: BehaviorManifest = {
  api_version: "ensemble.sunstone.dev/v1",
  kind: "Behavior",
  metadata: { name: "investigate-test-failure", version: "1.0.0" },
  trigger: { event_type: "test.failed", predicate: { exit_code: { not: 0 } } },
  policy: { mode: "propose", timeout: "30m" },
  capabilities: { tools: ["read", "bash.test"], mutation_classes: [] },
  execution: { graph: "investigate-test-failure" },
  outcomes: ["test.failure.investigated"],
};

const pkg: BehaviorPackage = { behaviors: [manifest] };

describe("runFixtureConformance (TRD-013)", () => {
  let behaviorDir: string;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-fixture-conformance-"));
    behaviorDir = join(root, "investigate-test-failure");
    mkdirSync(join(behaviorDir, "fixtures", "events"), { recursive: true });
    mkdirSync(join(behaviorDir, "fixtures", "expected-matches"), { recursive: true });
    mkdirSync(join(behaviorDir, "fixtures", "expected-outcomes"), { recursive: true });
  });

  afterEach(() => {
    rmSync(behaviorDir, { recursive: true, force: true });
  });

  it("AC-013-1: produced matches/outcomes equal the expected fixtures structurally for a matching event", () => {
    writeFileSync(
      join(behaviorDir, "fixtures", "events", "test-failed-nonzero.json"),
      JSON.stringify({
        type: "test.failed",
        source: "ci",
        payload: { exit_code: 1 },
      }),
    );
    writeFileSync(
      join(behaviorDir, "fixtures", "expected-matches", "test-failed-nonzero.json"),
      JSON.stringify(["investigate-test-failure"]),
    );
    writeFileSync(
      join(behaviorDir, "fixtures", "expected-outcomes", "test-failed-nonzero.json"),
      JSON.stringify(["test.failure.investigated"]),
    );

    const [result] = runFixtureConformance(behaviorDir, pkg);

    expect(result.matchesEqual).toBe(true);
    expect(result.outcomesEqual).toBe(true);
    expect(result.actualMatches).toEqual(["investigate-test-failure"]);
    expect(result.actualOutcomes).toEqual(["test.failure.investigated"]);
  });

  it("AC-013-1: a non-matching event (exit_code 0) produces no matches/outcomes, equal to empty expected fixtures", () => {
    writeFileSync(
      join(behaviorDir, "fixtures", "events", "test-failed-zero.json"),
      JSON.stringify({ type: "test.failed", source: "ci", payload: { exit_code: 0 } }),
    );
    writeFileSync(join(behaviorDir, "fixtures", "expected-matches", "test-failed-zero.json"), "[]");
    writeFileSync(join(behaviorDir, "fixtures", "expected-outcomes", "test-failed-zero.json"), "[]");

    const [result] = runFixtureConformance(behaviorDir, pkg);

    expect(result.matchesEqual).toBe(true);
    expect(result.outcomesEqual).toBe(true);
    expect(result.actualMatches).toEqual([]);
  });

  it("detects a real conformance failure when the fixture expects something the package does not produce", () => {
    writeFileSync(
      join(behaviorDir, "fixtures", "events", "wrong-expectation.json"),
      JSON.stringify({ type: "test.failed", source: "ci", payload: { exit_code: 1 } }),
    );
    writeFileSync(
      join(behaviorDir, "fixtures", "expected-matches", "wrong-expectation.json"),
      JSON.stringify(["a-behavior-that-does-not-exist"]),
    );

    const [result] = runFixtureConformance(behaviorDir, pkg);
    expect(result.matchesEqual).toBe(false);
  });
});
