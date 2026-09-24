import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { BehaviorManifest } from "./schema";
import { validate } from "./compiler";

export interface FixturePresence {
  events: boolean;
  expectedMatches: boolean;
  expectedOutcomes: boolean;
}

export interface DiscoveredBehaviorPackage {
  domain: string;
  behaviorId: string;
  manifestPath: string;
  fixtures: FixturePresence;
  manifest?: BehaviorManifest;
  /** A YAML syntax error (malformed document), distinct from a field-level validation error. */
  parseError?: string;
  /** Field-level validation errors from compiler.ts's validate(), only present when parsing succeeded. */
  validationErrors?: string[];
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((entry) => statSync(join(dir, entry)).isDirectory())
      .sort();
  } catch {
    return [];
  }
}

function loadManifest(manifestPath: string): { manifest?: BehaviorManifest; parseError?: string } {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (error) {
    return { parseError: `unable to read ${manifestPath}: ${(error as Error).message}` };
  }

  try {
    const manifest = yaml.load(raw) as BehaviorManifest;
    return { manifest };
  } catch (error) {
    // Distinct from a field-level validation error (AC-012-2): this is a
    // YAML syntax failure, reported as such rather than mixed in with
    // per-field messages.
    return { parseError: `YAML syntax error in ${manifestPath}: ${(error as Error).message}` };
  }
}

/**
 * Discovers behavior packages under
 * `<rootDir>/packages/<domain>/behaviors/<behavior-id>/`, deterministically
 * (domains and behavior ids both sorted, so the same tree always yields
 * the same order — AC-012-1). Malformed `behavior.yaml` files are
 * reported per-package (parseError or validationErrors) rather than
 * aborting the whole discovery run.
 */
export function discoverBehaviorPackages(rootDir: string): DiscoveredBehaviorPackage[] {
  const packagesDir = join(rootDir, "packages");
  const discovered: DiscoveredBehaviorPackage[] = [];

  for (const domain of listDirs(packagesDir)) {
    const behaviorsDir = join(packagesDir, domain, "behaviors");
    for (const behaviorId of listDirs(behaviorsDir)) {
      const behaviorDir = join(behaviorsDir, behaviorId);
      const manifestPath = join(behaviorDir, "behavior.yaml");
      const fixturesDir = join(behaviorDir, "fixtures");

      const fixtures: FixturePresence = {
        events: dirExists(join(fixturesDir, "events")),
        expectedMatches: dirExists(join(fixturesDir, "expected-matches")),
        expectedOutcomes: dirExists(join(fixturesDir, "expected-outcomes")),
      };

      const { manifest, parseError } = loadManifest(manifestPath);
      const validationErrors = manifest ? validate(manifest).map((e) => e.message) : undefined;

      discovered.push({
        domain,
        behaviorId,
        manifestPath,
        fixtures,
        manifest,
        parseError,
        validationErrors,
      });
    }
  }

  return discovered;
}

function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
