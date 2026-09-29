import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotWorkingTree, snapshotWasClean, changesSinceCleanSnapshot, planHold } from "../src/working-tree-snapshot";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "hold-"));
  const g = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  writeFileSync(join(root, "src.ts"), "committed\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  return root;
}

/**
 * br-dowt. Under `policy.mode: propose` a verified fix must not land until a
 * human applies it. When the tree baseline was missing, the hold was skipped
 * and the fix was LEFT APPLIED -- fail OPEN, in a system that fails closed
 * everywhere else. Observed live:
 *
 *   verification { status: 'passed',
 *                  holdSkipped: 'no tree baseline; fix left applied' }
 *
 * None of this was tested, because the decision lived inside activate() where
 * no test could reach it. That is how it survived.
 */
describe("a verified fix is held even without a baseline (br-dowt)", () => {
  it("holds the fix when the tree was clean, with no baseline at all", () => {
    const root = repo();
    const snap = snapshotWorkingTree(root);
    writeFileSync(join(root, "src.ts"), "the fix\n");

    const plan = planHold(snap, undefined);

    // Previously: { paths: [], unheld: ... } -- left applied, unreviewed.
    expect(plan.unheld).toBeUndefined();
    expect(plan.paths).toEqual(["src.ts"]);
  });

  it("holds a file the fix created, not just one it edited", () => {
    const root = repo();
    const snap = snapshotWorkingTree(root);
    writeFileSync(join(root, "invented.ts"), "export const x = 1;\n");

    expect(planHold(snap, undefined).paths).toEqual(["invented.ts"]);
  });

  // The safety limit on the above. With edits already in flight there is no
  // way to tell the fix from the human's work, and reverting would sweep
  // their work into memory-only quarantine -- a worse failure than the one
  // being prevented. So this case stays applied, but must say so.
  it("refuses to guess when the user already had uncommitted work", () => {
    const root = repo();
    writeFileSync(join(root, "src.ts"), "MY OWN WORK IN PROGRESS\n");
    const snap = snapshotWorkingTree(root);
    writeFileSync(join(root, "src.ts"), "MY OWN WORK IN PROGRESS\nthe fix\n");

    const plan = planHold(snap, undefined);

    expect(plan.paths).toEqual([]);
    expect(plan.unheld).toMatch(/cannot be told apart from your work/);
  });

  it("treats a pre-existing untracked file as work in flight", () => {
    const root = repo();
    writeFileSync(join(root, "scratch.md"), "notes\n");
    const snap = snapshotWorkingTree(root);
    writeFileSync(join(root, "src.ts"), "the fix\n");

    expect(planHold(snap, undefined).unheld).toBeDefined();
  });

  // Runtime state is written by the session itself during every run. Counting
  // it as "work in flight" would push every run into the ambiguous branch and
  // re-open the fail-open hole by the back door.
  it("does not count the runtime's own log as the user's work", () => {
    const root = repo();
    mkdirSync(join(root, ".ensemble"), { recursive: true });
    writeFileSync(join(root, ".ensemble/runtime-log.jsonl"), "{}\n");
    const snap = snapshotWorkingTree(root);
    writeFileSync(join(root, "src.ts"), "the fix\n");

    const plan = planHold(snap, undefined);
    expect(plan.unheld).toBeUndefined();
    expect(plan.paths).toEqual(["src.ts"]);
  });

  it("keeps using the baseline when one exists", () => {
    const root = repo();
    const snap = snapshotWorkingTree(root);
    // A baseline answer wins outright: it is the precise one.
    expect(planHold(snap, ["only.ts"]).paths).toEqual(["only.ts"]);
  });

  it("holds nothing when a clean tree is still clean", () => {
    const root = repo();
    const snap = snapshotWorkingTree(root);
    const plan = planHold(snap, undefined);
    expect(plan.unheld).toBeUndefined();
    expect(plan.paths).toEqual([]);
  });
});

describe("snapshot cleanliness is judged conservatively", () => {
  it("is clean for a pristine checkout", () => {
    expect(snapshotWasClean(snapshotWorkingTree(repo()))).toBe(true);
  });

  it("is dirty with a modified tracked file", () => {
    const root = repo();
    writeFileSync(join(root, "src.ts"), "edited\n");
    expect(snapshotWasClean(snapshotWorkingTree(root))).toBe(false);
  });

  it("is dirty with an untracked file", () => {
    const root = repo();
    writeFileSync(join(root, "new.ts"), "x\n");
    expect(snapshotWasClean(snapshotWorkingTree(root))).toBe(false);
  });

  it("reports both modified and newly created paths as changes", () => {
    const root = repo();
    const snap = snapshotWorkingTree(root);
    writeFileSync(join(root, "src.ts"), "edited\n");
    writeFileSync(join(root, "added.ts"), "x\n");
    expect(changesSinceCleanSnapshot(snap)).toEqual(["added.ts", "src.ts"]);
  });
});
