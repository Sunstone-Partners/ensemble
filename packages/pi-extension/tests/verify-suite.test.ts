import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySuite } from "../src/verify-suite";

/**
 * The verifier is the only thing standing between "the model says it fixed
 * it" and acceptance, so it MUST be able to fail.
 *
 * These grade a real test runner rather than a stubbed command: a verifier
 * proven only against a fake runner proves nothing about the runner it
 * actually grades. The fixture is built here rather than borrowed from /tmp
 * so the test is self-contained and cannot pass because of leftover state.
 */
function fixture(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "verify-suite-"));
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "src.js"), body);
  writeFileSync(
    join(root, "tests/sum.test.js"),
    'const { add } = require("../src.js");\ntest("adds", () => { expect(add(1,1)).toBe(2); });\n',
  );
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "vs-fixture", version: "1.0.0" }));
  return root;
}

const PASSING = "exports.add = (a, b) => a + b;\n";
const BROKEN = "exports.add = (a, b) => a - b;\n";
// Resolved from the workspace root (hoisted there, not per-package) so the
// fixture needs no install of its own. Verified rather than assumed: an
// unresolvable binary makes every verdict "inconclusive", which would let
// the inconclusive test pass while proving nothing.
const JEST = join(__dirname, "..", "..", "..", "node_modules", ".bin", "jest");
if (!existsSync(JEST)) throw new Error(`jest not found at ${JEST}`);
const CMD = `${JEST} --rootDir . sum`;

describe("verifySuite grades the suite, not the claim", () => {
  it("reports passed when the suite genuinely passes", () => {
    const root = fixture(PASSING);
    const v = verifySuite(CMD, root, root);
    expect(v.status).toBe("passed");
    expect(v.detail).toMatch(/1 passed/);
  });

  // The direction that matters. A verifier that only ever says "passed" is
  // worthless. A model cannot be relied on to produce a wrong fix on demand
  // -- asked to write `a * b`, it refused and fixed the bug correctly -- so
  // the bad fix is injected directly.
  it("reports failed when the fix does not work", () => {
    const root = fixture(BROKEN);
    const v = verifySuite(CMD, root, root);
    expect(v.status).toBe("failed");
    expect(v.detail).toMatch(/1 failed/);
  });

  // Exit code 0 with ZERO tests was the original false-pass trap: running at
  // the wrong directory matched nothing and "succeeded".
  it("reports inconclusive, NOT passed, when the re-run executes no tests", () => {
    const root = fixture(PASSING);
    const v = verifySuite(`${JEST} --rootDir . no-such-test-name`, root, root);
    expect(v.status).toBe("inconclusive");
    expect(v.status).not.toBe("passed");
  });

  it("uses the recorded cwd, not the fallback", () => {
    const root = fixture(PASSING);
    const elsewhere = mkdtempSync(join(tmpdir(), "verify-elsewhere-"));
    // Correct cwd supplied: the suite is found and passes even though the
    // fallback points somewhere with no tests at all.
    expect(verifySuite(CMD, root, elsewhere).status).toBe("passed");
    // No cwd: falls back, finds nothing, and must NOT claim success.
    expect(verifySuite(CMD, undefined, elsewhere).status).toBe("inconclusive");
  });
});
