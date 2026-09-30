import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteBoundaryMonitor, changedPaths } from "../src/behavior/write-boundary-monitor";

/**
 * A long-lived monitor versus a checkout that moves underneath it.
 *
 * The incident these cover: a session activated, someone else ran
 * `pull --ff-only` on the same checkout, and the next tool call -- a
 * read-only `ls` -- reverted four merged files to activation-time content,
 * destroying ~175 lines of tests that arrived with the merge. The monitor was
 * working exactly as written; "pristine" was simply stale.
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const GUARD = "packages/agent-core/src/behavior/mutation-guard.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** An origin repo plus a clone of it, both holding one protected file. */
function repoPair(): { origin: string; clone: string } {
  const root = mkdtempSync(join(tmpdir(), "ext-history-"));
  dirs.push(root);
  const origin = join(root, "origin");
  mkdirSync(join(origin, "packages", "agent-core", "src", "behavior"), { recursive: true });
  writeFileSync(join(origin, GUARD), "export const v = 1;\n");
  git(origin, ["init", "-q", "-b", "main"]);
  git(origin, ["config", "user.email", "t@t"]);
  git(origin, ["config", "user.name", "t"]);
  git(origin, ["add", "-A"]);
  git(origin, ["commit", "-qm", "init"]);

  const clone = join(root, "clone");
  git(root, ["clone", "-q", origin, clone]);
  git(clone, ["config", "user.email", "t@t"]);
  git(clone, ["config", "user.name", "t"]);
  return { origin, clone };
}

function armed(dir: string): WriteBoundaryMonitor {
  const monitor = new WriteBoundaryMonitor(dir);
  monitor.protectAll([...changedPaths(dir), GUARD]);
  return monitor;
}

describe("HEAD moving under a live monitor", () => {
  it("adopts work that arrived by pull instead of reverting it", () => {
    const { origin, clone } = repoPair();
    const monitor = armed(clone); // Baseline captured here, at v = 1.

    // A teammate lands new content and this checkout pulls it.
    writeFileSync(join(origin, GUARD), "export const v = 2;\n// merged work\n");
    git(origin, ["commit", "-qam", "upstream change"]);
    git(clone, ["pull", "-q", "--ff-only", "origin", "main"]);

    const result = monitor.check();

    expect(result.violations).toEqual([]);
    expect(readFileSync(join(clone, GUARD), "utf8")).toContain("merged work");
  });

  it("still reverts a local edit made after the pull", () => {
    const { origin, clone } = repoPair();
    const monitor = armed(clone);

    writeFileSync(join(origin, GUARD), "export const v = 2;\n// merged work\n");
    git(origin, ["commit", "-qam", "upstream change"]);
    git(clone, ["pull", "-q", "--ff-only", "origin", "main"]);
    monitor.check(); // Adopts the merged state.

    writeFileSync(join(clone, GUARD), "export const v = 2;\n// tampered\n");
    const result = monitor.check();

    expect(result.violations.map((v) => v.path)).toEqual([GUARD]);
    const onDisk = readFileSync(join(clone, GUARD), "utf8");
    expect(onDisk).toContain("merged work");
    expect(onDisk).not.toContain("tampered");
  });

  it("does NOT adopt a local commit, which would be a one-command bypass", () => {
    const { clone } = repoPair();
    const monitor = armed(clone);

    // The bypass: edit a protected file and commit it in a single shell
    // call, so HEAD moves and the file matches HEAD. Only the reflog
    // distinguishes this from a pull.
    writeFileSync(join(clone, GUARD), "export const v = 1;\n// laundered\n");
    git(clone, ["commit", "-qam", "sneak"]);

    const result = monitor.check();

    expect(result.violations.map((v) => v.path)).toEqual([GUARD]);
    expect(readFileSync(join(clone, GUARD), "utf8")).not.toContain("laundered");
  });

  it("does NOT adopt uncommitted changes riding along with a pull", () => {
    const { origin, clone } = repoPair();
    const monitor = armed(clone);

    writeFileSync(join(origin, GUARD), "export const v = 2;\n// merged work\n");
    git(origin, ["commit", "-qam", "upstream change"]);
    git(clone, ["pull", "-q", "--ff-only", "origin", "main"]);

    // Legitimate external move, but the working tree no longer matches HEAD.
    writeFileSync(join(clone, GUARD), "export const v = 2;\n// merged work\n// extra\n");
    const result = monitor.check();

    expect(result.violations.map((v) => v.path)).toEqual([GUARD]);
    expect(readFileSync(join(clone, GUARD), "utf8")).not.toContain("extra");
  });

  it("pending() reports nothing after an external pull", () => {
    const { origin, clone } = repoPair();
    const monitor = armed(clone);

    writeFileSync(join(origin, GUARD), "export const v = 2;\n// merged work\n");
    git(origin, ["commit", "-qam", "upstream change"]);
    git(clone, ["pull", "-q", "--ff-only", "origin", "main"]);

    expect(monitor.pending()).toEqual([]);
    expect(readFileSync(join(clone, GUARD), "utf8")).toContain("merged work");
  });

  it("does not resurrect a file the pull legitimately deleted", () => {
    const { origin, clone } = repoPair();
    const monitor = armed(clone); // Baseline says the file exists.

    execFileSync("git", ["rm", "-q", GUARD], { cwd: origin });
    git(origin, ["commit", "-qm", "drop the guard"]);
    git(clone, ["pull", "-q", "--ff-only", "origin", "main"]);

    const result = monitor.check();

    expect(result.violations).toEqual([]);
    expect(existsSync(join(clone, GUARD))).toBe(false);
  });

  it("still reverts a LOCAL deletion of a protected file", () => {
    const { clone } = repoPair();
    const monitor = armed(clone);

    rmSync(join(clone, GUARD));
    const result = monitor.check();

    expect(result.violations.map((v) => v.path)).toEqual([GUARD]);
    expect(existsSync(join(clone, GUARD))).toBe(true);
  });
});

