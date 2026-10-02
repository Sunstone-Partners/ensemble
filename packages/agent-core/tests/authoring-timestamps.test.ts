import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { discoverBehaviorPackages, DiscoveredBehaviorPackage } from "../src/behavior/package-discovery";
import { runFixtureConformance, fixtureConformancePassed } from "../src/behavior/fixture-conformance";
import { AUTHORING_STATE_PATH, AuthoringRecord, readAuthoringRecords } from "../src/behavior/authoring-record";
import { BehaviorManifest } from "../src/behavior/schema";

/** The on-disk shape the data model specifies, read raw rather than through the module under test. */
interface AuthoringFile {
  schema_version: string;
  entries: AuthoringRecord[];
}

/**
 * TRD-023 / REQ-029 (AC-029-1): when a behavior package is first discovered,
 * and when its fixture conformance first passes, are both recorded in the
 * checkout (`.ensemble/state/authoring.json`) -- so authoring turnaround is
 * observable without anyone instrumenting their own workflow by hand.
 */

const T0 = new Date("2026-10-02T10:00:00.000Z");
const T1 = new Date("2026-10-02T11:30:00.000Z");
const T2 = new Date("2026-10-02T13:45:00.000Z");
const at = (date: Date) => () => date;

function manifest(name: string): BehaviorManifest {
  return {
    api_version: "ensemble.sunstone.dev/v1",
    kind: "Behavior",
    metadata: { name, version: "1.0.0" },
    trigger: { event_type: "test.failure.observed", predicate: { command: { matches: "pytest" } } },
    policy: { mode: "propose", timeout: "30m" },
    capabilities: { tools: ["read"], mutation_classes: [] },
    execution: { graph: name },
    outcomes: [`${name}.done`],
  };
}

