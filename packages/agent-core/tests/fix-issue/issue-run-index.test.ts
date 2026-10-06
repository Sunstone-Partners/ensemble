/**
 * Unit tests for `issue-run-index.ts` (TRD-015, TRD-015-TEST).
 * (docs/TRD/TRD-2026-87e64cc6-command-surface-consolidation.md#trd-015,
 * #trd-015-test)
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRun as createFeatureRun, findActive as findActiveFeature } from "../../src/new-feature/run-index";
import { abandon, complete, createRun, findActive, mutate } from "../../src/fix-issue/issue-run-index";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ensemble-issue-run-index-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function issueRunsDir(projectRoot: string): string {
  return join(projectRoot, ".ensemble", "fix-issue");
}

function featureRunsDir(projectRoot: string): string {
  return join(projectRoot, ".ensemble", "new-feature");
}

describe("AC-019-1: createRun/mutate/findActive/abandon round-trip", () => {
  it("persists and reloads state correctly across each operation in sequence", () => {
    const created = createRun(root, "login button does nothing on mobile Safari");
    expect(created.stage).toBe("analysis_planning");
    expect(created.status).toBe("active");
    expect(created.revision).toBe(0);

    const mutated = mutate(root, created.runId, created.revision, (r) => {
      r.stage = "execution";
      r.beadRefs.push("br-abc1");
    });
    expect(mutated.stage).toBe("execution");
    expect(mutated.revision).toBe(1);

    const found = findActive(root);
    expect(found?.runId).toBe(created.runId);
    expect(found?.stage).toBe("execution");
    expect(found?.beadRefs).toEqual(["br-abc1"]);

    const abandoned = abandon(root, created.runId, "superseded by a different fix");
    expect(abandoned.status).toBe("abandoned");
    expect(findActive(root)).toBeUndefined();
  });

  it("complete() also terminalizes the run and releases active.lock for a subsequent createRun()", () => {
    const run = createRun(root, "an issue");
    const completed = complete(root, run.runId);
    expect(completed.status).toBe("completed");
    expect(findActive(root)).toBeUndefined();

    // active.lock released -- a new run can start without RUN_ALREADY_ACTIVE.
    const next = createRun(root, "a different issue");
    expect(next.runId).not.toBe(run.runId);
  });
});

describe("AC-019-1: independent exclusivity from the feature store", () => {
  it("a feature run and an issue run may both be active simultaneously (no shared lock)", () => {
    const featureRun = createFeatureRun(root, "a feature idea");
    const issueRun = createRun(root, "an unrelated bug report");

    expect(featureRun.runId).not.toBe(issueRun.runId);
    expect(findActive(root)?.runId).toBe(issueRun.runId);

    // Each store's own active.lock lives in its own runs directory.
    expect(issueRunsDir(root)).not.toBe(featureRunsDir(root));
  });
});

describe("AC-019-2/AC-005-3 equivalent: corrupt file fails loud", () => {
  it("throws RUN_INDEX_CORRUPT on a truncated run file rather than guessing", () => {
    mkdirSync(issueRunsDir(root), { recursive: true });
    writeFileSync(join(issueRunsDir(root), "broken.json"), "{not valid json");

    expect(() => findActive(root)).toThrow(expect.objectContaining({ code: "RUN_INDEX_CORRUPT" }));
  });

  it("throws RUN_INDEX_CORRUPT on a run file with a non-enum stage", () => {
    mkdirSync(issueRunsDir(root), { recursive: true });
    writeFileSync(
      join(issueRunsDir(root), "bad-stage.json"),
      JSON.stringify({
        runId: "bad-stage",
        projectRoot: root,
        issueDescription: "an issue",
        status: "active",
        stage: "not_a_real_stage",
        stageOutcome: { kind: "approval_wait", recordedAt: new Date().toISOString() },
        artifacts: [],
        beadRefs: [],
        prApprovedAt: null,
        revision: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    expect(() => findActive(root)).toThrow(expect.objectContaining({ code: "RUN_INDEX_CORRUPT" }));
  });
});

describe("REQ-002: issue run creates no feature run record", () => {
  it("createRun() writes only to .ensemble/fix-issue, never to .ensemble/new-feature", () => {
    createRun(root, "an issue");

    expect(existsSync(featureRunsDir(root))).toBe(false);
    expect(readdirSync(issueRunsDir(root)).some((f: string) => f.endsWith(".json"))).toBe(true);

    // The feature store (queried independently) has nothing active either.
    expect(findActiveFeature(root)).toBeUndefined();
  });
});
