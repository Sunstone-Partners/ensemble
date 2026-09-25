import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteBoundaryMonitor } from "../src/behavior/write-boundary-monitor";

/**
 * AC-018-5. A behavior may be granted a shell tool (investigate-test-failure
 * grants ensemble.bash) while being granted no edit/write tool. A tool-name
 * grant check cannot see what a shell command does, so `cat > file` is
 * invisible to it. The effect-based write boundary is the only thing that can
 * catch that, and this exercises it with a REAL shell redirect rather than a
 * writeFileSync stand-in -- the bypass only matters if it works through the
 * shell.
 */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "shell-redirect-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "tests"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "tests/math.test.ts"), "expect(add(1,1)).toBe(2);\n");
  writeFileSync(join(root, "src/math.ts"), "export const add = (a,b) => a-b;\n");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
  return root;
}

const shell = (root: string, cmd: string) => execFileSync("bash", ["-lc", cmd], { cwd: root });

describe("AC-018-5: a granted shell tool cannot quietly rewrite protected paths", () => {
  it("detects and reverts a TEST FILE rewritten by shell redirect", () => {
    const root = repo();
    const monitor = new WriteBoundaryMonitor(root);
    monitor.protectAll(["tests/math.test.ts", "src/math.ts"]);

    // The bypass: no edit/write tool involved at all.
    shell(root, "cat > tests/math.test.ts <<'EOF'\nexpect(true).toBe(true);\nEOF");
    expect(readFileSync(join(root, "tests/math.test.ts"), "utf8")).toContain("true");

    const result = monitor.check();
    const violation = result.violations.find((v) => v.path === "tests/math.test.ts");
    expect(violation).toBeDefined();
    expect(violation?.reason).toBe("test-file");
    expect(violation?.restored).toBe(true);
    // The weakened assertion is gone from disk, not merely reported.
    expect(readFileSync(join(root, "tests/math.test.ts"), "utf8")).toContain("toBe(2)");
  });

  it("detects a test file DELETED by shell", () => {
    const root = repo();
    const monitor = new WriteBoundaryMonitor(root);
    monitor.protectAll(["tests/math.test.ts", "src/math.ts"]);

    shell(root, "rm tests/math.test.ts");
    const result = monitor.check();

    expect(result.violations.some((v) => v.path === "tests/math.test.ts")).toBe(true);
    expect(existsSync(join(root, "tests/math.test.ts"))).toBe(true);
  });

  it("leaves ORDINARY SOURCE written by shell alone -- that is mutation policy, not the write boundary", () => {
    const root = repo();
    const monitor = new WriteBoundaryMonitor(root);
    monitor.protectAll(["tests/math.test.ts", "src/math.ts"]);

    shell(root, "cat > src/math.ts <<'EOF'\nexport const add = (a,b) => a+b;\nEOF");
    const result = monitor.check();

    expect(result.violations.some((v) => v.path === "src/math.ts")).toBe(false);
    expect(readFileSync(join(root, "src/math.ts"), "utf8")).toContain("a+b");
  });
});
