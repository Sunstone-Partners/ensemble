import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverBehaviorPackages } from "../src/behavior/package-discovery";
import { checkFixtureConstructibility } from "../src/behavior/fixture-conformance";
import { compile, computeManifestDigest } from "../src/behavior/compiler";
import { match } from "../src/behavior/discovery";
import { translateEvent } from "../src/behavior/event-translator";
import { normalizeEvent } from "../src/normalize";
import { BehaviorPackage } from "../src/behavior/schema";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const BEHAVIOR_DIR = join(REPO_ROOT, "packages/agent-core/behaviors/investigate-test-failure");

function fixture(name: string) {
  const file = join(BEHAVIOR_DIR, "fixtures/events", `${name}.json`);
  return { file, raw: JSON.parse(readFileSync(file, "utf8")) };
}

const pkg = discoverBehaviorPackages(REPO_ROOT).find((p) => p.behaviorId === "investigate-test-failure")!;

describe("the shipped example behavior is actually triggerable (TRD-013 / REQ-010)", () => {
  it("exists and validates", () => {
    expect(pkg).toBeDefined();
    expect(pkg.validationErrors).toEqual([]);
    expect(compile({ behaviors: [pkg.manifest!] }).errors).toEqual([]);
  });

  it("no longer predicates on exit_code, a field Pi can never emit", () => {
    const yaml = readFileSync(join(BEHAVIOR_DIR, "behavior.yaml"), "utf8");
    expect(yaml).not.toContain("exit_code");
    expect(yaml).toContain("isError: { equals: true }");
  });

  it("AC-010-1: every event fixture is constructible from a real runtime event", () => {
    for (const name of ["pytest-nonzero-exit", "pytest-passed"]) {
      const { file, raw } = fixture(name);
      expect(checkFixtureConstructibility(file, raw)).toBeNull();
    }
  });

  it("the failing fixture matches and the passing one does not", () => {
    const asPkg = { behaviors: [pkg.manifest!] } as unknown as BehaviorPackage;
    expect(match(asPkg, normalizeEvent(fixture("pytest-nonzero-exit").raw)).map((b) => b.metadata.name))
      .toEqual(["investigate-test-failure"]);
    expect(match(asPkg, normalizeEvent(fixture("pytest-passed").raw))).toEqual([]);
  });

  it("end to end: a failing bash tool call reaches this behavior via the translator", () => {
    // The whole point of REQ-002 + REQ-010 together: a raw Pi event,
    // translated, must select the shipped behavior with no hand-built
    // semantic event anywhere in the path.
    const raw = normalizeEvent({
      type: "runtime.tool_call.completed",
      source: "pi",
      payload: { toolCallId: "t1", toolName: "bash", command: "pytest tests/", isError: true, output: "1 failed" },
    });

    const semantic = translateEvent(raw);
    expect(semantic).toBeDefined();

    const matched = match({ behaviors: [pkg.manifest!] } as unknown as BehaviorPackage, semantic!);
    expect(matched.map((b) => b.metadata.name)).toEqual(["investigate-test-failure"]);
  });

  it("the recorded digest is the real computed digest, not a stale hand-written value", () => {
    const manifest = JSON.parse(JSON.stringify(pkg.manifest)) as Record<string, any>;
    const recorded = manifest.metadata.digest;
    delete manifest.metadata.digest;
    expect(recorded).toBe(computeManifestDigest(manifest as never));
  });
});
