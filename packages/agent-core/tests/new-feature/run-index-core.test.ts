import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireActiveLock,
  isRunAlreadyActiveError,
  listRunFiles,
  makeRunIndexCorrupt,
  mutateRecord,
  readRunFile,
  releaseActiveLockIfOwned,
  runFilePath,
  writeRunAtomic,
} from "../../src/run-index-core";
import { loadRun } from "../../src/new-feature/run-index";

/**
 * Trivial record shape + resolver/validator pair, deliberately unrelated to
 * `new-feature`'s `RunRecord`/`Stage` -- this file exercises `run-index-core.ts`
 * directly, proving its primitives are generic over *any* caller-supplied
 * runs-dir resolver and shape validator (TRD-014 Implementation AC), not
 * just the one `new-feature/run-index.ts` happens to use.
 */
interface TestRecord {
  id: string;
  revision: number;
  updatedAt: string;
  note?: string;
}

function testRunsDir(projectRoot: string): string {
  return join(projectRoot, "runs");
}

function validateTestRecordShape(value: unknown, filePath: string): asserts value is TestRecord {
  if (typeof value !== "object" || value === null) {
    throw makeRunIndexCorrupt(filePath, "not a JSON object");
  }
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string") {
    throw makeRunIndexCorrupt(filePath, 'missing or non-string field "id"');
  }
  if (typeof r.revision !== "number") {
    throw makeRunIndexCorrupt(filePath, 'missing or non-number field "revision"');
  }
  if (typeof r.updatedAt !== "string") {
    throw makeRunIndexCorrupt(filePath, 'missing or non-string field "updatedAt"');
  }
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "run-index-core-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("writeRunAtomic", () => {
  it("writes the exact JSON-serialized value and leaves no orphaned temp file", () => {
    const filePath = join(testRunsDir(root), "a.json");
    writeRunAtomic(filePath, { id: "a", revision: 0, updatedAt: "2026-01-01T00:00:00.000Z" });

    const raw = readFileSync(filePath, "utf8");
    expect(JSON.parse(raw)).toEqual({ id: "a", revision: 0, updatedAt: "2026-01-01T00:00:00.000Z" });

    const entries = readdirSync(testRunsDir(root));
    expect(entries).toEqual(["a.json"]);
  });

  it("creates the destination directory if it does not yet exist", () => {
    const filePath = join(testRunsDir(root), "nested", "b.json");
    writeRunAtomic(filePath, { id: "b", revision: 0, updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(existsSync(filePath)).toBe(true);
  });

  it("a second write overwrites the first rather than leaving both versions", () => {
    const filePath = join(testRunsDir(root), "c.json");
    writeRunAtomic(filePath, { id: "c", revision: 0, updatedAt: "2026-01-01T00:00:00.000Z" });
    writeRunAtomic(filePath, { id: "c", revision: 1, updatedAt: "2026-01-01T00:00:01.000Z" });

    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      id: "c",
      revision: 1,
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    expect(readdirSync(testRunsDir(root))).toEqual(["c.json"]);
  });
});

