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
 * Where to look for behavior packages.
 *
 * `discoverBehaviorPackages` previously hardcoded
 * `join(rootDir, "packages")`, so a repository without a `packages/`
 * directory could never discover a behavior at all — the package was
 * structurally unusable outside this monorepo despite being published
 * as a reusable library (TRD-008 / REQ-013).
 *
 * `searchRoots` are resolved relative to `rootDir`. The default
 * preserves today's monorepo layout exactly, so existing checkouts see
 * no change. `"."` makes `<rootDir>/<domain>/behaviors/<id>/` work,
 * which is the shape a non-monorepo consumer wants.
 */
export interface DiscoveryOptions {
  searchRoots?: string[];
}

export const DEFAULT_SEARCH_ROOTS = ["packages"] as const;

export function discoverBehaviorPackages(
  rootDir: string,
  options: DiscoveryOptions = {},
): DiscoveredBehaviorPackage[] {
  const searchRoots = options.searchRoots ?? [...DEFAULT_SEARCH_ROOTS];
  const discovered: DiscoveredBehaviorPackage[] = [];
  const seen = new Set<string>();

  for (const searchRoot of searchRoots) {
    const packagesDir = searchRoot === "." ? rootDir : join(rootDir, searchRoot);

    for (const domain of listDirs(packagesDir)) {
      const behaviorsDir = join(packagesDir, domain, "behaviors");
      for (const behaviorId of listDirs(behaviorsDir)) {
        const behaviorDir = join(behaviorsDir, behaviorId);
        const manifestPath = join(behaviorDir, "behavior.yaml");
        const fixturesDir = join(behaviorDir, "fixtures");

        // Overlapping search roots must not yield the same package twice.
        if (seen.has(manifestPath)) continue;
        seen.add(manifestPath);

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
