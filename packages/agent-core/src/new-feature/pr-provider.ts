/**
 * Provider-neutral PR-creation seam (REQ-011). See
 * docs/TRD/TRD-2026-d6bbf322-new-feature-workflow.md (TRD-016, TRD-017)
 * for the authoritative behavior this file implements.
 */

import { spawnSync } from "node:child_process";

/** Shape needed to open one pull request. */
export interface PrProviderParams {
  repo: string;
  branch: string;
  title: string;
  body: string;
}

/**
 * Provider-neutral PR-creation seam. `isAvailable()` must probe cleanly
 * (never throw) so the caller can skip PR creation entirely when no
 * supported provider is usable; `createPullRequest()` is never the first
 * point of failure for "is this even possible" (AC-011-3).
 */
export interface PrProvider {
  isAvailable(): boolean;
  createPullRequest(params: PrProviderParams): Promise<{ url: string }>;
}

/**
 * gh-CLI-backed `PrProvider`, reusing fix-issue.yaml's existing `gh pr
 * create --title ... --body ...` invocation shape (same target
 * repo/branch/title/body construction) rather than a new integration.
 *
 * `ghBinary` is injectable (defaults to "gh" resolved from PATH) so tests
 * can point it at a fake script instead of mocking `node:child_process` --
 * matching this package's existing convention of exercising real
 * subprocess invocations against fixtures rather than module mocks.
 */
export class GhCliPrProvider implements PrProvider {
  constructor(private readonly ghBinary: string = "gh") {}

  /**
   * Probes `gh auth status`. A missing `gh` binary (ENOENT) or a
   * non-zero exit (installed but unauthenticated) both report
   * unavailable; neither throws.
   */
  isAvailable(): boolean {
    const result = spawnSync(this.ghBinary, ["auth", "status"], { stdio: "ignore" });
    if (result.error) return false;
    return result.status === 0;
  }

  /**
   * Constructs the same title/body-assembly shape fix-issue.yaml's PR
   * step already uses, via `gh pr create`. Deliberately adds explicit
   * `--repo`/`--head` flags fix-issue.yaml's own step does not pass
   * (that step relies on `gh` inferring the target from the current
   * working directory's git context) -- this is a reusable library
   * function, not tied to "current cwd branch," so `repo`/`branch` are
   * real parameters, not decorative ones. Throws (does not silently
   * return a fabricated URL) on a non-zero exit or spawn failure -- the
   * caller is responsible for calling `isAvailable()` first so this is
   * never the first point of failure (AC-011-3).
   */
  async createPullRequest(params: PrProviderParams): Promise<{ url: string }> {
    const result = spawnSync(
      this.ghBinary,
      ["pr", "create", "--repo", params.repo, "--head", params.branch, "--title", params.title, "--body", params.body],
      { encoding: "utf8" },
    );
    if (result.error) {
      throw new Error(`gh pr create failed to spawn: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`gh pr create failed (exit ${result.status}): ${result.stderr || result.stdout}`);
    }
    const url = result.stdout.trim().split("\n").pop() ?? "";
    return { url };
  }
}
