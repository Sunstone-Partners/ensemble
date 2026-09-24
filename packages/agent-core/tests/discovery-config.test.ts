import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverBehaviorPackages, DEFAULT_SEARCH_ROOTS } from "../src/behavior/package-discovery";
import { compile } from "../src/behavior/compiler";
import { compileBehaviorToArtifacts } from "../src/behavior/artifact-compiler";
import { BehaviorManifest } from "../src/behavior/schema";

function yamlFor(name: string, extra = ""): string {
  return `api_version: ensemble.sunstone.dev/v1
kind: Behavior
metadata:
  name: ${name}
  version: 1.0.0
trigger:
  event_type: test.failure.observed
policy:
  mode: propose
  timeout: 30m
capabilities:
  tools:
    - read
  mutation_classes: []
execution:
  graph: ${name}
${extra}outcomes:
  - test.failure.investigated
`;
}

function makeRepo(relDir: string, name: string, extra = ""): string {
  const root = mkdtempSync(join(tmpdir(), "disc-"));
  const dir = join(root, relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "behavior.yaml"), yamlFor(name, extra));
  return root;
}

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("configurable discovery roots (TRD-008 / REQ-013)", () => {
  it("AC-013-1: default configuration still finds monorepo-layout packages (no regression)", () => {
    const root = makeRepo(join("packages", "agent-core", "behaviors", "b1"), "b1");
    dirs.push(root);

    const found = discoverBehaviorPackages(root);
    expect(found.map((f) => f.behaviorId)).toEqual(["b1"]);
    expect(DEFAULT_SEARCH_ROOTS).toContain("packages");
  });

  it("AC-013-2: finds behaviors in a repo with no packages/ directory at all", () => {
    // The shape a non-monorepo consumer (e.g. an Elixir service) wants.
    const root = makeRepo(join(".ensemble", "behaviors", "b2"), "b2");
    dirs.push(root);

    // Proves the old hardcoded join(rootDir, "packages") could not have worked.
    expect(discoverBehaviorPackages(root, { searchRoots: ["packages"] })).toEqual([]);

    // ...and that the shipped default now covers this layout.
    const found = discoverBehaviorPackages(root);
    expect(found.map((f) => f.behaviorId)).toEqual(["b2"]);
    expect(found[0].manifest?.metadata.name).toBe("b2");
  });

  it("does not yield the same package twice when search roots overlap", () => {
    const root = makeRepo(join("packages", "agent-core", "behaviors", "b3"), "b3");
    dirs.push(root);

    const found = discoverBehaviorPackages(root, { searchRoots: ["packages", "packages", "."] });
    expect(found.filter((f) => f.behaviorId === "b3")).toHaveLength(1);
  });
});

describe("behavior-declared test command (TRD-009/TRD-010 / REQ-012)", () => {
  const base: BehaviorManifest = {
    api_version: "ensemble.sunstone.dev/v1",
    kind: "Behavior",
    metadata: { name: "b", version: "1.0.0" },
    trigger: { event_type: "test.failure.observed" },
    policy: { mode: "propose", timeout: "30m" },
    capabilities: { tools: ["read"], mutation_classes: [] },
    execution: { graph: "b" },
    outcomes: ["test.failure.investigated"],
  };

  it("AC-012-1: a declared non-npm command reaches the compiled artifact unaltered", () => {
    const manifest: BehaviorManifest = {
      ...base,
      execution: { graph: "b", test_command: "mix test" },
    };
    const { compiled, errors } = compile({ behaviors: [manifest] });
    expect(errors).toEqual([]);

    const artifacts = compileBehaviorToArtifacts(compiled[0], []);
    expect(artifacts.testCommand).toBe("mix test");
  });

  it("AC-012-2: mode:auto without a test command fails validation rather than guessing", () => {
    const manifest: BehaviorManifest = {
      ...base,
      policy: { mode: "auto", timeout: "30m" },
      execution: { graph: "b" },
    };
    const { errors } = compile({ behaviors: [manifest] });
    expect(errors.map((e) => e.message).join("\n")).toMatch(/execution\.test_command.*required.*auto/);
  });

  it("AC-012-2: the rule is scoped to auto — propose without a test command still validates", () => {
    const { errors } = compile({ behaviors: [base] });
    expect(errors).toEqual([]);
  });

  it("mode:auto with a test command validates", () => {
    const manifest: BehaviorManifest = {
      ...base,
      policy: { mode: "auto", timeout: "30m" },
      execution: { graph: "b", test_command: "npm test" },
    };
    expect(compile({ behaviors: [manifest] }).errors).toEqual([]);
  });

  it("discovery surfaces a declared test command through the manifest", () => {
    const root = makeRepo(
      join("packages", "x", "behaviors", "b4"),
      "b4",
      "  test_command: pytest -q\n",
    );
    dirs.push(root);

    const found = discoverBehaviorPackages(root);
    expect(found[0].manifest?.execution.test_command).toBe("pytest -q");
  });
});

describe("discovery excludes dependency and tooling directories (supply-chain guard)", () => {
  it("never loads a behavior shipped inside node_modules", () => {
    const root = makeRepo(join("node_modules", "behaviors", "evil"), "evil");
    dirs.push(root);
    expect(discoverBehaviorPackages(root, { searchRoots: ["."] })).toEqual([]);
  });

  it("never treats a dot-directory as a behavior domain", () => {
    const root = makeRepo(join(".git", "behaviors", "sneaky"), "sneaky");
    dirs.push(root);
    expect(discoverBehaviorPackages(root, { searchRoots: ["."] })).toEqual([]);
  });

  it("still finds a legitimate non-monorepo behavior alongside those exclusions", () => {
    const root = makeRepo(join("svc", "behaviors", "ok"), "ok");
    dirs.push(root);
    mkdirSync(join(root, "node_modules", "behaviors", "evil"), { recursive: true });
    writeFileSync(join(root, "node_modules", "behaviors", "evil", "behavior.yaml"), yamlFor("evil"));

    const found = discoverBehaviorPackages(root, { searchRoots: ["."] });
    expect(found.map((f) => f.behaviorId)).toEqual(["ok"]);
  });
});

describe("exclusions are an explicit list, not a dot-prefix rule", () => {
  it(".ensemble/behaviors remains a valid non-monorepo layout", () => {
    const root = makeRepo(join(".ensemble", "behaviors", "keep"), "keep");
    dirs.push(root);
    expect(discoverBehaviorPackages(root, { searchRoots: ["."] }).map((f) => f.behaviorId)).toEqual(["keep"]);
  });
});
