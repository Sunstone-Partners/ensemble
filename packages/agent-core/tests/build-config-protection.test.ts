import { classifyPath, isAlwaysProtectedPath, isProtectedPath } from "../src/behavior/protected-paths";

/**
 * br-afik. Four files were edited by fix-agent children during a live run and
 * NONE was caught, because none was a protected path:
 *
 *   packages/pi-extension/jest.config.js   moduleNameMapper -> ../agent-core/src
 *   packages/pi-extension/tsconfig.json    lib ES2022 -> ES2024
 *   packages/pi-extension/package.json     added "pretest": "tsc -p ../agent-core"
 *   packages/pi-extension/tests/zzdebug.test.ts   new scratch test
 *
 * All four are one move: when the real problem is dependency resolution, an
 * agent told "repair the SOURCE so it passes" edits the configuration that
 * decides whether the suite can load. The resulting green run proves the
 * harness changed, not that the code was fixed -- and it reviews as build
 * housekeeping, which is harder to catch than an edited assertion.
 */

describe("build configuration is a protected path (br-afik)", () => {
  const observed = [
    "packages/pi-extension/jest.config.js",
    "packages/pi-extension/tsconfig.json",
    "packages/pi-extension/package.json",
  ];

  it.each(observed)("protects %s, the files actually edited in the live run", (path) => {
    const verdict = classifyPath(path);
    expect(verdict.protected).toBe(true);
    expect(verdict.reason).toBe("build-config");
  });

  it("protects the fourth file too, as a test file", () => {
    // Already covered before this change; asserted so the live incident is
    // fully accounted for rather than partially.
    expect(classifyPath("packages/pi-extension/tests/zzdebug.test.ts").reason).toBe("test-file");
  });

  it.each([
    "tsconfig.build.json",
    "jest.config.mjs",
    "jest.config.json",
    "jest.setup.ts",
    "vitest.config.ts",
    "babel.config.js",
    ".babelrc",
    "pyproject.toml",
    "pytest.ini",
    "setup.cfg",
  ])("covers sibling configuration %s, not just the three observed", (path) => {
    expect(isProtectedPath(path)).toBe(true);
  });

  it("is case-insensitive, so capitalisation is not a bypass", () => {
    // Same argument as the module's normalize(): macOS and Windows resolve
    // these to the same file, so a case-sensitive rule would be trivially
    // evaded by writing TSConfig.json.
    expect(classifyPath("packages/x/TSConfig.json").reason).toBe("build-config");
    expect(classifyPath("Packages/X/Jest.Config.JS").reason).toBe("build-config");
  });

  it("does not protect neighbours that merely look similar", () => {
    // Over-protection has a cost: every false positive is a file the user
    // cannot edit during a fix turn without an approval round-trip.
    for (const path of [
      "package-lock.json",
      "packages/pi-extension/src/package-info.ts",
      "docs/package.json.md",
      "my-pyproject.toml.bak",
    ]) {
      expect(isProtectedPath(path)).toBe(false);
    }
  });

  it("is WINDOWED, not always-protected, like test files", () => {
    // The distinction that matters. package.json and tsconfig.json are
    // ordinary working material; arming them outside a fix turn would revert
    // the maintainer's own dependency bumps -- the br-vjm5 failure of
    // "protection that locks you out of your repository".
    expect(isAlwaysProtectedPath("packages/pi-extension/package.json")).toBe(false);
    expect(isAlwaysProtectedPath("packages/pi-extension/tsconfig.json")).toBe(false);
    expect(isAlwaysProtectedPath("packages/pi-extension/jest.config.js")).toBe(false);

    // Contrast: these are never ordinary working material.
    expect(isAlwaysProtectedPath("docs/standards/constitution.md")).toBe(true);
    expect(isAlwaysProtectedPath("src/behavior/mutation-guard.ts")).toBe(true);
  });

  it("reports build-config for a config sitting under a tests directory", () => {
    // Ordering check: the file is build configuration wherever it lives, and
    // calling it a test file would mis-describe what the agent reached for.
    expect(classifyPath("packages/x/tests/tsconfig.json").reason).toBe("build-config");
  });
});
