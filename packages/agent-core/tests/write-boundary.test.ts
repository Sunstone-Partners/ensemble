import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPath, isProtectedPath } from "../src/behavior/protected-paths";
import { WorkspaceSnapshot } from "../src/behavior/workspace-snapshot";
import { ApprovalGate, ApprovalHost } from "../src/behavior/approval-gate";
import { createMutationGuard } from "../src/behavior/mutation-guard";
import { compile } from "../src/behavior/compiler";
import { BehaviorManifest } from "../src/behavior/schema";

function guard(mode: "auto" | "propose" | "shadow", classes: string[] = ["artifact.write"]) {
  const manifest: BehaviorManifest = {
    api_version: "ensemble.sunstone.dev/v1",
    kind: "Behavior",
    metadata: { name: "fixer", version: "1.0.0" },
    trigger: { event_type: "test.failure.observed" },
    policy: { mode, timeout: "30m" },
    capabilities: { tools: ["read", "write"], mutation_classes: classes },
    execution: mode === "auto" ? { graph: "fixer", test_command: "npm test" } : { graph: "fixer" },
    outcomes: ["test.failure.investigated"],
  };
  const { compiled, errors } = compile({ behaviors: [manifest] });
  expect(errors).toEqual([]);
  return createMutationGuard(compiled[0]);
}

describe("ProtectedPathPolicy (TRD-019 / REQ-015)", () => {
  it("AC-015-1: classifies test files across languages", () => {
    for (const p of [
      "packages/agent-core/tests/foo.test.ts",
      "src/__tests__/thing.tsx",
      "spec/models/user.rb",
      "app/user_test.go",
      "lib/thing_test.exs",
      "tests/test_api.py",
    ]) {
      expect(classifyPath(p)).toMatchObject({ protected: true, reason: "test-file" });
    }
  });

  it("classifies guardrail sources, fixtures and the constitution", () => {
    expect(classifyPath("packages/agent-core/src/behavior/mutation-guard.ts").reason).toBe("guardrail-source");
    expect(classifyPath("packages/agent-core/behaviors/x/fixtures/events/a.json").reason).toBe("conformance-fixture");
    expect(classifyPath("docs/standards/constitution.md").reason).toBe("constitution");
  });

  it("the write boundary protects ITSELF", () => {
    // Every other guardrail file was listed, but the module that performs
    // the reverting was not -- so an agent could rewrite the enforcer and
    // thereby disable protection for all seven of the others at once,
    // with no revert and no violation recorded.
    expect(classifyPath("packages/agent-core/src/behavior/write-boundary-monitor.ts").reason).toBe(
      "guardrail-source",
    );
  });

  it("near-miss ordinary paths are NOT protected", () => {
    // If these were protected the policy would block ordinary fixes and
    // be switched off, which is the real-world failure mode.
    for (const p of [
      "src/latest.ts",
      "src/contest-winner.ts",
      "src/protest.ts",
      "docs/standards/style.md",
      "src/testing-utils.ts",
      "src/attestation.ts",
    ]) {
      expect(isProtectedPath(p)).toBe(false);
    }
  });

  it("normalizes windows separators and leading ./", () => {
    expect(isProtectedPath("./packages\\agent-core\\tests\\a.test.ts")).toBe(true);
  });
});

describe("MutationGuard mode branching (TRD-017 / REQ-004)", () => {
  it("AC-004-1: auto permits a granted class on an ordinary path", () => {
    expect(guard("auto").authorize({ mutationClass: "artifact.write", path: "src/a.ts", kind: "write" }).allowed).toBe(true);
  });

  it("AC-004-2: propose denies a direct write and says to propose instead", () => {
    const d = guard("propose").authorize({ mutationClass: "artifact.write", path: "src/a.ts", kind: "write" });
    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error("unreachable");
    expect(d.reason).toMatch(/propose/);
  });

  it("AC-004-3: shadow denies everything", () => {
    for (const kind of ["write", "delete", "commit"] as const) {
      expect(guard("shadow").authorize({ mutationClass: "artifact.write", path: "src/a.ts", kind }).allowed).toBe(false);
    }
  });
});

describe("protected-path refusal inside the guard (TRD-020 / AC-015-2)", () => {
  it("refuses a test-file write in mode:auto with the class granted", () => {
    // The adversarial case: maximum authority, no model involved, path
    // passed directly to authorize(). Editing the failing test is the
    // cheapest way to go green and must be mechanically impossible.
    const d = guard("auto").authorize({
      mutationClass: "artifact.write",
      path: "packages/agent-core/tests/behavior.test.ts",
      kind: "write",
    });

    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error("unreachable");
    expect(d.reason).toMatch(/protected path/);
    expect(d.reason).toMatch(/test-file/);
  });

  it("refuses deleting a test file and rewriting the guard itself", () => {
    const g = guard("auto");
    expect(g.authorize({ mutationClass: "artifact.write", path: "tests/a.test.ts", kind: "delete" }).allowed).toBe(false);
    expect(g.authorize({ mutationClass: "artifact.write", path: "src/behavior/mutation-guard.ts", kind: "write" }).allowed).toBe(false);
    expect(g.authorize({ mutationClass: "artifact.write", path: "docs/standards/constitution.md", kind: "write" }).allowed).toBe(false);
  });

  it("the boundary outranks mode: protected paths are refused before mode is consulted", () => {
    const d = guard("auto").authorize({ mutationClass: "artifact.write", path: "tests/a.test.ts", kind: "write" });
    if (d.allowed) throw new Error("unreachable");
    expect(d.reason).not.toMatch(/mode: /);
  });
});

