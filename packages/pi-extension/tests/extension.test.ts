import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../src/extension";

// AC-004-1 (real activation through Pi's loader with no load-time errors) is
// proved by scripts/smoke-activate.mjs, run as a subprocess: jest (via
// ts-jest, CommonJS target) cannot load @earendil-works/pi-coding-agent
// because it ships ESM-only (no `require` export condition) — even a
// dynamic `import()` gets compiled back to `require` under a CJS jest
// transform. A real Node ESM process sidesteps that resolver limitation
// entirely instead of mocking around it.
describe("pi-extension activation (AC-004-1/AC-004-2)", () => {
  it("throws a documented blocking-gap error instead of degrading silently if registerTool is missing (AC-004-2)", async () => {
    const brokenPi = {
      on: () => undefined,
    } as unknown as Pick<ExtensionAPI, "on"> as ExtensionAPI;
    expect(() => activate(brokenPi)).toThrow(/BLOCKING GAP/);
  });
});
