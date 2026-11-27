'use strict';
/**
 * "Default-only" adapter invariant check (TRD-2026-8d825f54 TRD-046).
 *
 * Ten of the fourteen toolchain categories (`worktree`, `ci-local`, `review`, `lint`,
 * `test-runner`, `e2e-quality`, `container-deploy`, `iac`, `platform-cloud`, `package-runner`)
 * were shipped by TRD-042/043/044 with exactly one real adapter each and no detection signal
 * of their own (each one's `adapter.yaml` declares `detect: []`, per TRD interpretation I2):
 * there is deliberately no choice to make for any of them yet, only a shipped default. The
 * remaining four categories are explicitly NOT part of this invariant and are never checked
 * here:
 *   - `host` and `tracker` support several real, independently shipped adapters by design
 *     (`github`/`azure-devops`; `beads`/`jira`/`azure-boards`) and are excluded entirely.
 *   - `workflow` keeps its `plain-git`+`git-town` pair (TRD interpretation I1).
 *   - `work-graph` keeps its `auto`-sentinel/builtin-fallback shape (TRD interpretation I7) and
 *     has no `adapter-work-graph-*` directory of its own to discover at all.
 *
 * `checkDefaultOnly(categoriesDir, packagesDir)` enumerates every real adapter directory under
 * `packagesDir` (`<pkg>/skills/adapter-*`, generated/vendor package trees excluded -- see
 * `EXCLUDED_PACKAGES` below, the same "real source packages only" convention
 * `scripts/validate-all.js#validateFullSkillsMirror`/`validateCapabilityIds`/`validateStepKeys`
 * already use for their own `pkg === 'pi' || ...` skip lists, reused here rather than
 * reinvented), groups them by the categories each one's own `adapter.yaml` `categories[]`
 * field declares (an adapter directory's NAME is never trusted for this -- one manifest's
 * declared `adapter` id and `categories` are what matter, matching
 * `packages/development/lib/toolchain/adapters.js#discoverAdapters`'s own convention), and
 * fails, per restricted category, when:
 *   - its category contract file (`packages/development/toolchain/categories/<cat>.yaml`) is
 *     missing, or
 *   - zero adapters declare that category, or
 *   - two or more adapters declare that category (naming every one found).
 *
 * This module is dependency-free CJS (only `fs`/`path`/`js-yaml`) matching
 * `scripts/lib/capability-ids-check.js`'s own module shape, and returns the same `{ok, errors}`
 * envelope `packages/development/lib/toolchain/validate.js#validateAdapterDir` uses elsewhere
 * in this toolchain for a composed static gate, rather than the bare failure-message array
 * `capability-ids-check.js`'s own functions return -- this check has a single pass/fail
 * verdict for `npm run validate` to act on (unlike `capability-ids-check.js`, which is always
 * called alongside a running per-file `checked` counter by its own caller), so the `{ok,
 * errors}` shape matching `validateAdapterDir`'s convention fits better than inventing a third
 * shape.
 *
 * No `console.log` inside the check functions themselves: `scripts/validate-all.js`'s own
 * `validateDefaultOnly()` wiring (matching `validateCapabilityIds`'s wiring there) owns all
 * terminal output, exactly as `capability-ids-check.js`'s exported functions do today.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * The ten toolchain categories this invariant applies to. See the module doc above for why
 * `host`, `tracker`, `workflow` and `work-graph` are excluded.
 */
const RESTRICTED_CATEGORIES = [
  'worktree',
  'ci-local',
  'review',
  'lint',
  'test-runner',
  'e2e-quality',
  'container-deploy',
  'iac',
  'platform-cloud',
  'package-runner'
];

/**
 * Package directories excluded from "real source packages" scanning: generated/vendor trees
 * that mirror or re-export a source package's own adapters rather than shipping a second,
 * independent one (`packages/full`'s whole-dir symlink mirrors; `packages/pi`'s bundled npm
 * package copy; `packages/codex`/`packages/opencode`'s per-tool bundles). Matches
 * `scripts/validate-all.js`'s own `pkg === 'pi' || pkg === 'codex' || pkg === 'opencode'`
 * convention (`validateStepKeys`/`validateCapabilityIds`/`validateCapabilityInvocationDrift`)
 * plus `validateFullSkillsMirror`'s additional `pkg !== 'full'`, unioned into one set here
 * since this check (unlike those) has no reason to ever walk any of the four.
 */
const EXCLUDED_PACKAGES = new Set(['pi', 'codex', 'full', 'opencode', 'skills']);