describe("WorkspaceSnapshot (TRD-021 / REQ-015)", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  function repo(): string {
    const d = mkdtempSync(join(tmpdir(), "snap-"));
    dirs.push(d);
    mkdirSync(join(d, "src"), { recursive: true });
    writeFileSync(join(d, "src", "a.ts"), "original");
    return d;
  }

  it("restores modified content exactly", () => {
    const root = repo();
    const snap = new WorkspaceSnapshot(root);
    snap.capture("src/a.ts");

    writeFileSync(join(root, "src", "a.ts"), "clobbered");
    const report = snap.restore();

    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("original");
    expect(report.restored).toEqual(["src/a.ts"]);
    expect(report.failed).toEqual([]);
  });

  it("deletes files that did not exist at capture time", () => {
    // Otherwise a rejected attempt leaves new files behind, which is
    // not a restore.
    const root = repo();
    const snap = new WorkspaceSnapshot(root);
    snap.capture("src/new.ts");

    writeFileSync(join(root, "src", "new.ts"), "created by attempt");
    const report = snap.restore();

    expect(existsSync(join(root, "src", "new.ts"))).toBe(false);
    expect(report.deleted).toEqual(["src/new.ts"]);
  });

  it("scope is limited to captured paths, so concurrent edits survive", () => {
    const root = repo();
    writeFileSync(join(root, "src", "human.ts"), "human work");
    const snap = new WorkspaceSnapshot(root);
    snap.capture("src/a.ts");

    writeFileSync(join(root, "src", "human.ts"), "human work in progress");
    snap.restore();

    expect(readFileSync(join(root, "src", "human.ts"), "utf8")).toBe("human work in progress");
  });

  it("continues past a failure and reports it rather than aborting midway", () => {
    const root = repo();
    writeFileSync(join(root, "src", "b.ts"), "b original");
    const snap = new WorkspaceSnapshot(root);
    snap.captureAll(["src/a.ts", "src/b.ts"]);

    // Make one restore target a directory so writeFileSync throws.
    rmSync(join(root, "src", "a.ts"));
    mkdirSync(join(root, "src", "a.ts"));

    writeFileSync(join(root, "src", "b.ts"), "b clobbered");
    const report = snap.restore();

    expect(report.failed.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(readFileSync(join(root, "src", "b.ts"), "utf8")).toBe("b original");
  });

  it("repeat captures keep the earliest state", () => {
    const root = repo();
    const snap = new WorkspaceSnapshot(root);
    snap.capture("src/a.ts");
    writeFileSync(join(root, "src", "a.ts"), "later");
    snap.capture("src/a.ts");
    snap.restore();

    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("original");
  });
});

describe("ApprovalGate fails closed (TRD-022 / REQ-014)", () => {
  function host(hasUI: boolean, answer: boolean | Error = true): ApprovalHost & { asked: number } {
    return {
      hasUI,
      asked: 0,
      async confirm() {
        (this as { asked: number }).asked += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
  }

  it("AC-014-1: denies without asking when hasUI is false", async () => {
    const h = host(false);
    const d = await new ApprovalGate(h).request({ title: "Apply fix", message: "?" });

    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/no UI/);
    expect(h.asked).toBe(0);
  });

  it("AC-014-2: honours yes and no when a UI exists", async () => {
    expect((await new ApprovalGate(host(true, true)).request({ title: "t", message: "m" })).approved).toBe(true);
    expect((await new ApprovalGate(host(true, false)).request({ title: "t", message: "m" })).approved).toBe(false);
  });

  it("a failing prompt is not consent", async () => {
    const d = await new ApprovalGate(host(true, new Error("ipc closed"))).request({ title: "t", message: "m" });
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/ipc closed/);
  });
});

describe("protected paths cannot be bypassed by capitalisation", () => {
  it("case-insensitive filesystems make Mutation-Guard.ts the same file", () => {
    // macOS/Windows resolve these to the protected file, so a
    // case-sensitive rule would be bypassable by pressing shift.
    for (const p of [
      "src/behavior/Mutation-Guard.ts",
      "packages/agent-core/TESTS/a.ts",
      "src/Foo.TEST.ts",
      "DOCS/standards/Constitution.md",
      "behaviors/x/FIXTURES/events/a.json",
    ]) {
      expect(isProtectedPath(p)).toBe(true);
    }
  });

  it("the guard refuses a capitalised test path in mode:auto", () => {
    const d = guard("auto").authorize({ mutationClass: "artifact.write", path: "Tests/Foo.Test.TS", kind: "write" });
    expect(d.allowed).toBe(false);
  });
});

describe("WorkspaceSnapshot preserves bytes and modes, not just text", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("restores binary content byte-for-byte", () => {
    // A utf8 decode/encode round-trip silently mangles these bytes.
    const root = mkdtempSync(join(tmpdir(), "bin-"));
    dirs.push(root);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80, 0x01]);
    writeFileSync(join(root, "img.png"), bytes);

    const snap = new WorkspaceSnapshot(root);
    snap.capture("img.png");
    writeFileSync(join(root, "img.png"), Buffer.from([0x00]));
    snap.restore();

    expect(readFileSync(join(root, "img.png")).equals(bytes)).toBe(true);
  });

  it("restores the executable bit", () => {
    const root = mkdtempSync(join(tmpdir(), "mode-"));
    dirs.push(root);
    const file = join(root, "run.sh");
    writeFileSync(file, "#!/bin/sh\necho hi\n", { mode: 0o755 });

    const snap = new WorkspaceSnapshot(root);
    snap.capture("run.sh");
    writeFileSync(file, "clobbered", { mode: 0o644 });
    snap.restore();

    expect(statSync(file).mode & 0o777).toBe(0o755);
  });
});
