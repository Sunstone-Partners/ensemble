#!/usr/bin/env node
'use strict';

/**
 * Auto-bumps packages/pi's declared version when its generated content has
 * changed since origin/main but nobody manually bumped the version.
 *
 * Why this exists: pi install (like `claude plugin update`, see
 * packages/core/commands/reinstall-plugins.yaml) gates re-fetching content on
 * whether the declared version string changed. If packages/pi/prompts,
 * agents, skills, or AGENTS.md drift from what's published while
 * packages/pi/package.json / .claude-plugin/plugin.json stay pinned, `pi
 * install` silently keeps serving stale content forever. This script closes
 * that gap by bumping the patch version automatically whenever content
 * changes are detected and no human already changed the version themselves.
 *
 * Wired up as `postgenerate:pi` (see root package.json) so it runs
 * automatically after every `npm run generate:pi`.
 *
 * Deliberately dependency-free (fs/path/child_process only), matching the
 * convention of the other scripts/*.js files in this repo (see
 * scripts/validate-all.js, scripts/sync-codex-version.js).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = path.join(ROOT, 'packages', 'pi', 'package.json');
const PLUGIN_JSON = path.join(ROOT, 'packages', 'pi', '.claude-plugin', 'plugin.json');
// Both manifests carry the same plugin entries: Claude Code loads the
// .claude-plugin/ copy, while validate-all.js and validate-version-sync.js read
// the root one. They are two real files (the .claude-plugin/ path must not be a
// symlink -- see the comment in validate-all.js for why), and validate-all.js
// requires them byte-identical, so a version bump has to land in both or CI
// fails. Writing both paths here is what keeps that true automatically (see
// scripts/sync-codex-version.js, which follows the same pattern).
const MARKETPLACE_JSONS = [
  path.join(ROOT, 'marketplace.json'),
  path.join(ROOT, '.claude-plugin', 'marketplace.json'),
];
const CONTENT_PATHS = [
  'packages/pi/prompts',
  'packages/pi/agents',
  'packages/pi/skills',
  'packages/pi/AGENTS.md',
];

function run(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * Simple semver patch bump: 1.6.0 -> 1.6.1. Deliberately minimal -- does not
 * attempt to handle pre-release/build metadata suffixes, since packages/pi
 * has never used them and this repo's other version scripts don't either.
 *
 * @param {string} version
 * @returns {string}
 */
function bumpPatch(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Cannot bump non-semver version: ${version}`);
  }
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

/**
 * Read a file's contents at a given git ref, or null if it did not exist at
 * that ref (e.g. a newly added file).
 *
 * @param {string} ref
 * @param {string} relativePath
 * @returns {string|null}
 */
function readAtRef(ref, relativePath) {
  try {
    return execFileSync('git', ['show', `${ref}:${relativePath}`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch {
    return null;
  }
}

function main() {
  // Optional escape hatch: `node scripts/bump-pi-version-if-changed.js <ref>`
  // compares against an explicit ref instead of computing the merge-base with
  // origin/main. Not used by the postgenerate:pi wiring (which always calls
  // this with no args, i.e. the spec'd merge-base behavior) -- this exists so
  // the mechanism can be exercised/verified against a specific historical
  // baseline (e.g. the last commit that actually bumped the version) without
  // needing real branch divergence from origin/main to test it.
  const explicitBaseRef = process.argv[2];

  let mergeBase;
  if (explicitBaseRef) {
    mergeBase = explicitBaseRef;
  } else {
    // Make sure we have an up-to-date origin/main to diff against. If there's
    // no network/remote access (e.g. offline dev environment), warn and bail
    // out cleanly -- this script must never hard-fail a local `npm run
    // generate:pi` run just because the remote isn't reachable.
    try {
      run(['fetch', 'origin', 'main', '--quiet']);
    } catch {
      console.error(
        'bump-pi-version-if-changed: could not fetch origin/main (no network/remote access?); ' +
        'skipping auto version bump.'
      );
      process.exit(0);
    }

    try {
      mergeBase = run(['merge-base', 'HEAD', 'origin/main']);
    } catch {
      console.error(
        'bump-pi-version-if-changed: could not determine merge-base with origin/main; skipping auto version bump.'
      );
      process.exit(0);
    }
  }

  // Diff the working tree (including uncommitted changes, since this runs
  // right after generate writes fresh content to disk) against the merge-base
  // for exactly the content paths that matter.
  let contentDiff;
  try {
    contentDiff = run(['diff', mergeBase, '--', ...CONTENT_PATHS]);
  } catch {
    console.error('bump-pi-version-if-changed: failed to diff content paths; skipping auto version bump.');
    process.exit(0);
  }

  if (!contentDiff) {
    // No content drift relative to origin/main -- nothing to do.
    process.exit(0);
  }

  const currentPkg = readJson(PACKAGE_JSON);
  const baselinePkgRaw = readAtRef(mergeBase, 'packages/pi/package.json');
  const baselineVersion = baselinePkgRaw ? JSON.parse(baselinePkgRaw).version : undefined;

  if (baselineVersion !== undefined && baselineVersion !== currentPkg.version) {
    // A human already changed the version in this branch/PR (maybe a
    // deliberate minor/major bump) -- respect that and don't stomp it.
    process.exit(0);
  }

  const oldVersion = currentPkg.version;
  const newVersion = bumpPatch(oldVersion);

  const pkg = readJson(PACKAGE_JSON);
  pkg.version = newVersion;
  writeJson(PACKAGE_JSON, pkg);

  const plugin = readJson(PLUGIN_JSON);
  plugin.version = newVersion;
  writeJson(PLUGIN_JSON, plugin);

  // Also keep both marketplace.json copies' ensemble-pi entry in sync --
  // scripts/validate-version-sync.js (run by `npm run validate`) checks it
  // against package.json/plugin.json for every package with a marketplace
  // entry, and validate-all.js requires the two marketplace.json copies to be
  // byte-identical.
  for (const marketplaceFile of MARKETPLACE_JSONS) {
    if (!fs.existsSync(marketplaceFile)) {
      continue;
    }
    const marketplace = readJson(marketplaceFile);
    const entry = (marketplace.plugins || []).find((p) => p.name === 'ensemble-pi');
    if (entry) {
      entry.version = newVersion;
      writeJson(marketplaceFile, marketplace);
    }
  }

  const baselineDescription = explicitBaseRef ? explicitBaseRef : 'origin/main';
  console.log(
    `Bumped packages/pi version ${oldVersion} -> ${newVersion} ` +
    `(content changed since ${baselineDescription}, version was not manually updated)`
  );
}

if (require.main === module) {
  main();
}

module.exports = { bumpPatch };
