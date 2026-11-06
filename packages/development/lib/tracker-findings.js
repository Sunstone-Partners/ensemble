'use strict';

/**
 * Findings-as-beads tracker operations (plan docs/plans/pr-review-speedup-plan.md section 3H
 * item 1, kata yfbg): create a bead with labels/priority/dedupe key in one call, find a bead
 * by its dedupe key, append an update, close with a reason and commit.
 *
 * This module is the caller-side half of four OPTIONAL `tracker.*` capabilities
 * (`tracker.create-detailed`, `tracker.find-by-key`, `tracker.update-detailed`,
 * `tracker.close-with-reason`; contract: toolchain/categories/tracker.yaml). It holds the rules
 * a declarative adapter manifest cannot express: exact-match key lookup with a zero/one/many
 * verdict, input validation, and one defined "unavailable" result.
 *
 * Pure by construction: NO shell, NO network and NO file reads here. Every effect goes through
 * the injected `deps.run(capability, args)`, which returns the toolchain runner's envelope
 * (`{ok:true, data}` or `{ok:false, error:{code, message}, unavailable?, fallback?}`). The
 * default `deps` (`createToolchainDeps`) is the only part that touches the toolchain, and it
 * lives in its own function so tests inject a fake or a real manifest.
 *
 * Every function RETURNS a result and never throws for a missing tracker or capability:
 *   - `{ok:true, ...}` success
 *   - `{ok:false, unavailable:true, fallback:'skip-finding-beads', error:{code:'UNAVAILABLE'}}`
 *     the repository has no usable tracker, or its adapter does not declare the capability
 *     (callers skip the beads and still show the findings list)
 *   - `{ok:false, error:{code, message}}` any other refusal or failure (INVALID_ARG,
 *     AMBIGUOUS_KEY, BAD_OUTPUT, TOOL_FAILED, ...)
 */

const SKIP_FALLBACK = 'skip-finding-beads';
// br accepts only these characters in a label (captured live: VALIDATION_FAILED otherwise).
const LABEL_RE = /^[A-Za-z0-9_:-]+$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;
// Matches runner.js#lookupCapability's text for an adapter that omits a capability whose
// category contract carries no `fallback` (an older vendored contract): still "unavailable".
const UNDECLARED_RE = /^capability '[^']+' is not declared by adapter '/;
const SPAWN_ENOENT_RE = /\bspawn(?:Sync)? \S+ ENOENT\b/;
// Adapter id -> directory that must exist under the project root for the tracker to be set up.
const WORKSPACE_MARKERS = { beads: '.beads' };

function failure(code, message, extra) {
  return { ok: false, error: { code, message }, ...extra };
}

function unavailable(message) {
  return {
    ok: false,
    unavailable: true,
    fallback: SKIP_FALLBACK,
    error: { code: 'UNAVAILABLE', message }
  };
}

/** Map a runner envelope to this module's result: structured-unavailable and undeclared both degrade. */
function classify(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    return failure('BAD_OUTPUT', 'tracker run returned no envelope');
  }
  if (envelope.ok) return envelope;
  if (envelope.unavailable) return unavailable(envelope.error && envelope.error.message);
  const error = envelope.error || {};
  if (error.code === 'NOT_ALLOWED' && UNDECLARED_RE.test(String(error.message))) {
    return unavailable(error.message);
  }
  // The tracker's binary is not installed (execFile ENOENT): no tracker here, not a tool failure.
  if (error.code === 'TOOL_FAILED' && SPAWN_ENOENT_RE.test(String(error.message))) {
    return unavailable(error.message);
  }
  return envelope;
}

