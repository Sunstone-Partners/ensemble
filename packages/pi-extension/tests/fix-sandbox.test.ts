import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  chmodSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixSandbox } from "../src/fix-sandbox";

/**
 * br-r3om: the fix-provider child ran in the LIVE repository with
 * --no-extensions, so no grant, guard, boundary or log applied to it.
 *
 * Acceptance from the bead: "a child that tries to write a file directly
 * leaves the repository unchanged (proven by a test whose fake child writes
 * to disk)". These tests do exactly that -- the "child" here is a real
 * process writing real files into the directory it was handed.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "sandbox-src-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "committed.ts"), "export const a = 1;\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
  return root;
}

describe("fix-provider sandbox", () => {
  it("absorbs writes a child makes, leaving the live tree untouched", () => {
    const root = repo();
    const sandbox = createFixSandbox(root)!;
    expect(sandbox).toBeDefined();

    // Stand in for the child: write into the directory it was given, the
    // way an ungoverned agent with write tools would.
    writeFileSync(join(sandbox.dir, "src", "committed.ts"), "export const a = 999;\n");
    writeFileSync(join(sandbox.dir, "pretest-hook.json"), "{}\n");

    // The live repository is untouched: same content, no new file.
    expect(readFileSync(join(root, "src", "committed.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(existsSync(join(root, "pretest-hook.json"))).toBe(false);

    sandbox.cleanup();
    expect(existsSync(sandbox.dir)).toBe(false);
  });

  it("mirrors uncommitted work, or the child debugs a healthy repo", () => {
    // The failing test is normally the thing just written. A sandbox at
    // HEAD would not reproduce the failure at all.
    const root = repo();
    writeFileSync(join(root, "src", "committed.ts"), "export const a = 2; // edited\n");
    writeFileSync(join(root, "src", "brand-new.test.ts"), "it('fails', () => expect(1).toBe(2));\n");

    const sandbox = createFixSandbox(root)!;

    expect(readFileSync(join(sandbox.dir, "src", "committed.ts"), "utf8")).toContain("// edited");
    expect(readFileSync(join(sandbox.dir, "src", "brand-new.test.ts"), "utf8")).toContain("fails");
    sandbox.cleanup();
  });

  it("does not copy ignored files", () => {
    const root = repo();
    writeFileSync(join(root, ".gitignore"), "secrets.txt\n");
    writeFileSync(join(root, "secrets.txt"), "token\n");

    const sandbox = createFixSandbox(root)!;

    expect(existsSync(join(sandbox.dir, "secrets.txt"))).toBe(false);
    sandbox.cleanup();
  });

  it("cleans up without disturbing the live repository", () => {
    const root = repo();
    const sandbox = createFixSandbox(root)!;
    sandbox.cleanup();

    // No stale worktree registration left behind, and the tree still works.
    // Only the repository itself remains registered. (Asserting on the name
    // would be meaningless here: the test repo is itself called
    // "sandbox-src-...", which the first version of this test tripped over.)
    const worktrees = execFileSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((line) => line.trim());
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).not.toContain("ensemble-fix");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe("");
  });

  it("returns undefined outside a git repository, so the caller fails closed", () => {
    const plain = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    dirs.push(plain);

    expect(createFixSandbox(plain)).toBeUndefined();
  });
});

/**
 * br-boam, observed live twice before it was understood.
 *
 * `git ls-files --others` reports a symlinked DIRECTORY as one entry.
 * copyFileSync on it throws ENOTSUP, the blanket catch returned undefined,
 * the provider failed closed, and the log said "no fix candidate offered" --
 * indistinguishable from a model that had nothing to suggest. The governed
 * path was disabled entirely, and because the continuation path still
 * repaired the code, the session looked like a success.
 */