describe("authoring timestamps (TRD-023 / AC-029-1)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ensemble-authoring-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const statePath = () => join(root, AUTHORING_STATE_PATH);
  const stateText = () => readFileSync(statePath(), "utf8");
  function readState(): AuthoringFile {
    const state: AuthoringFile = JSON.parse(stateText());
    return state;
  }
  const entryFor = (id: string) => readState().entries.find((e) => e.package === id);

  function makePackage(id: string): string {
    const dir = join(root, "packages", "alpha", "behaviors", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "behavior.yaml"), yaml.dump(manifest(id)));
    return dir;
  }

  /** One fixture whose expectations either agree with what the package produces or do not. */
  function setFixtures(dir: string, id: string, agree: boolean, payload: Record<string, unknown> = {}): void {
    const fixtures = join(dir, "fixtures");
    for (const sub of ["events", "expected-matches", "expected-outcomes"]) mkdirSync(join(fixtures, sub), { recursive: true });
    writeFileSync(
      join(fixtures, "events", "pytest-failed.json"),
      JSON.stringify({
        type: "test.failure.observed",
        source: "fixture",
        payload: { command: "pytest -q", isError: true, ...payload },
      }),
    );
    writeFileSync(join(fixtures, "expected-matches", "pytest-failed.json"), JSON.stringify(agree ? [id] : ["someone-else"]));
    writeFileSync(join(fixtures, "expected-outcomes", "pytest-failed.json"), JSON.stringify(agree ? [`${id}.done`] : []));
  }

  const discover = (now: Date, onDiagnostic?: (message: string) => void) =>
    discoverBehaviorPackages(root, { authoring: { now: at(now), onDiagnostic } });

  const conform = (dir: string, id: string, now: Date, onDiagnostic?: (message: string) => void) =>
    runFixtureConformance(dir, { behaviors: [manifest(id)] }, {
      authoring: { rootDir: root, now: at(now), onDiagnostic },
    });

  it("Scenario: first discovery sets the start -- authoring.json has its start time", () => {
    makePackage("triage");
    expect(existsSync(statePath())).toBe(false);

    discover(T0);

    expect(readState()).toEqual({
      schema_version: "1.0.0",
      entries: [{ package: "triage", startedAt: T0.toISOString(), completedAt: null }],
    });
  });

  it("records the start once: a later discovery never overwrites it", () => {
    makePackage("triage");
    discover(T0);
    discover(T1);

    expect(entryFor("triage")).toEqual({ package: "triage", startedAt: T0.toISOString(), completedAt: null });
    expect(readState().entries).toHaveLength(1);
  });

  it("a package added later gets its own start without moving an earlier one", () => {
    makePackage("first");
    discover(T0);
    makePackage("second");
    discover(T1);

    expect(entryFor("first")).toMatchObject({ startedAt: T0.toISOString() });
    expect(entryFor("second")).toMatchObject({ startedAt: T1.toISOString() });
  });

  it("authoring starts before the manifest is valid: a package that does not yet parse is still recorded", () => {
    const dir = join(root, "packages", "alpha", "behaviors", "half-written");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "behavior.yaml"), "metadata: [unclosed\n");

    const [found] = discover(T0);

    expect(found.parseError).toMatch(/YAML syntax error/);
    expect(entryFor("half-written")).toEqual({ package: "half-written", startedAt: T0.toISOString(), completedAt: null });
  });

  it("Scenario: the first passing conformance sets completion", () => {
    const dir = makePackage("triage");
    setFixtures(dir, "triage", true);
    discover(T0);

    const results = conform(dir, "triage", T1);

    expect(fixtureConformancePassed(results)).toBe(true);
    expect(entryFor("triage")).toEqual({ package: "triage", startedAt: T0.toISOString(), completedAt: T1.toISOString() });
  });

  it("a failing conformance run records nothing", () => {
    const dir = makePackage("triage");
    setFixtures(dir, "triage", false);
    discover(T0);
    const before = stateText();

    const results = conform(dir, "triage", T1);

    expect(results[0].matchesEqual).toBe(false);
    expect(fixtureConformancePassed(results)).toBe(false);
    expect(stateText()).toBe(before);
  });

  it("an unconstructible fixture fails the run even when its matches agree, so it records nothing", () => {
    const dir = makePackage("triage");
    // exit_code is a field no translator can emit (TRD-007): agreeing
    // expectations over it prove nothing about the real runtime.
    setFixtures(dir, "triage", true, { exit_code: 1 });
    discover(T0);
    const before = stateText();

    const results = conform(dir, "triage", T1);

    expect(results[0].matchesEqual).toBe(true);
    expect(results[0].constructibility?.unconstructibleFields).toEqual(["exit_code"]);
    expect(fixtureConformancePassed(results)).toBe(false);
    expect(stateText()).toBe(before);
  });

  it("a run with no fixtures checked nothing, so it is not a pass", () => {
    const dir = makePackage("triage");
    discover(T0);
    const before = stateText();

    const results = conform(dir, "triage", T1);

    expect(results).toEqual([]);
    expect(fixtureConformancePassed(results)).toBe(false);
    expect(stateText()).toBe(before);
  });

  it("Scenario: re-discovery and failures change nothing -- neither timestamp moves", () => {
    const dir = makePackage("triage");
    setFixtures(dir, "triage", true);
    discover(T0);
    conform(dir, "triage", T1);

    setFixtures(dir, "triage", false);
    discover(T2);
    const failed = conform(dir, "triage", T2);
    expect(fixtureConformancePassed(failed)).toBe(false);
    expect(entryFor("triage")).toEqual({ package: "triage", startedAt: T0.toISOString(), completedAt: T1.toISOString() });

    // Completion is the FIRST passing run: passing again later moves nothing.
    setFixtures(dir, "triage", true);
    const passedAgain = conform(dir, "triage", T2);
    expect(fixtureConformancePassed(passedAgain)).toBe(true);
    expect(entryFor("triage")).toEqual({ package: "triage", startedAt: T0.toISOString(), completedAt: T1.toISOString() });
  });

  it("a pass with no recorded start is not recorded as a completion, and says why", () => {
    const dir = makePackage("triage");
    setFixtures(dir, "triage", true);
    const diagnostics: string[] = [];

    const results = conform(dir, "triage", T1, (message) => diagnostics.push(message));

    expect(fixtureConformancePassed(results)).toBe(true);
    expect(existsSync(statePath())).toBe(false);
    expect(diagnostics).toEqual([expect.stringMatching(/no authoring start is recorded for "triage"/)]);
  });

  it("a malformed record disables the metric: discovery still succeeds, the file is untouched, and the diagnostic is named", () => {
    makePackage("triage");
    mkdirSync(join(root, ".ensemble", "state"), { recursive: true });
    writeFileSync(statePath(), "{not json");
    const diagnostics: string[] = [];

    let found: DiscoveredBehaviorPackage[] = [];
    expect(() => {
      found = discover(T0, (message) => diagnostics.push(message));
    }).not.toThrow();

    expect(found.map((f) => f.behaviorId)).toEqual(["triage"]);
    expect(stateText()).toBe("{not json");
    expect(diagnostics).toEqual([expect.stringMatching(/authoring\.json is malformed JSON/)]);
  });

  it("an unknown schema_version is a named diagnostic, and neither writer touches the file", () => {
    const dir = makePackage("triage");
    setFixtures(dir, "triage", true);
    mkdirSync(join(root, ".ensemble", "state"), { recursive: true });
    const future = JSON.stringify({ schema_version: "9.0.0", entries: [] });
    writeFileSync(statePath(), future);
    const diagnostics: string[] = [];

    discover(T0, (message) => diagnostics.push(message));
    conform(dir, "triage", T1, (message) => diagnostics.push(message));

    expect(stateText()).toBe(future);
    expect(readAuthoringRecords(root)).toEqual({ ok: false, diagnostic: expect.stringMatching(/schema_version "9.0.0"/) });
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every((d) => /schema_version "9.0.0"/.test(d))).toBe(true);
  });

  it("a missing file means no records, not an error", () => {
    expect(readAuthoringRecords(root)).toEqual({ ok: true, entries: [] });
  });

  it("a timestamp that is not ISO-8601 UTC makes the record malformed, even when Date.parse accepts it", () => {
    mkdirSync(join(root, ".ensemble", "state"), { recursive: true });
    writeFileSync(
      statePath(),
      JSON.stringify({ schema_version: "1.0.0", entries: [{ package: "triage", startedAt: "Oct 2, 2026", completedAt: null }] }),
    );

    expect(Number.isNaN(Date.parse("Oct 2, 2026"))).toBe(false);
    expect(readAuthoringRecords(root)).toEqual({
      ok: false,
      diagnostic: expect.stringMatching(/authoring\.json has an invalid entry at index 0/),
    });
  });

  it("the default clock writes ISO-8601 UTC", () => {
    makePackage("triage");
    const before = Date.now();

    discoverBehaviorPackages(root, { authoring: {} });

    const startedAt = entryFor("triage")?.startedAt ?? "";
    expect(startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(startedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(startedAt)).toBeLessThanOrEqual(Date.now());
  });

  it("is opt-in: without the option neither discovery nor conformance writes any state", () => {
    // Tests and CLIs discover this very checkout; a library default that wrote
    // state would dirty it on every run.
    const dir = makePackage("triage");
    setFixtures(dir, "triage", true);

    discoverBehaviorPackages(root);
    const results = runFixtureConformance(dir, { behaviors: [manifest("triage")] });

    expect(fixtureConformancePassed(results)).toBe(true);
    expect(existsSync(join(root, ".ensemble"))).toBe(false);
  });

  it("writes nothing when discovery finds no packages", () => {
    discover(T0);
    expect(existsSync(join(root, ".ensemble"))).toBe(false);
  });
});
