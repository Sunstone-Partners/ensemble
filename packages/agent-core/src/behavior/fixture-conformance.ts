import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { normalizeEvent, RawEventInput } from "../normalize";
import { match } from "./discovery";
import { BehaviorPackage } from "./schema";

export interface FixtureConformanceResult {
  eventFile: string;
  matchesEqual: boolean;
  outcomesEqual: boolean;
  actualMatches: string[];
  expectedMatches: string[];
  actualOutcomes: string[];
  expectedOutcomes: string[];
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
    const event = normalizeEvent(rawEvent);

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
    };
  });
}
