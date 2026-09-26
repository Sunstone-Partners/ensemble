import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { discoverBehaviorPackages } from "../src/behavior/package-discovery";
import { BehaviorManifest } from "../src/behavior/schema";

function validManifest(name: string): BehaviorManifest {
  return {
    api_version: "ensemble.sunstone.dev/v1",
    kind: "Behavior",
    metadata: { name, version: "1.0.0" },
    trigger: { event_type: "test.failure.observed" },
    policy: { mode: "propose", timeout: "30m" },
    capabilities: { tools: ["read"], mutation_classes: [] },
    execution: { graph: name },
    outcomes: [`${name}.done`],
  };
}

function makeBehaviorPackage(
  root: string,
  domain: string,
  behaviorId: string,
  content: string | BehaviorManifest,
  withFixtures = true,
): void {
  const dir = join(root, "packages", domain, "behaviors", behaviorId);
  mkdirSync(dir, { recursive: true });
  const yamlText = typeof content === "string" ? content : yaml.dump(content);
  writeFileSync(join(dir, "behavior.yaml"), yamlText);
  if (withFixtures) {
    mkdirSync(join(dir, "fixtures", "events"), { recursive: true });
    mkdirSync(join(dir, "fixtures", "expected-matches"), { recursive: true });
    mkdirSync(join(dir, "fixtures", "expected-outcomes"), { recursive: true });
  }
}

describe("discoverBehaviorPackages (TRD-012)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ensemble-behavior-discovery-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("AC-012-1: discovery runs twice with no changes and produces an identical, deterministically ordered set", () => {
    // Intentionally created out of alphabetical order to prove sorting,
    // not just directory-read order.
    makeBehaviorPackage(root, "zeta", "z-behavior", validManifest("z-behavior"));
    makeBehaviorPackage(root, "alpha", "a-behavior", validManifest("a-behavior"));
    makeBehaviorPackage(root, "alpha", "m-behavior", validManifest("m-behavior"));

    const run1 = discoverBehaviorPackages(root);
    const run2 = discoverBehaviorPackages(root);

    expect(run1.map((d) => `${d.domain}/${d.behaviorId}`)).toEqual([
      "alpha/a-behavior",
      "alpha/m-behavior",
      "zeta/z-behavior",
    ]);
    expect(run1).toEqual(run2);
  });

  it("detects present fixture directories", () => {
    makeBehaviorPackage(root, "alpha", "a-behavior", validManifest("a-behavior"));
    const [discovered] = discoverBehaviorPackages(root);
    expect(discovered.fixtures).toEqual({
      events: true,
      expectedMatches: true,
      expectedOutcomes: true,
    });
  });

  it("reports missing fixture directories without failing discovery", () => {
    makeBehaviorPackage(root, "alpha", "a-behavior", validManifest("a-behavior"), false);
    const [discovered] = discoverBehaviorPackages(root);
    expect(discovered.fixtures).toEqual({
      events: false,
      expectedMatches: false,
      expectedOutcomes: false,
    });
  });

  it("AC-012-2: a behavior.yaml missing a required field fails with a specific field-level error, not a generic parse failure", () => {
    const manifestMissingTrigger: BehaviorManifest = {
      ...validManifest("bad-behavior"),
      trigger: { event_type: "" },
    };
    makeBehaviorPackage(root, "alpha", "bad-behavior", manifestMissingTrigger);

    const [discovered] = discoverBehaviorPackages(root);
    expect(discovered.parseError).toBeUndefined();
    expect(discovered.validationErrors).toEqual(["field 'trigger.event_type' is required"]);
  });

  it("a genuine YAML syntax error is reported distinctly from a field-level validation error", () => {
    makeBehaviorPackage(root, "alpha", "broken-yaml", "kind: [Behavior\n  unterminated");

    const [discovered] = discoverBehaviorPackages(root);
    expect(discovered.validationErrors).toBeUndefined();
    expect(discovered.parseError).toMatch(/YAML syntax error/);
  });
});
