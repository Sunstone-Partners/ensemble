import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTreeBaseline, changedSinceBaseline, treeChangesSinceBaseline } from "../src/tree-baseline";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "tbl-"));
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
 * br-dowt. An untracked SYMLINK TO A DIRECTORY -- `node_modules` in every
 * repository that shares dependencies -- made baseline capture return
 * undefined for the WHOLE tree:
 *
 *   $ git ls-files --others --exclude-standard -z | git hash-object --stdin-paths
 *   444728d528c87c8cf015c947159dacb75bcc973c
 *   fatal: Unable to hash node_modules
 *   exit=128
 *
 * `--stdin-paths` is all-or-nothing, so one unhashable entry lost every id,
 * `ids.length !== paths.length` tripped, and the caller got "no baseline".
 *
 * The consequence was not a missing log line. With no baseline the approval
 * hold was skipped and the fix was LEFT APPLIED -- a change under
 * `policy.mode: propose` landing with no human ever asked. Observed live:
 * verification { holdSkipped: "no tree baseline; fix left applied" }.
 *
 * Same hazard as br-boam, different function: git and node file APIs both
 * treat a symlinked directory as an ordinary entry right up until they don't.
 */
describe("a baseline survives entries git cannot hash (br-dowt)", () => {
  it("captures a baseline when an untracked symlinked directory is present", () => {
    const root = repo();
    const target = mkdtempSync(join(tmpdir(), "tbl-target-"));
    mkdirSync(join(target, "pkg"), { recursive: true });
    symlinkSync(target, join(root, "node_modules"));

    const baseline = captureTreeBaseline(root);

    // Before the fix this was `undefined`, which the caller read as
    // "not a git work tree" -- it is a perfectly good clone.
    expect(baseline).toBeDefined();
    rmSync(target, { recursive: true, force: true });
  });

  // The point of the baseline is telling the fix's edits from the user's, so
  // surviving is not enough: it has to still answer that question correctly
  // with the symlink present.
  it("still detects a real content change alongside the symlink", () => {
    const root = repo();
    const target = mkdtempSync(join(tmpdir(), "tbl-target-"));
    symlinkSync(target, join(root, "node_modules"));

    const baseline = captureTreeBaseline(root);
    expect(baseline).toBeDefined();
    writeFileSync(join(root, "src.ts"), "changed by the fix\n");

    expect(treeChangesSinceBaseline(baseline!)).toEqual(["src.ts"]);
    rmSync(target, { recursive: true, force: true });
  });

  it("reports no change when only the symlink is present and nothing was edited", () => {
    const root = repo();
    const target = mkdtempSync(join(tmpdir(), "tbl-target-"));
    symlinkSync(target, join(root, "node_modules"));

    const baseline = captureTreeBaseline(root);
    expect(treeChangesSinceBaseline(baseline!)).toEqual([]);
    rmSync(target, { recursive: true, force: true });
  });

  // A symlink is content: repointing node_modules at a different tree changes
  // what the code under test imports. Recording it by target keeps that
  // visible instead of quietly dropping the entry to make the error go away.
  it("notices when an untracked symlink is repointed", () => {
    const root = repo();
    const a = mkdtempSync(join(tmpdir(), "tbl-a-"));
    const b = mkdtempSync(join(tmpdir(), "tbl-b-"));
    symlinkSync(a, join(root, "node_modules"));

    const baseline = captureTreeBaseline(root);
    rmSync(join(root, "node_modules"));
    symlinkSync(b, join(root, "node_modules"));

    expect(treeChangesSinceBaseline(baseline!)).toEqual(["node_modules"]);
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });

  // `changedSinceBaseline` is called directly with a fix candidate's paths,
  // where nothing has compared the captured maps first. Both sides must
  // describe a symlink the same way, or an untouched link reads as changed
  // and a good candidate is rejected as stale.
  it("does not report an untouched symlink as changed when compared directly", () => {
    const root = repo();
    const target = mkdtempSync(join(tmpdir(), "tbl-target-"));
    symlinkSync(target, join(root, "node_modules"));

    const baseline = captureTreeBaseline(root);
    expect(changedSinceBaseline(baseline!, ["node_modules"])).toEqual([]);
    rmSync(target, { recursive: true, force: true });
  });

  // Regression guard for the ordinary path: pairing ids to paths by index is
  // only safe while the two lists correspond, so the filtering must not
  // shuffle them.
  it("still maps several untracked files to their own contents", () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "aaa\n");
    writeFileSync(join(root, "b.txt"), "bbb\n");
    writeFileSync(join(root, "c.txt"), "ccc\n");
    const baseline = captureTreeBaseline(root);
    expect(baseline).toBeDefined();

    writeFileSync(join(root, "b.txt"), "b CHANGED\n");
    expect(treeChangesSinceBaseline(baseline!)).toEqual(["b.txt"]);
  });
});
