import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotWorkingTree, restoreWorkingTree } from "../src/working-tree-snapshot";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "wts-"));
  const g = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  writeFileSync(join(root, "src.ts"), "committed\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  return root;
}

describe("rollback undoes the fix without destroying the user's work", () => {
  it("reverts a modification made after the snapshot", () => {
    const root = repo();
    const snap = snapshotWorkingTree(root);
    writeFileSync(join(root, "src.ts"), "BAD FIX\n");
    const r = restoreWorkingTree(snap);
    expect(r.restored).toBe(true);
    expect(readFileSync(join(root, "src.ts"), "utf8")).toBe("committed\n");
  });

  // The property that makes rollback safe to enable. A rollback that reverts
  // to HEAD would silently delete uncommitted work the user had in progress
  // before autofix ever ran -- turning a failed fix into data loss.
  it("PRESERVES edits that existed before the snapshot", () => {
    const root = repo();
    writeFileSync(join(root, "src.ts"), "MY OWN WORK IN PROGRESS\n");
    const snap = snapshotWorkingTree(root);

    writeFileSync(join(root, "src.ts"), "MY OWN WORK IN PROGRESS\nBAD FIX\n");
    const r = restoreWorkingTree(snap);

    expect(r.restored).toBe(true);
    expect(readFileSync(join(root, "src.ts"), "utf8")).toBe("MY OWN WORK IN PROGRESS\n");
  });

  it("removes files the fix created", () => {
    const root = repo();
    const snap = snapshotWorkingTree(root);
    writeFileSync(join(root, "invented.ts"), "export const x = 1;\n");
    const r = restoreWorkingTree(snap);
    expect(r.removed).toContain("invented.ts");
    expect(existsSync(join(root, "invented.ts"))).toBe(false);
  });

  // Symmetric to the above: an untracked file that predates the fix is the
  // user's, not ours, and deleting it would be data loss.
  it("does NOT remove untracked files that predate the snapshot", () => {
    const root = repo();
    writeFileSync(join(root, "scratch.txt"), "mine\n");
    const snap = snapshotWorkingTree(root);
    writeFileSync(join(root, "invented.ts"), "x\n");
    const r = restoreWorkingTree(snap);
    expect(r.removed).toEqual(["invented.ts"]);
    expect(existsSync(join(root, "scratch.txt"))).toBe(true);
    expect(readFileSync(join(root, "scratch.txt"), "utf8")).toBe("mine\n");
  });
});
