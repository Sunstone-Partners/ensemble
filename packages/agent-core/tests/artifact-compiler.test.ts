import { compile } from "../src/behavior/compiler";
import { compileBehaviorToArtifacts } from "../src/behavior/artifact-compiler";
import { BehaviorManifest, BehaviorPackage } from "../src/behavior/schema";
import { echoTool } from "../src/domain-tools";

const manifest: BehaviorManifest = {
  api_version: "ensemble.sunstone.dev/v1",
  kind: "Behavior",
  metadata: { name: "investigate-test-failure", version: "1.0.0" },
  trigger: { event_type: "test.failed" },
  policy: { mode: "propose", timeout: "30m" },
  capabilities: { tools: ["echo", "bash.test"], mutation_classes: [] },
  execution: { graph: "investigate-test-failure" },
  outcomes: ["test.failure.investigated"],
};

describe("compileBehaviorToArtifacts (TRD-014)", () => {
  it("produces a prompt, a skill document, and only the tool names that have a real descriptor available", () => {
    const pkg: BehaviorPackage = { behaviors: [manifest] };
    const { compiled } = compile(pkg);

    const artifacts = compileBehaviorToArtifacts(compiled[0], [echoTool]);

    expect(artifacts.behaviorName).toBe("investigate-test-failure");
    expect(artifacts.commandName).toBe("investigate-test-failure");
    expect(artifacts.promptMarkdown).toContain("Trigger: `test.failed`");
    expect(artifacts.promptMarkdown).toContain("test.failure.investigated");
    expect(artifacts.skillMarkdown).toContain("name: investigate-test-failure");
    expect(artifacts.skillMarkdown).toContain("`echo`");
    expect(artifacts.skillMarkdown).toContain("`bash.test`");
    // "echo" has a real ToolDescriptor available; "bash.test" does not (no
    // descriptor was passed in) — only genuinely available tools surface.
    expect(artifacts.toolNames).toEqual(["echo"]);
  });
});
