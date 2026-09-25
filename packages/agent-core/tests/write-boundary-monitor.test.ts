import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { WriteBoundaryMonitor } from "../src/behavior/write-boundary-monitor";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "wbm-"));
  dirs.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "tests"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "tests", "a.test.js"), "ORIGINAL");
  writeFileSync(join(root, "src", "a.js"), "src");
  return root;
}

describe("WriteBoundaryMonitor", () => {
  it("reverts a modified protected file that existed at activation", () => {
    const root = repo();
    const m = new WriteBoundaryMonitor(root);
    m.protectAll(["tests/a.test.js", "src/a.js"]);

    writeFileSync(join(root, "tests", "a.test.js"), "GUTTED");
    const r = m.check();

    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ path: "tests/a.test.js", restored: true });
    expect(readFileSync(join(root, "tests", "a.test.js"), "utf8")).toBe("ORIGINAL");
  });

  it("ignores non-protected changes", () => {
    const root = repo();
    const m = new WriteBoundaryMonitor(root);
    m.protectAll(["tests/a.test.js", "src/a.js"]);
    writeFileSync(join(root, "src", "a.js"), "changed");
    expect(m.check().violations).toEqual([]);
  });

  it("detects and restores a DELETED captured protected file", () => {
    // A protected file that git does not track simply vanishes from
    // `git status` when deleted -- it is not reported as a change. So a
    // monitor that only inspects git's changed-set is blind to the
    // single most destructive edit available. Captured paths must be
    // checked directly, independent of what git reports.
    const root = repo();
    const m = new WriteBoundaryMonitor(root);
    m.protectAll(["tests/a.test.js", "src/a.js"]);

    rmSync(join(root, "tests", "a.test.js"));
    expect(existsSync(join(root, "tests", "a.test.js"))).toBe(false);

    const r = m.check();

    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ path: "tests/a.test.js", restored: true });
    expect(readFileSync(join(root, "tests", "a.test.js"), "utf8")).toBe("ORIGINAL");
  });

  it("deletes a protected file created after activation", () => {
    const root = repo();
    const m = new WriteBoundaryMonitor(root);
    m.protectAll(["tests/a.test.js"]);

    writeFileSync(join(root, "tests", "new.test.js"), "assert(true)");
    const r = m.check();

    expect(r.violations.find((v) => v.path === "tests/new.test.js")).toMatchObject({ restored: true });
    expect(existsSync(join(root, "tests", "new.test.js"))).toBe(false);
  });

  it("NEVER deletes when the capture pass was incomplete", () => {
    // The dangerous case: if capture failed partway, absence from
    // `captured` proves nothing, and deleting would destroy a
    // pre-existing file rather than restore it.
    const root = repo();
    const m = new WriteBoundaryMonitor(root);
    // A directory where a file is expected makes capture throw.
    mkdirSync(join(root, "tests", "broken.test.js"), { recursive: true });
    writeFileSync(join(root, "tests", "broken.test.js", "inner"), "x");
    m.protectAll(["tests/broken.test.js", "tests/a.test.js"]);

    expect(m.canInferNonExistence).toBe(false);

    // A pre-existing protected file that capture never reached.
    writeFileSync(join(root, "tests", "untouched.test.js"), "PRE-EXISTING");
    const r = m.check();

    expect(existsSync(join(root, "tests", "untouched.test.js"))).toBe(true);
    expect(readFileSync(join(root, "tests", "untouched.test.js"), "utf8")).toBe("PRE-EXISTING");
    expect(r.violations.find((v) => v.path === "tests/untouched.test.js")?.restored).toBe(false);
  });
});