function call(deps, capability, args) {
  let envelope;
  try {
    envelope = deps.run(capability, args);
  } catch (error) {
    // deps.run is allowed to throw only when the tracker itself cannot be resolved.
    return unavailable(`tracker is unavailable: ${error && error.message ? error.message : error}`);
  }
  return classify(envelope);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validLabels(labels) {
  return Array.isArray(labels) && labels.length > 0 && labels.every((l) => typeof l === 'string' && LABEL_RE.test(l));
}

function validPriority(priority) {
  const n = typeof priority === 'string' && /^[0-9]+$/.test(priority) ? Number(priority) : priority;
  return Number.isInteger(n) && n >= 0 && n <= 4;
}

/**
 * Create a bead in one call. `key` is stored as the bead's external reference and is what
 * `findByKey` matches on; `labels` MUST include the scope label `findByKey` will later use.
 *
 * @param {{run: Function}} deps
 * @param {{title: string, description: string, type?: string, labels: string[], priority: number, key: string}} input
 * @returns {{ok:true, data:{id:string}} | object}
 */
function createFinding(deps, { title, description, type = 'bug', labels, priority, key } = {}) {
  if (!nonEmpty(key)) return failure('INVALID_ARG', "createFinding: 'key' must be a non-empty string");
  if (!nonEmpty(title)) return failure('INVALID_ARG', "createFinding: 'title' must be a non-empty string");
  if (typeof description !== 'string') return failure('INVALID_ARG', "createFinding: 'description' must be a string");
  if (!validLabels(labels)) {
    return failure('INVALID_ARG', "createFinding: 'labels' must be a non-empty list of [A-Za-z0-9_:-] labels");
  }
  if (!validPriority(priority)) return failure('INVALID_ARG', "createFinding: 'priority' must be an integer 0-4");
  return call(deps, 'tracker.create-detailed', {
    title,
    description,
    type,
    labels: labels.join(','),
    priority: String(priority),
    externalKey: key
  });
}

/**
 * Find the bead whose external key is exactly `key` among beads labelled `label` (closed beads
 * included).
 *
 * @returns {{ok:true, found:true, item:object} | {ok:true, found:false} |
 *   {ok:false, error:{code:'AMBIGUOUS_KEY', message:string, ids:string[]}} | object}
 *   Several beads sharing one key is refused, never resolved by picking one.
 */
function findByKey(deps, { key, label } = {}) {
  if (!nonEmpty(key)) return failure('INVALID_ARG', "findByKey: 'key' must be a non-empty string");
  if (typeof label !== 'string' || !LABEL_RE.test(label)) {
    return failure('INVALID_ARG', "findByKey: 'label' must be a single [A-Za-z0-9_:-] label");
  }
  const result = call(deps, 'tracker.find-by-key', { key, label });
  if (!result.ok) return result;

  let parsed = result.data;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (_error) {
      return failure('BAD_OUTPUT', 'findByKey: tracker output is not valid JSON');
    }
  }
  // `br list --json` wraps as {issues:[...]}; an older br prints a bare array.
  const items = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.issues) ? parsed.issues : null;
  if (!items) return failure('BAD_OUTPUT', 'findByKey: tracker output has no issue list');

  const matches = items.filter((item) => item && item.external_ref === key);
  if (matches.length === 0) return { ok: true, found: false };
  if (matches.length > 1) {
    const ids = matches.map((item) => item.id);
    return {
      ok: false,
      error: {
        code: 'AMBIGUOUS_KEY',
        message: `findByKey: ${matches.length} beads carry key '${key}' (${ids.join(', ')}); refusing to pick one`,
        ids
      }
    };
  }
  return { ok: true, found: true, item: matches[0] };
}

/** Rewrite title/description/priority and append `note`; labels and status are untouched. */
function updateFinding(deps, { id, title, description, priority, note } = {}) {
  if (!nonEmpty(id)) return failure('INVALID_ARG', "updateFinding: 'id' must be a non-empty string");
  if (!nonEmpty(title)) return failure('INVALID_ARG', "updateFinding: 'title' must be a non-empty string");
  if (typeof description !== 'string') return failure('INVALID_ARG', "updateFinding: 'description' must be a string");
  if (!validPriority(priority)) return failure('INVALID_ARG', "updateFinding: 'priority' must be an integer 0-4");
  if (!nonEmpty(note)) return failure('INVALID_ARG', "updateFinding: 'note' must be a non-empty string");
  return call(deps, 'tracker.update-detailed', { id, title, description, priority: String(priority), notes: note });
}

/** Close a bead. A reason and the resolving commit are both required: no reasonless close. */
function closeFinding(deps, { id, reason, commit } = {}) {
  if (!nonEmpty(id)) return failure('INVALID_ARG', "closeFinding: 'id' must be a non-empty string");
  if (!nonEmpty(reason)) return failure('INVALID_ARG', "closeFinding: a non-empty 'reason' is required");
  if (typeof commit !== 'string' || !COMMIT_RE.test(commit)) {
    return failure('INVALID_ARG', "closeFinding: 'commit' must be a 7-40 character hex SHA");
  }
  return call(deps, 'tracker.close-with-reason', { id, reason, commit });
}

/**
 * Default deps: resolve the repository's tracker adapter through the toolchain and run
 * capabilities against it with `cwd` set to `projectRoot`. When no tracker can be resolved
 * (no config/detect match, adapter not installed, manifest invalid) `run` throws, which
 * `call` reports as the defined unavailable result. Requires are lazy so the pure functions
 * above load without the toolchain.
 *
 * @param {{projectRoot: string, env?: NodeJS.ProcessEnv, timeoutMs?: number}} options
 * @returns {{run: (capability: string, args: object) => object}}
 */
function createToolchainDeps({ projectRoot, env = process.env, timeoutMs } = {}) {
  let manifest;
  return {
    run(capability, args) {
      if (!manifest) {
        const { resolveCategory } = require('./toolchain/config');
        const { loadAdapter } = require('./toolchain/adapters');
        const { detectAdapter } = require('./toolchain/detect');
        const resolved = resolveCategory('tracker', { projectRoot, env, detect: detectAdapter });
        const loaded = loadAdapter(resolved.value, { projectRoot, env, interactive: false }).manifest;
        // A tracker whose workspace is not initialised in this repository is "no tracker":
        // br reports that only on stdout, which the runner's TOOL_FAILED detail drops, so it
        // cannot be recognised from the envelope.
        const marker = WORKSPACE_MARKERS[loaded.adapter];
        if (marker && !require('fs').existsSync(require('path').join(projectRoot, marker))) {
          throw new Error(`no '${marker}' workspace in ${projectRoot} for the '${loaded.adapter}' tracker`);
        }
        manifest = loaded;
      }
      const { runCapabilitySync } = require('./toolchain/runner');
      return runCapabilitySync(manifest, capability, args, {
        parentEnv: env,
        timeoutMs,
        execFileOptions: { cwd: projectRoot }
      });
    }
  };
}

module.exports = {
  SKIP_FALLBACK,
  createFinding,
  findByKey,
  updateFinding,
  closeFinding,
  createToolchainDeps
};
