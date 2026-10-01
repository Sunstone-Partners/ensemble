import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteBoundaryMonitor, changedPaths } from "@sunstone-partners/ensemble-agent-core";
import { createConstitutionApplier, CONSTITUTION_PATH } from "../src/constitution-applier";
import type { ConstitutionChange } from "../src/constitution-proposal";

/**
 * The step that makes the constitution update real: an approved amendment
 * has to survive the write boundary that (correctly) protects that file.
 *
 * Driven against the REAL WriteBoundaryMonitor, not a stub. A stub would
 * happily accept a call that does nothing, and the failure mode here is
 * exactly that: approve -> write -> reverted on the next tool call -> the
 * loop reports success and the constitution is unchanged.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const change: ConstitutionChange = {
  behaviorName: "investigate-test-failure",
  rationale: "a pipe masked a failing suite, so exit status alone was trusted",
  diff: "- Test verification MUST NOT rely on the exit status of a pipeline.",
};

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "constitution-"));
  dirs.push(root);
  mkdirSync(join(root, "docs", "standards"), { recursive: true });
  writeFileSync(join(root, CONSTITUTION_PATH), "# Constitution\n\n## Existing rule\n\nKeep me.\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
  return root;
}

describe("applying an approved constitution change", () => {
  it("survives the write boundary that protects the file", () => {
    const root = repo();
    const monitor = new WriteBoundaryMonitor(root);
    monitor.protectAll([...changedPaths(root), CONSTITUTION_PATH]);

    const apply = createConstitutionApplier({
      rootDir: root,
      accept: (p) => monitor.accept(p),
      now: () => new Date("2026-09-28T00:00:00Z"),
    });

    const applied = apply(change);
    expect(applied.path).toBe(CONSTITUTION_PATH);

    // The boundary runs after every tool call. Without the re-baseline this
    // is where the approved amendment would vanish.
    const result = monitor.check();

    expect(result.violations).toEqual([]);
    const text = readFileSync(join(root, CONSTITUTION_PATH), "utf8");
    expect(text).toContain("Amendment 2026-09-28: investigate-test-failure");
    expect(text).toContain("MUST NOT rely on the exit status of a pipeline");
  });

  it("appends, leaving existing rules byte-identical", () => {
    // A model rewriting the whole document can silently drop rules while
    // "adding" one. Appending is the narrowest operation that still records
    // the decision.
    const root = repo();
    const before = readFileSync(join(root, CONSTITUTION_PATH), "utf8");
    const apply = createConstitutionApplier({ rootDir: root, accept: () => undefined });

    apply(change);

    const after = readFileSync(join(root, CONSTITUTION_PATH), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain("## Existing rule");
  });

  it("a LATER unapproved edit is still reverted to the approved text", () => {
    // accept() authorises one state, not the path. The boundary must keep
    // protecting the file after an amendment lands.
    const root = repo();
    const monitor = new WriteBoundaryMonitor(root);
    monitor.protectAll([...changedPaths(root), CONSTITUTION_PATH]);
    const apply = createConstitutionApplier({ rootDir: root, accept: (p) => monitor.accept(p) });

    apply(change);
    monitor.check();

    writeFileSync(join(root, CONSTITUTION_PATH), "# Gutted\n");
    const result = monitor.check();

    expect(result.violations.map((v) => v.path)).toEqual([CONSTITUTION_PATH]);
    const text = readFileSync(join(root, CONSTITUTION_PATH), "utf8");
    expect(text).toContain("## Existing rule");
    expect(text).not.toContain("# Gutted");
  });

  it("refuses when there is no constitution to amend", () => {
    const root = mkdtempSync(join(tmpdir(), "no-constitution-"));
    dirs.push(root);
    const apply = createConstitutionApplier({ rootDir: root, accept: () => undefined });

    expect(() => apply(change)).toThrow(/constitution not found/);
  });
});