/**
 * Every adapter directory shipped by a real source package: `<packagesDir>/<pkg>/skills/
 * adapter-*`, `EXCLUDED_PACKAGES` and any non-directory `<pkg>` or `dist` entry skipped. A
 * candidate directory whose `adapter.yaml` is missing, unreadable, invalid YAML, not an
 * object, or lacks a string `adapter` id or a `categories` array is silently skipped -- the
 * same "skip, never throw" posture `packages/development/lib/toolchain/adapters.js
 * #discoverAdapters` uses for a bad manifest (a malformed manifest is a `validateManifest`
 * schema-validation failure elsewhere, not this check's concern).
 *
 * @param {string} packagesDir Absolute path to the repo's `packages/` directory
 * @returns {Array<{name: string, categories: string[], dir: string}>}
 */
function discoverShippedAdapters(packagesDir) {
  const found = [];
  let packageEntries;
  try {
    packageEntries = fs.readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const pkgEntry of packageEntries) {
    if (!pkgEntry.isDirectory()) continue;
    if (pkgEntry.name === 'dist' || EXCLUDED_PACKAGES.has(pkgEntry.name)) continue;

    const skillsDir = path.join(packagesDir, pkgEntry.name, 'skills');
    let skillEntries;
    try {
      skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const skillEntry of skillEntries) {
      if (!skillEntry.name.startsWith('adapter-')) continue;
      const dir = path.join(skillsDir, skillEntry.name);
      let stat;
      try {
        stat = fs.statSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      let manifest;
      try {
        manifest = yaml.load(fs.readFileSync(path.join(dir, 'adapter.yaml'), 'utf8'));
      } catch {
        continue;
      }
      if (!manifest || typeof manifest.adapter !== 'string' || !Array.isArray(manifest.categories)) {
        continue;
      }
      found.push({ name: manifest.adapter, categories: manifest.categories, dir });
    }
  }

  return found;
}

/**
 * `discoverShippedAdapters`'s results grouped by the `RESTRICTED_CATEGORIES` each one
 * declares. An adapter declaring a category this module does not restrict (`host`, `tracker`,
 * `workflow`, `work-graph`, or any future category) is simply absent from every key here --
 * never an error.
 *
 * @param {string} packagesDir Absolute path to the repo's `packages/` directory
 * @returns {Record<string, Array<{name: string, dir: string}>>} keyed by every entry of
 *   `RESTRICTED_CATEGORIES`, each value sorted by adapter name
 */
function groupShippedAdaptersByCategory(packagesDir) {
  /** @type {Record<string, Array<{name: string, dir: string}>>} */
  const byCategory = {};
  for (const category of RESTRICTED_CATEGORIES) {
    byCategory[category] = [];
  }

  for (const adapter of discoverShippedAdapters(packagesDir)) {
    for (const category of adapter.categories) {
      if (byCategory[category]) {
        byCategory[category].push({ name: adapter.name, dir: adapter.dir });
      }
    }
  }

  for (const category of RESTRICTED_CATEGORIES) {
    byCategory[category].sort((a, b) => a.name.localeCompare(b.name));
  }

  return byCategory;
}

/**
 * The default-only invariant itself: every `RESTRICTED_CATEGORIES` entry must have exactly one
 * shipped adapter (`groupShippedAdaptersByCategory`) and its own category contract file under
 * `categoriesDir`.
 *
 * @param {string} categoriesDir Absolute path to packages/development/toolchain/categories
 * @param {string} packagesDir Absolute path to the repo's packages/ directory
 * @returns {{ok: boolean, errors: string[]}}
 */
function checkDefaultOnly(categoriesDir, packagesDir) {
  const errors = [];
  const byCategory = groupShippedAdaptersByCategory(packagesDir);

  for (const category of RESTRICTED_CATEGORIES) {
    const contractPath = path.join(categoriesDir, `${category}.yaml`);
    if (!fs.existsSync(contractPath)) {
      errors.push(`${category}: missing category contract file ${contractPath}`);
    }

    const adapters = byCategory[category];
    if (adapters.length === 0) {
      errors.push(`${category}: no shipped adapter declares this category (expected exactly one)`);
    } else if (adapters.length > 1) {
      const names = adapters.map((a) => a.name).join(', ');
      errors.push(
        `${category}: expected exactly one shipped adapter, found ${adapters.length} (${names})`
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  RESTRICTED_CATEGORIES,
  EXCLUDED_PACKAGES,
  discoverShippedAdapters,
  groupShippedAdaptersByCategory,
  checkDefaultOnly
};
