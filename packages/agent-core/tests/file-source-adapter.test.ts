import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/behavior/compiler";
import { match } from "../src/behavior/discovery";
import {
  ARTIFACT_CHANGED_EVENT_TYPE,
  FileSourceAdapter,
  artifactWatchSet,
} from "../src/behavior/file-source-adapter";
import { BehaviorManifest } from "../src/behavior/schema";

/**
 * TRD-001 / REQ-001: a behavior can trigger on a file changing, not only on a
 * tool result. Every case runs against a real directory and the real
 * `compile` and matcher.
 */

function manifest(name: string, predicate?: Record<string, unknown>, eventType = ARTIFACT_CHANGED_EVENT_TYPE): BehaviorManifest {
  return {
    api_version: "ensemble.sunstone.dev/v1",
    kind: "Behavior",
    metadata: { name, version: "1.0.0" },
    trigger: { event_type: eventType, predicate: predicate as never },
    policy: { mode: "propose", timeout: "30m" },
    capabilities: { tools: ["read"], mutation_classes: [] },
    execution: { graph: name },
    outcomes: ["behavior.completed"],
  };
}

let repo: string;
let outside: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "file-source-repo-"));
  outside = mkdtempSync(join(tmpdir(), "file-source-outside-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function write(relative: string, content: string): void {
  mkdirSync(join(repo, relative, ".."), { recursive: true });
  writeFileSync(join(repo, relative), content);
}

describe("artifact.changed triggers: what gets watched (TRD-001)", () => {
  it("derives the watch set from compiled triggers: exactly the named file and glob", () => {
    const { compiled, errors } = compile({
      behaviors: [
        manifest("coverage", { path: { equals: "coverage/coverage-summary.json" } }),
        manifest("reports", { path: { glob: "reports/**/*.json" } }),
        // Same file named twice is one watch, not two hashes per check.
        manifest("coverage-again", { path: { equals: "./coverage/coverage-summary.json" } }),
        manifest("unrelated", undefined, "test.failure.observed"),
      ],
    });

    expect(errors).toEqual([]);
    expect(artifactWatchSet(compiled)).toEqual([
      { kind: "file", pattern: "coverage/coverage-summary.json" },
      { kind: "glob", pattern: "reports/**/*.json" },
    ]);
  });

  it("fails closed on a trigger without a concrete path, and registers no watch for it", () => {
    const { compiled, errors } = compile({ behaviors: [manifest("no-path")] });

    expect(errors).toHaveLength(1);
    expect(errors[0].behaviorName).toBe("no-path");
    expect(errors[0].message).toContain("trigger.predicate.path");
    expect(artifactWatchSet(compiled)).toEqual([]);
  });

  it("refuses a regex or negated path: neither names a file that could be hashed", () => {
    for (const condition of [{ matches: "coverage/.*" }, { not: "secret.json" }]) {
      const { errors } = compile({ behaviors: [manifest("vague", { path: condition })] });
      expect(errors.map((e) => e.message)).toEqual([expect.stringContaining("trigger.predicate.path")]);
    }
  });

  it("refuses a path that resolves outside the repository instead of watching it", () => {
    for (const path of ["../outside.json", "coverage/../../outside.json", "/etc/passwd", "C:\\Users\\x\\a.json"]) {
      const { compiled, errors } = compile({ behaviors: [manifest("escape", { path: { equals: path } })] });

      expect(errors.map((e) => e.message)).toEqual([
        expect.stringMatching(/trigger\.predicate\.path.*outside the repository/),
      ]);
      expect(artifactWatchSet(compiled)).toEqual([]);
    }
    // The same rule for a glob, whose `**` must not climb out either.
    const { errors } = compile({ behaviors: [manifest("glob-escape", { path: { glob: "**/../../x.json" } })] });
    expect(errors.map((e) => e.message)).toEqual([expect.stringContaining("outside the repository")]);
  });

  it("matches a glob predicate against the event's path, and fails closed on a non-string", () => {
    const pkg = { behaviors: [manifest("reports", { path: { glob: "reports/*.json" } })] };
    const event = (path: unknown) =>
      ({ id: "e", type: ARTIFACT_CHANGED_EVENT_TYPE, source: "pi", occurredAt: "t", payload: { path } });

    expect(match(pkg, event("reports/a.json")).map((b) => b.metadata.name)).toEqual(["reports"]);
    // `*` stays inside one segment.
    expect(match(pkg, event("reports/nested/a.json"))).toEqual([]);
    expect(match(pkg, event("reports/a.txt"))).toEqual([]);
    expect(match(pkg, event(42))).toEqual([]);

    const deep = { behaviors: [manifest("deep", { path: { glob: "reports/**/*.json" } })] };
    expect(match(deep, event("reports/a.json"))).toHaveLength(1);
    expect(match(deep, event("reports/x/y/a.json"))).toHaveLength(1);
  });
});

describe("FileSourceAdapter: when nothing changed (TRD-001)", () => {
  it("emits nothing for a byte-identical rewrite", () => {
    write("coverage/coverage-summary.json", '{"total":1}');
    const adapter = new FileSourceAdapter({
      repoRoot: repo,
      watches: [{ kind: "file", pattern: "coverage/coverage-summary.json" }],
      source: "pi",
    });
    adapter.prime();

    write("coverage/coverage-summary.json", '{"total":1}');

    expect(adapter.check("tool_result")).toEqual([]);
  });

  it("never reads through a symlink that leaves the repository", () => {
    writeFileSync(join(outside, "secret.json"), "v1");
    mkdirSync(join(repo, "coverage"));
    symlinkSync(join(outside, "secret.json"), join(repo, "coverage", "coverage-summary.json"));
    const adapter = new FileSourceAdapter({
      repoRoot: repo,
      watches: [{ kind: "file", pattern: "coverage/coverage-summary.json" }],
      source: "pi",
    });
    adapter.prime();

    writeFileSync(join(outside, "secret.json"), "v2");

    expect(adapter.check("tool_result")).toEqual([]);
  });
});