/**
 * br-suoh: a checkout of just this PATH, not a ref, so HEAD never moves.
 *
 * `git checkout <sha> -- <path>` is the only agent-reachable way to undo a
 * bad protected-path commit, and it does not appear in the reflog the way
 * `pull`/`merge`/`switch` do -- syncExternalHistory's HEAD-oid check can
 * never see it. Without recognising the restored content by history, the
 * guard reverts the fix straight back to the bad commit it was correcting,
 * and every retry of the fix is itself a protected write, so no agent can
 * ever land it.
 */
describe("restoring a path from an older commit, HEAD unmoved (br-suoh)", () => {
  function commitAt(root: string, content: string, msg: string): string {
    writeFileSync(join(root, GUARD), content);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", msg]);
    return git(root, ["rev-parse", "HEAD"]).trim();
  }

  it("adopts a same-tool-call restore instead of reverting it back to the bad commit", () => {
    const root = join(mkdtempSync(join(tmpdir(), "br-suoh-")));
    dirs.push(root);
    mkdirSync(join(root, "packages", "agent-core", "src", "behavior"), { recursive: true });
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "t@t"]);
    git(root, ["config", "user.name", "t"]);
    const goodSha = commitAt(root, "export const v = 1;\n// good\n", "good");
    commitAt(root, "export const v = 1;\n// BROKEN unapproved wiring\n", "bad, committed");

    // Monitor activates on the already-broken committed state, exactly as a
    // session opened on a checkout that already has the bad commit would.
    const monitor = armed(root);

    // Recovery, inside a monitored call: restore just this path. HEAD itself
    // does not move.
    git(root, ["checkout", goodSha, "--", GUARD]);
    const result = monitor.check();

    expect(result.violations).toEqual([]);
    expect(readFileSync(join(root, GUARD), "utf8")).toContain("// good");
  });

  it("adopts a restore made by a human between tool calls, seen only via a later unrelated call", () => {
    const root = mkdtempSync(join(tmpdir(), "br-suoh-"));
    dirs.push(root);
    mkdirSync(join(root, "packages", "agent-core", "src", "behavior"), { recursive: true });
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "t@t"]);
    git(root, ["config", "user.name", "t"]);
    const goodSha = commitAt(root, "export const v = 1;\n// good\n", "good");
    commitAt(root, "export const v = 1;\n// BROKEN unapproved wiring\n", "bad, committed");

    const monitor = armed(root);
    monitor.check(); // an ordinary tool call, session already live on the bad state

    // The human intervenes OUTSIDE the agent, between tool calls.
    git(root, ["checkout", goodSha, "--", GUARD]);

    // The next tool call is unrelated and read-only, but still runs check().
    const result = monitor.check();

    expect(result.violations).toEqual([]);
    expect(readFileSync(join(root, GUARD), "utf8")).toContain("// good");
  });

  it("still reverts content that never appeared anywhere in HEAD's history", () => {
    const root = mkdtempSync(join(tmpdir(), "br-suoh-"));
    dirs.push(root);
    mkdirSync(join(root, "packages", "agent-core", "src", "behavior"), { recursive: true });
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "t@t"]);
    git(root, ["config", "user.name", "t"]);
    commitAt(root, "export const v = 1;\n", "base");
    const monitor = armed(root);

    // Brand new content, never committed on this branch -- not a restoration.
    writeFileSync(join(root, GUARD), "export const v = 1;\nexport const NEW = 2;\n");
    const result = monitor.check();

    expect(result.violations.map((v) => v.path)).toEqual([GUARD]);
    expect(readFileSync(join(root, GUARD), "utf8")).toBe("export const v = 1;\n");
  });

  it("leaves no stale staged blob in the index after a genuine revert", () => {
    const root = mkdtempSync(join(tmpdir(), "br-suoh-"));
    dirs.push(root);
    mkdirSync(join(root, "packages", "agent-core", "src", "behavior"), { recursive: true });
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "t@t"]);
    git(root, ["config", "user.name", "t"]);
    commitAt(root, "export const v = 1;\n", "base");
    const monitor = armed(root);

    // A bypass that both writes AND stages brand-new, non-historical content.
    writeFileSync(join(root, GUARD), "export const v = 1;\nexport const NEW = 2;\n");
    git(root, ["add", "--", GUARD]);
    monitor.check();

    expect(git(root, ["status", "--porcelain", "--", GUARD]).trim()).toBe("");
    expect(git(root, ["show", `:${GUARD}`])).toBe("export const v = 1;\n");
  });
});
