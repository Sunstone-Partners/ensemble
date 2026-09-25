import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteBoundaryMonitor } from "../src/behavior/write-boundary-monitor";

/**
 * Consent path for protected writes (br-9uqd).
 *
 * The monitor used to revert every protected write silently, which made the
 * repository's own guardrail sources uneditable from any session that had the
 * runtime loaded -- the maintainer was locked out by the thing meant to stop
 * an autonomous loop. These tests pin the split that fixes it: detection
 * (`pending`) must not mutate anything, and acceptance must be narrow enough
 * that it cannot become a standing bypass.
 *
 * Real git repositories and real files throughout; the monitor shells out to
 * git, so a mocked filesystem would prove nothing about how it behaves.
 */

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wbm-consent-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  mkdirSync(join(dir, "src", "behavior"), { recursive: true });
  writeFileSync(join(dir, "src", "behavior", "mutation-guard.ts"), "export const original = 1;\n");
  writeFileSync(join(dir, "src", "plain.ts"), "export const plain = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

const GUARD = "src/behavior/mutation-guard.ts";

function armed(dir: string): WriteBoundaryMonitor {
  const m = new WriteBoundaryMonitor(dir);
  m.protectAll([GUARD, "src/plain.ts"]);
  return m;
}

describe("WriteBoundaryMonitor consent path", () => {
  it("pending() reports a protected change without reverting it", () => {
    const dir = repo();
    const m = armed(dir);
    writeFileSync(join(dir, GUARD), "export const original = 999;\n");

    const found = m.pending();

    expect(found.map((v) => v.path)).toEqual([GUARD]);
    // The whole point: the edit is still on disk, so a human can be asked.
    expect(readFileSync(join(dir, GUARD), "utf8")).toContain("999");
  });

  it("check() still reverts when nothing was accepted", () => {
    const dir = repo();
    const m = armed(dir);
    writeFileSync(join(dir, GUARD), "export const original = 999;\n");

    const result = m.check();

    expect(result.violations.map((v) => v.path)).toEqual([GUARD]);
    expect(readFileSync(join(dir, GUARD), "utf8")).toContain("original = 1");
  });

  it("accept() lets an approved change survive a later check()", () => {
    const dir = repo();
    const m = armed(dir);
    writeFileSync(join(dir, GUARD), "export const original = 999;\n");

    m.accept(GUARD);
    const result = m.check();

    expect(result.violations).toEqual([]);
    expect(readFileSync(join(dir, GUARD), "utf8")).toContain("999");
  });

  it("accept() authorizes ONE change, not the path forever", () => {
    const dir = repo();
    const m = armed(dir);
    writeFileSync(join(dir, GUARD), "export const original = 999;\n");
    m.accept(GUARD);

    // A second, unapproved edit to the same path must not inherit consent.
    writeFileSync(join(dir, GUARD), "export const original = 666;\n");
    const result = m.check();

    expect(result.violations.map((v) => v.path)).toEqual([GUARD]);
    // Reverted to the APPROVED state, not to the original -- the approval
    // stands, the unapproved edit on top of it does not.
    expect(readFileSync(join(dir, GUARD), "utf8")).toContain("999");
  });

  it("pending() ignores unprotected paths", () => {
    const dir = repo();
    const m = armed(dir);
    writeFileSync(join(dir, "src/plain.ts"), "export const plain = 2;\n");

    expect(m.pending()).toEqual([]);
    // And an ordinary source file is never reverted.
    m.check();
    expect(readFileSync(join(dir, "src/plain.ts"), "utf8")).toContain("plain = 2");
  });

  it("pending() is idempotent and side-effect free across repeated calls", () => {
    const dir = repo();
    const m = armed(dir);
    writeFileSync(join(dir, GUARD), "export const original = 999;\n");

    const a = m.pending();
    const b = m.pending();

    expect(a).toEqual(b);
    expect(existsSync(join(dir, GUARD))).toBe(true);
    expect(readFileSync(join(dir, GUARD), "utf8")).toContain("999");
  });
});
