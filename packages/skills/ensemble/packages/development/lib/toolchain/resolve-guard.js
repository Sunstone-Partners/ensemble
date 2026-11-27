'use strict';

/**
 * `UNKNOWN_ADAPTER` resolver guard (TRD-2026-8d825f54 TRD-046).
 *
 * `resolveCategory()` (`./config.js`) returns `{value, source}` with no check that `value` is
 * an adapter id that actually ships anywhere (repo-local, user, or installed) for the category
 * it was resolved for: a project or user `.ensemble/toolchain.yaml`/`toolchain.yaml` naming a
 * typo'd or never-shipped adapter id (for example `{iac: pulumi}` when only `terraform` ships)
 * silently "resolves" to that bogus id, and the mistake only surfaces later, and only for
 * entry points that happen to call `loadAdapter` afterward (`run`, `confirm-status`,
 * `confirm-record`, `preflight`), as a generic `NOT_INSTALLED` naming every location searched --
 * never for `resolve`/`explain`, which never call `loadAdapter` at all and so report the bogus
 * selection as if it were perfectly valid.
 *
 * `assertKnownAdapter(category, resolved, ctx)` closes that gap: it throws an `Error` with
 * `.code === 'UNKNOWN_ADAPTER'`, naming `category`, the offending `resolved.value`, and every
 * real adapter id shipped for `category` (via `./adapters.js#discoverAdapters`, reading each
 * candidate's own `adapter.yaml` `categories` field -- `discoverAdapters` itself never
 * partitions its results by category), when BOTH of these hold:
 *   - `resolved.source` is `'project'` or `'user'` -- an EXPLICIT config selection. `'default'`
 *     (the shipped `toolchain.default.yaml`), `'detection'` (`./detect.js`, which only ever
 *     returns a candidate `discoverAdapters` itself found) and `'env-compat'` (the legacy
 *     `ENSEMBLE_HOST`/`ENSEMBLE_WORKFLOW`-style inputs, host/workflow only) can never name an
 *     unshipped id by construction, so this guard never second-guesses any of those three tiers.
 *   - `category` is not `tracker` or `host`. Both already support several legitimately shipped
 *     adapters (`beads`/`jira`/`azure-boards` for `tracker`; `github`/`azure-devops` for
 *     `host`) and are intentionally out of this bead's scope (TRD-046 targets the single-
 *     default-adapter categories TRD-042/043/044 just shipped); re-validating them here risks
 *     regressing an already-working, previously-untouched resolution path for no AC this bead
 *     names. `work-graph` needs no explicit exclusion here: every call site below resolves it
 *     through `./work-graph-resolve.js#resolveWorkGraphAdapter`, a completely separate code
 *     path (TRD-027/I7's `auto` fallback expansion) that never calls `resolveCategory`/this
 *     guard at all.
 *
 * This lives in its own file rather than inside `./config.js` (which already owns
 * `resolveCategory`'s precedence chain) because `./config.js` cannot `require('./adapters')`
 * without creating a circular require: `./adapters.js` already does
 * `require('./config')` at its own top level (for `loadToolchainConfigFile`, used by its
 * repo-local trust check), and both modules assign a *new* `module.exports` object at the end
 * of the file rather than mutating a pre-existing one, so whichever of the two loads second
 * would capture the other's exports mid-initialization (before that final assignment runs) --
 * silently `undefined` destructured bindings, not a loud failure. A new, leaf file that only
 * `require('./adapters')` (and is required by nothing `./adapters.js` or `./config.js`
 * themselves load) sidesteps that entirely.
 *
 * `preflight.js#runPreflight`'s own `resolveCategory` call site for every non-`work-graph`
 * category IS also wired to this guard (PR 10 fix round, item 2a): it now calls
 * `assertKnownAdapter` immediately after `resolveCategory` and BEFORE `loadAdapter`, so this
 * same "resolved to a never-shipped id" case reports `UNKNOWN_ADAPTER` there too, instead of
 * the generic `NOT_INSTALLED` (mapped to `HEALTH_FAILED`) `loadAdapter` would otherwise throw.
 */

const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

const { discoverAdapters } = require('./adapters');

/** Categories this guard never second-guesses; see the module doc above. */
const EXCLUDED_CATEGORIES = new Set(['tracker', 'host']);

/**
 * Every adapter id shipped for `category`, deduplicated and sorted. Derived by reading each
 * `discoverAdapters(ctx)` candidate's own `adapter.yaml` fresh off disk (no cache, matching
 * `./adapters.js`'s own no-cache guarantee); a candidate whose manifest is missing, unreadable,
 * invalid YAML, not an object, or lacks a `categories` array contributes nothing -- the same
 * "skip, never throw" posture `discoverAdapters` itself uses for a bad manifest.
 *
 * @param {string} category
 * @param {object} ctx passed straight through to `discoverAdapters`
 * @returns {string[]}
 */
function shippedAdapterNames(category, ctx) {
  const names = new Set();
  for (const entry of discoverAdapters(ctx)) {
    let manifest;
    try {
      manifest = yaml.load(fs.readFileSync(path.join(entry.dir, 'adapter.yaml'), 'utf8'));
    } catch {
      continue;
    }
    if (manifest && Array.isArray(manifest.categories) && manifest.categories.includes(category)) {
      names.add(entry.name);
    }
  }
  return [...names].sort();
}

/**
 * @param {string} category
 * @param {{value: string, source: string}} resolved `resolveCategory`'s own return shape
 * @param {object} [ctx] passed straight through to `discoverAdapters`
 * @throws {Error} with `.code === 'UNKNOWN_ADAPTER'`; see module doc for exactly when
 */
function assertKnownAdapter(category, resolved, ctx = {}) {
  if (EXCLUDED_CATEGORIES.has(category)) {
    return;
  }
  if (resolved.source !== 'project' && resolved.source !== 'user') {
    return;
  }

  const shipped = shippedAdapterNames(category, ctx);
  if (shipped.includes(resolved.value)) {
    return;
  }

  const available = shipped.length > 0 ? shipped.join(', ') : '(none shipped)';
  const error = new Error(
    `${category}: '${resolved.value}' is not a shipped adapter. Available: ${available}`
  );
  error.code = 'UNKNOWN_ADAPTER';
  throw error;
}

module.exports = { assertKnownAdapter, shippedAdapterNames, EXCLUDED_CATEGORIES };