describe("a symlink in the tree does not disable the governed path", () => {
  it("builds the sandbox when an untracked symlinked directory is present", () => {
    const root = repo();
    const elsewhere = mkdtempSync(join(tmpdir(), "sandbox-deps-"));
    dirs.push(elsewhere);
    writeFileSync(join(elsewhere, "marker.txt"), "dep\n");
    // Exactly the shape that broke it: an untracked, NOT-ignored symlink
    // pointing at a directory.
    symlinkSync(elsewhere, join(root, "vendored"));

    const problems: string[] = [];
    const sandbox = createFixSandbox(root, (r) => problems.push(r));

    expect(sandbox).toBeDefined();
    expect(problems).toEqual([]);
    sandbox!.cleanup();
  });

  it("recreates the symlink as a symlink rather than copying through it", () => {
    const root = repo();
    const elsewhere = mkdtempSync(join(tmpdir(), "sandbox-deps-"));
    dirs.push(elsewhere);
    writeFileSync(join(elsewhere, "marker.txt"), "dep\n");
    symlinkSync(elsewhere, join(root, "vendored"));

    const sandbox = createFixSandbox(root)!;
    const mirrored = join(sandbox.dir, "vendored");

    expect(lstatSync(mirrored).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(mirrored, "marker.txt"), "utf8")).toBe("dep\n");
    sandbox!.cleanup();
  });

  it("reports why the sandbox could not be built instead of failing silently", () => {
    // Not a git repository at all: worktree add fails.
    const notARepo = mkdtempSync(join(tmpdir(), "sandbox-bare-"));
    dirs.push(notARepo);

    const problems: string[] = [];
    const sandbox = createFixSandbox(notARepo, (r) => problems.push(r));

    expect(sandbox).toBeUndefined();
    expect(problems.join(" ")).toMatch(/could not be built/);
  });

  it("still mirrors ordinary untracked files", () => {
    const root = repo();
    writeFileSync(join(root, "new-failing.test.js"), "test\n");
    symlinkSync(mkdtempSync(join(tmpdir(), "sandbox-x-")), join(root, "linked"));

    const sandbox = createFixSandbox(root)!;
    expect(readFileSync(join(sandbox.dir, "new-failing.test.js"), "utf8")).toBe("test\n");
    sandbox!.cleanup();
  });
  it("does not mirror an untracked node_modules file-by-file", () => {
    const root = repo();
    // No .gitignore, so git lists every one of these as untracked. Mirroring
    // them is pure cost: linkNodeModules() links the directory wholesale.
    mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");

    const sandbox = createFixSandbox(root)!;
    // Linked, not copied: the mirrored path resolves to the live one.
    expect(lstatSync(join(sandbox.dir, "node_modules")).isSymbolicLink()).toBe(true);
    sandbox.cleanup();
  });

  it("keeps the sandbox when a single untracked entry cannot be mirrored", () => {
    const root = repo();
    // An unreadable regular file. git DOES list it, lstat says regular, so
    // copyFileSync is genuinely attempted and genuinely throws EACCES --
    // which is the case that used to abandon the entire sandbox.
    //
    // A fifo does not work here: git ls-files --others omits non-regular,
    // non-symlink entries, so nothing is ever attempted and the test proves
    // nothing. (It failed exactly that way first.)
    //
    // Paired with a real file that must still arrive, because the claim
    // under test is "one bad entry does not cost the whole mirror".
    writeFileSync(join(root, "keeps-working.js"), "ok\n");
    writeFileSync(join(root, "unreadable.js"), "nope\n");
    chmodSync(join(root, "unreadable.js"), 0o000);

    const problems: string[] = [];
    const sandbox = createFixSandbox(root, (r) => problems.push(r));

    // The sandbox still exists...
    expect(sandbox).toBeDefined();
    // ...the innocent file still made it...
    expect(readFileSync(join(sandbox!.dir, "keeps-working.js"), "utf8")).toBe("ok\n");
    // ...and the one that could not be mirrored was REPORTED, not hidden.
    expect(problems.join(" ")).toMatch(/unreadable\.js/);
    chmodSync(join(root, "unreadable.js"), 0o644);
    sandbox!.cleanup();
  });
});
