import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { normalizeEvent, RawEventInput } from "../normalize";
import { match } from "./discovery";
import { BehaviorPackage } from "./schema";

/**
 * Payload fields the runtime is actually capable of emitting, per
 * event type (TRD-007).
 *
 * This exists because the shipped `investigate-test-failure` fixtures
 * passed conformance while asserting on `exit_code` — a field no
 * translator can ever produce, because Pi's extension API exposes only
 * a boolean `isError` and no numeric exit code anywhere. The fixtures
 * were hand-authored to contain it, so the suite validated the system
 * against events the system is structurally incapable of emitting.
 *
 * A fixture referencing a field absent from this map is not a failing
 * test of real behavior — it is a test of fiction, and it now fails.
 */
export const EMITTABLE_PAYLOAD_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "runtime.tool_call.started": ["toolCallId", "toolName", "custom"],
  "runtime.tool_call.completed": ["toolCallId", "toolName", "custom", "isError", "command"],
  "runtime.prompt.submitted": ["prompt"],
  "test.failure.observed": ["command", "isError", "toolName", "toolCallId"],
};

export interface FixtureConstructibilityIssue {
  eventFile: string;
  eventType: string;
  unconstructibleFields: string[];
  reason: string;
}

export interface FixtureConformanceResult {
  eventFile: string;
  matchesEqual: boolean;
  outcomesEqual: boolean;
  actualMatches: string[];
  expectedMatches: string[];
  actualOutcomes: string[];
  expectedOutcomes: string[];
  /** TRD-007/AC-010-2: empty when every fixture field is emittable. */
  constructibility: FixtureConstructibilityIssue | null;
}

/**
 * AC-010-2: every fixture event must be constructible by the runtime
 * from a real native payload. Returns null when the fixture is
 * constructible, or an issue naming the offending field(s).
 */
export function checkFixtureConstructibility(
  eventFile: string,
  raw: RawEventInput,
): FixtureConstructibilityIssue | null {
  const emittable = EMITTABLE_PAYLOAD_FIELDS[raw.type];
  if (!emittable) {
    return {
      eventFile,
      eventType: raw.type,
      unconstructibleFields: [],
      reason:
        `no translator declares emittable payload fields for event type "${raw.type}", ` +
        `so no fixture of this type can be produced by the runtime`,
    };
  }
  const allowed = new Set(emittable);
  const offending = Object.keys(raw.payload ?? {}).filter((field) => !allowed.has(field));
  if (offending.length === 0) return null;
  return {
    eventFile,
    eventType: raw.type,
    unconstructibleFields: offending,
    reason:
      `fixture payload declares field(s) [${offending.join(", ")}] that no translator can emit ` +
      `for "${raw.type}" (emittable: [${emittable.join(", ")}])`,
  };
}

function listJsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((entry) => extname(entry) === ".json")
      .sort();
  } catch {
    return [];
  }
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Runs conformance for one behavior package's on-disk fixtures
 * (`fixtures/events/*.json`, `fixtures/expected-matches/*.json`,
 * `fixtures/expected-outcomes/*.json`, matched by filename), comparing
 * the produced matches/outcomes against the expected fixtures
 * structurally (AC-013-1).
 */
export function runFixtureConformance(behaviorDir: string, pkg: BehaviorPackage): FixtureConformanceResult[] {
  const fixturesDir = join(behaviorDir, "fixtures");
  const eventsDir = join(fixturesDir, "events");
  const expectedMatchesDir = join(fixturesDir, "expected-matches");
  const expectedOutcomesDir = join(fixturesDir, "expected-outcomes");

  return listJsonFiles(eventsDir).map((eventFile) => {
    const stem = basename(eventFile, ".json");
    const rawEvent = readJson<RawEventInput>(join(eventsDir, eventFile), {
      type: "unknown",
      source: "fixture",
    });
    const constructibility = checkFixtureConstructibility(eventFile, rawEvent);

    // normalizeEvent throws on an uncatalogued type (TRD-001). A
    // fixture still referencing a pre-rename type must fail as one
    // reported fixture, not crash the entire conformance run and
    // obscure every other result.
    let event;
    try {
      event = normalizeEvent(rawEvent);
    } catch (error) {
      return {
        eventFile,
        matchesEqual: false,
        outcomesEqual: false,
        actualMatches: [],
        expectedMatches: readJson<string[]>(join(expectedMatchesDir, `${stem}.json`), []).slice().sort(),
        actualOutcomes: [],
        expectedOutcomes: readJson<string[]>(join(expectedOutcomesDir, `${stem}.json`), []).slice().sort(),
        constructibility:
          constructibility ?? {
            eventFile,
            eventType: rawEvent.type,
            unconstructibleFields: [],
            reason: (error as Error).message,
          },
      };
    }

    const matched = match(pkg, event);
    const actualMatches = matched.map((b) => b.metadata.name).sort();
    const actualOutcomes = Array.from(new Set(matched.flatMap((b) => b.outcomes))).sort();

    const expectedMatches = readJson<string[]>(join(expectedMatchesDir, `${stem}.json`), []).slice().sort();
    const expectedOutcomes = readJson<string[]>(join(expectedOutcomesDir, `${stem}.json`), []).slice().sort();

    return {
      eventFile,
      matchesEqual: JSON.stringify(actualMatches) === JSON.stringify(expectedMatches),
      outcomesEqual: JSON.stringify(actualOutcomes) === JSON.stringify(expectedOutcomes),
      actualMatches,
      expectedMatches,
      actualOutcomes,
      expectedOutcomes,
      constructibility,
    };
  });
}
