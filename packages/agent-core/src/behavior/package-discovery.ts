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
 * `searchRoots` are resolved relative to `rootDir`. The default covers
 * both supported layouts: `"packages"` for this monorepo and `"."` for
 * `<rootDir>/<domain>/behaviors/<id>/`, the shape a non-monorepo
 * consumer wants.
 *
 * `"."` is in the default deliberately. It does mean every top-level
 * directory is considered a domain, so this is not a pure no-op for
 * existing checkouts; measured against this repo it returns an
 * identical result in ~1ms, and EXCLUDED_DOMAINS keeps dependency and
 * VCS trees out. The alternative -- making portability opt-in -- was
 * rejected because nothing in the product would have passed the opt in,
 * leaving REQ-013 reachable only from unit tests.
 */
export interface DiscoveryOptions {
  searchRoots?: string[];
}


/** Directories never treated as behavior domains (see loop below). */
export const EXCLUDED_DOMAINS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "tmp",
  ".git",
  ".hg",
  ".svn",
  ".beads",
  ".github",
]);
export const DEFAULT_SEARCH_ROOTS = ["packages", "."] as const;

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
      // Never treat a dependency tree or VCS directory as a behavior
      // domain. Without this, a search root of "." would let any
      // `node_modules/behaviors/<id>/behavior.yaml` be discovered,
      // compiled, and loaded with real tool grants -- a dependency
      // could grant itself capabilities simply by shipping a file.
      // Deliberately an explicit list, NOT a blanket dot-prefix rule:
      // `.ensemble/behaviors/` is a legitimate non-monorepo layout.
      if (EXCLUDED_DOMAINS.has(domain)) continue;

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
