import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GhCliPrProvider } from "../../src/new-feature/pr-provider";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-pr-provider-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write an executable fake `gh` script and return its path. */
function fakeGh(body: string): string {
  const scriptPath = join(dir, "gh");
  writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe("GhCliPrProvider.isAvailable (TRD-016)", () => {
  it("AC-011-3: an unauthenticated gh (non-zero exit) reports unavailable without throwing", () => {
    const gh = fakeGh(`
      if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
        exit 1
      fi
      exit 0
    `);
    const provider = new GhCliPrProvider(gh);

    expect(() => provider.isAvailable()).not.toThrow();
    expect(provider.isAvailable()).toBe(false);
  });

  it("AC-011-3: a missing gh binary (ENOENT) reports unavailable without throwing", () => {
    const provider = new GhCliPrProvider(join(dir, "does-not-exist-gh"));

    expect(() => provider.isAvailable()).not.toThrow();
    expect(provider.isAvailable()).toBe(false);
  });

  it("gh authenticated (zero exit) reports available", () => {
    const gh = fakeGh(`exit 0`);
    const provider = new GhCliPrProvider(gh);

    expect(provider.isAvailable()).toBe(true);
  });
});

describe("GhCliPrProvider.createPullRequest (TRD-016)", () => {
  it("AC-011-2: constructs the repo/branch/title/body shape as --repo/--head/--title/--body flags on gh pr create (fix-issue.yaml's own PR step relies on cwd git context and only passes --title/--body; this library function also targets an explicit repo/branch, so it adds --repo/--head deliberately)", async () => {
    const argsFile = join(dir, "args.txt");
    const gh = fakeGh(`
      if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
        printf '%s\\n' "$@" > "${argsFile}"
        echo "https://github.com/example/repo/pull/42"
        exit 0
      fi
      exit 1
    `);
    const provider = new GhCliPrProvider(gh);

    const result = await provider.createPullRequest({
      repo: "example/repo",
      branch: "feature/x",
      title: "Add widget",
      body: "Implements the widget.",
    });

    expect(result.url).toBe("https://github.com/example/repo/pull/42");
    const capturedArgs = readFileSync(argsFile, "utf8").trim().split("\n");
    expect(capturedArgs).toEqual([
      "pr",
      "create",
      "--repo",
      "example/repo",
      "--head",
      "feature/x",
      "--title",
      "Add widget",
      "--body",
      "Implements the widget.",
    ]);
  });

  it("throws (never fabricates a URL) when gh pr create exits non-zero", async () => {
    const gh = fakeGh(`echo "boom" 1>&2; exit 1`);
    const provider = new GhCliPrProvider(gh);

    await expect(
      provider.createPullRequest({ repo: "example/repo", branch: "feature/x", title: "t", body: "b" }),
    ).rejects.toThrow(/gh pr create failed/);
  });
});
