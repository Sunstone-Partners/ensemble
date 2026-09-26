import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixtureConformance, checkFixtureConstructibility } from "../src/behavior/fixture-conformance";
import { BehaviorManifest, BehaviorPackage } from "../src/behavior/schema";

const manifest: BehaviorManifest = {
  api_version: "ensemble.sunstone.dev/v1",
  kind: "Behavior",
  metadata: { name: "investigate-test-failure", version: "1.0.0" },
  trigger: { event_type: "test.failure.observed", predicate: { exit_code: { not: 0 } } },
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
        type: "test.failure.observed",
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
      JSON.stringify({ type: "test.failure.observed", source: "ci", payload: { exit_code: 0 } }),
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
      JSON.stringify({ type: "test.failure.observed", source: "ci", payload: { exit_code: 1 } }),
    );
    writeFileSync(
      join(behaviorDir, "fixtures", "expected-matches", "wrong-expectation.json"),
      JSON.stringify(["a-behavior-that-does-not-exist"]),
    );

    const [result] = runFixtureConformance(behaviorDir, pkg);
    expect(result.matchesEqual).toBe(false);
  });
});

describe("fixture constructibility rule (TRD-007 / REQ-010)", () => {
  it("AC-010-3: fails against the pre-existing exit_code-shaped fixture", () => {
    // This is the negative proof the rule exists for. Before TRD-007,
    // `investigate-test-failure`'s fixtures asserted on `exit_code` --
    // a field no translator can ever emit, because Pi exposes only a
    // boolean `isError`. The fixtures passed anyway, so the suite was
    // validating the system against events it cannot produce.
    const issue = checkFixtureConstructibility("test-failed.json", {
      type: "test.failure.observed",
      source: "ci",
      payload: { exit_code: 1 },
    });

    expect(issue).not.toBeNull();
    expect(issue!.unconstructibleFields).toEqual(["exit_code"]);
    expect(issue!.reason).toContain("no translator can emit");
  });

  it("AC-010-2: passes for a fixture built only from emittable fields", () => {
    expect(
      checkFixtureConstructibility("ok.json", {
        type: "test.failure.observed",
        source: "pi",
        payload: { command: "npm test", isError: true },
      }),
    ).toBeNull();
  });

  it("AC-010-2: rejects an event type no translator declares at all", () => {
    const issue = checkFixtureConstructibility("weird.json", {
      type: "prd.approved",
      source: "fixture",
      payload: {},
    });
    expect(issue).not.toBeNull();
    expect(issue!.reason).toContain("no translator declares emittable payload fields");
  });

  it("names every offending field, not just the first", () => {
    const issue = checkFixtureConstructibility("multi.json", {
      type: "test.failure.observed",
      source: "ci",
      payload: { exit_code: 1, stack_trace: "x", command: "npm test" },
    });
    expect(issue!.unconstructibleFields.sort()).toEqual(["exit_code", "stack_trace"]);
  });
});

describe("uncatalogued fixture does not crash the run (TRD-001 + TRD-007)", () => {
  it("reports a stale-typed fixture as one failed fixture instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "stale-fixture-"));
    const behaviorDir = join(dir, "investigate-test-failure");
    for (const sub of ["events", "expected-matches", "expected-outcomes"]) {
      mkdirSync(join(behaviorDir, "fixtures", sub), { recursive: true });
    }
    writeFileSync(
      join(behaviorDir, "fixtures", "events", "stale.json"),
      JSON.stringify({ type: "runtime.tool.failed", source: "ci", payload: {} }),
    );
    writeFileSync(join(behaviorDir, "fixtures", "expected-matches", "stale.json"), "[]");
    writeFileSync(join(behaviorDir, "fixtures", "expected-outcomes", "stale.json"), "[]");

    const pkg: BehaviorPackage = { behaviors: [manifest] };
    let results;
    expect(() => {
      results = runFixtureConformance(behaviorDir, pkg);
    }).not.toThrow();

    expect(results).toHaveLength(1);
    expect(results![0].matchesEqual).toBe(false);
    expect(results![0].constructibility!.reason).toMatch(/closed event catalog|no translator/);
    rmSync(dir, { recursive: true, force: true });
  });
});