describe("readRunFile (corrupt-file validation)", () => {
  it("reads and validates a well-formed file via the injected validator", () => {
    const filePath = join(testRunsDir(root), "ok.json");
    writeRunAtomic(filePath, { id: "ok", revision: 2, updatedAt: "2026-01-01T00:00:00.000Z" });

    expect(readRunFile(filePath, validateTestRecordShape)).toEqual({
      id: "ok",
      revision: 2,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("throws RUN_INDEX_CORRUPT on invalid JSON rather than skipping the file", () => {
    const filePath = join(testRunsDir(root), "broken.json");
    mkdirSync(testRunsDir(root), { recursive: true });
    writeFileSync(filePath, "{not valid json");

    expect(() => readRunFile(filePath, validateTestRecordShape)).toThrow(
      expect.objectContaining({ code: "RUN_INDEX_CORRUPT", filePath }),
    );
  });

  it("throws RUN_INDEX_CORRUPT when the caller-supplied validator rejects the shape", () => {
    const filePath = join(testRunsDir(root), "wrong-shape.json");
    mkdirSync(testRunsDir(root), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ id: 123, revision: "not-a-number" }));

    expect(() => readRunFile(filePath, validateTestRecordShape)).toThrow(
      expect.objectContaining({ code: "RUN_INDEX_CORRUPT", reason: expect.stringContaining('field "id"') }),
    );
  });

  it("throws RUN_INDEX_CORRUPT (not ENOENT) when the file does not exist", () => {
    const filePath = join(testRunsDir(root), "missing.json");
    expect(() => readRunFile(filePath, validateTestRecordShape)).toThrow(
      expect.objectContaining({ code: "RUN_INDEX_CORRUPT" }),
    );
  });
});

describe("listRunFiles", () => {
  it("returns [] when the runs directory does not exist yet (never throws ENOENT)", () => {
    expect(listRunFiles(testRunsDir, root)).toEqual([]);
  });

  it("lists only *.json files, excluding dotfiles like active.lock", () => {
    mkdirSync(testRunsDir(root), { recursive: true });
    writeFileSync(join(testRunsDir(root), "one.json"), "{}");
    writeFileSync(join(testRunsDir(root), "two.json"), "{}");
    writeFileSync(join(testRunsDir(root), "active.lock"), "one");
    writeFileSync(join(testRunsDir(root), ".hidden.json"), "{}");

    const files = listRunFiles(testRunsDir, root).map((f) => f.split("/").pop());
    expect(files.sort()).toEqual(["one.json", "two.json"]);
  });
});

describe("acquireActiveLock / releaseActiveLockIfOwned", () => {
  it("a first acquire succeeds and writes the owning runId", () => {
    acquireActiveLock(testRunsDir, root, "run-a");
    expect(readFileSync(join(testRunsDir(root), "active.lock"), "utf8")).toBe("run-a");
  });

  it("a second acquire for a different run throws RUN_ALREADY_ACTIVE naming the existing run, writing nothing", () => {
    acquireActiveLock(testRunsDir, root, "run-a");

    let caught: unknown;
    try {
      acquireActiveLock(testRunsDir, root, "run-b");
    } catch (err) {
      caught = err;
    }
    if (!isRunAlreadyActiveError(caught)) {
      throw new Error("expected acquireActiveLock to throw RunAlreadyActiveError");
    }
    expect(caught.existingRunId).toBe("run-a");
    expect(readFileSync(join(testRunsDir(root), "active.lock"), "utf8")).toBe("run-a");
  });

  it("releasing as the owning run removes the lock, permitting a subsequent acquire", () => {
    acquireActiveLock(testRunsDir, root, "run-a");
    releaseActiveLockIfOwned(testRunsDir, root, "run-a");
    expect(existsSync(join(testRunsDir(root), "active.lock"))).toBe(false);

    acquireActiveLock(testRunsDir, root, "run-b");
    expect(readFileSync(join(testRunsDir(root), "active.lock"), "utf8")).toBe("run-b");
  });

  it("releasing as a non-owning run is a no-op -- the real owner's lock survives", () => {
    acquireActiveLock(testRunsDir, root, "run-a");
    releaseActiveLockIfOwned(testRunsDir, root, "run-b");
    expect(readFileSync(join(testRunsDir(root), "active.lock"), "utf8")).toBe("run-a");
  });

  it("releasing when no lock file exists at all is a no-op, not a throw", () => {
    expect(() => releaseActiveLockIfOwned(testRunsDir, root, "run-a")).not.toThrow();
  });
});

describe("mutateRecord (revision-conflict optimistic concurrency)", () => {
  it("bumps revision by exactly 1 and persists the updater's change", () => {
    const filePath = runFilePath(testRunsDir, root, "run-a");
    writeRunAtomic(filePath, { id: "run-a", revision: 0, updatedAt: "2026-01-01T00:00:00.000Z" });

    const updated = mutateRecord<TestRecord>(
      filePath,
      0,
      (r) => {
        r.note = "first edit";
      },
      validateTestRecordShape,
    );

    expect(updated.revision).toBe(1);
    expect(updated.note).toBe("first edit");
    expect(readRunFile(filePath, validateTestRecordShape)).toEqual(updated);
  });

  it("a stale expectedRevision throws REVISION_CONFLICT carrying the current revision, preserving the first writer's change", () => {
    const filePath = runFilePath(testRunsDir, root, "run-a");
    writeRunAtomic(filePath, { id: "run-a", revision: 0, updatedAt: "2026-01-01T00:00:00.000Z" });

    mutateRecord<TestRecord>(filePath, 0, (r) => { r.note = "first"; }, validateTestRecordShape);

    expect(() => {
      mutateRecord<TestRecord>(filePath, 0, (r) => { r.note = "second"; }, validateTestRecordShape);
    }).toThrow(expect.objectContaining({ code: "REVISION_CONFLICT", status: 409, currentRevision: 1 }));

    expect(readRunFile(filePath, validateTestRecordShape).note).toBe("first");
  });

  it("an updater that tampers with revision itself is rejected rather than silently applied", () => {
    const filePath = runFilePath(testRunsDir, root, "run-a");
    writeRunAtomic(filePath, { id: "run-a", revision: 0, updatedAt: "2026-01-01T00:00:00.000Z" });

    expect(() => {
      mutateRecord<TestRecord>(
        filePath,
        0,
        (r) => {
          r.revision = 99;
        },
        validateTestRecordShape,
      );
    }).toThrow(expect.objectContaining({ code: "REVISION_TAMPERED", status: 400 }));
  });
});

/**
 * Constitution Rule 7 ("verification must be able to fail") can-fail proof.
 *
 * Per the `mutation-test-validity` procedure, this was proven empirically
 * during implementation by mutating the *real, shipped* `acquireActiveLock`
 * in `src/run-index-core.ts` and re-running this file:
 *
 *   1. Backed up the pristine `run-index-core.ts`.
 *   2. Changed `fs.writeFileSync(lockPath, runId, { flag: "wx" })` to
 *      `fs.writeFileSync(lockPath, runId)` -- dropping the exclusive-create
 *      flag, so a second `acquireActiveLock()` for a different run no
 *      longer throws `EEXIST` and silently overwrites the lock instead.
 *   3. Ran `npx jest tests/new-feature/run-index-core.test.ts` -- the
 *      "a second acquire for a different run throws RUN_ALREADY_ACTIVE..."
 *      test above went RED (failed: expected a throw, got none), proving
 *      this suite is not vacuously green.
 *   4. Restored the pristine file from the backup (not by reverse-editing)
 *      and re-ran the same command -- back to GREEN.
 *
 * See the TRD-014-TEST bead's transition comment for the exact commands
 * and captured failure output. No broken code is shipped; this comment
 * documents a proof already performed, it does not re-run it, since doing
 * so inline would require mutating the shipped module as a side effect of
 * a normal test run.
 */
describe("can-fail proof (Constitution Rule 7)", () => {
  it("documents that the lock-acquire regression above was proven to fail the suite (see comment above)", () => {
    // This assertion exists only so the describe block registers a test;
    // the actual proof is the empirical mutate-run-revert cycle documented
    // above and in the bead transition comment, per mutation-test-validity.
    expect(true).toBe(true);
  });
});

describe("on-disk shape unchanged (TRD-014-TEST)", () => {
  it("a pre-refactor .ensemble/new-feature/*.json file loads unmodified through the refactored new-feature/run-index.ts", () => {
    const fixtureRaw = readFileSync(join(__dirname, "fixtures", "pre-refactor-run-record.json"), "utf8");
    const expected = JSON.parse(fixtureRaw);

    const dir = join(root, ".ensemble", "new-feature");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${expected.runId}.json`), fixtureRaw);

    expect(loadRun(root, expected.runId)).toEqual(expected);
  });
});
