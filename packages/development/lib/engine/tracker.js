'use strict';

/**
 * TRD-011 (TRD-2026-d571763f): the tracker calls the `implement` verbs share.
 *
 * Every call goes through `toolchain-cli run`, so the adapter resolution, the allowlist, the
 * preflight gate and the confirmation gate are the toolchain's and this module adds none of its
 * own (Constitution Rule 5). What this module does add is one reading of a capability's answer:
 * a tracker that cannot do something, a tracker that refused, and a tracker that failed are
 * three different facts, and a verb that conflates them either invents a scaffold that does not
 * exist or halts on a tracker that merely lacks an optional capability.
 */

const { runToolchain, toolchainFailure } = require('./cli-json');
const { unavailable } = require('./result');
const { parseTitlePrefix } = require('../bead-refs');

/**
 * The runner's own wording for a capability the adapter never declared (`runner.js:990`), which
 * arrives as `NOT_ALLOWED` rather than as an `unavailable` envelope. The text is
 * `tracker-findings.js:50`'s, so both readers agree on what "cannot" looks like.
 */
const UNDECLARED_RE = /^capability '[^']+' is not declared by adapter '/;

/** A bead's title prefix: the `[trd:...]` bracket the scaffold addresses it by. */
const PREFIX_RE = /^\s*(\[[^\]]+\])/;

/**
 * Run one tracker capability.
 *
 * Arguments are passed in the object's insertion order, because an adapter's `run` template is
 * positional and the plan's argument order is the documented one.
 *
 * @param {object} call the dispatcher's call object
 * @param {string} capability e.g. `tracker.create`
 * @param {Record<string, string|number>} [args] `--arg key=value` pairs
 * @returns {{exitCode: number, json: object|null, stderr: string}}
 */
function callCapability(call, capability, args = {}) {
  const argv = ['run', capability];
  for (const [key, value] of Object.entries(args)) {
    argv.push('--arg', `${key}=${value}`);
  }
  return runToolchain(call, argv);
}

/**
 * Read what a capability's result actually says.
 *
 * `gate` is the one kind a caller must never reinterpret: a refusal the toolchain issued
 * (preflight missing, confirmation missing, capability not reported) is the gate doing its job,
 * and the verb returns it unchanged rather than degrading around it.
 *
 * @param {{exitCode: number, json: object|null, stderr: string}} result
 * @param {string} capability
 * @returns {{kind: 'ok', adapter: string|null, data: *}
 *   | {kind: 'unavailable', message: string}
 *   | {kind: 'gate', result: object}
 *   | {kind: 'failed', code: string, message: string}
 *   | {kind: 'unreadable', message: string}}
 */
function classify(result, capability) {
  if (!result.json) {
    return {
      kind: 'unreadable',
      message: `${capability} produced no JSON result (exit ${result.exitCode})${
        result.stderr ? `: ${result.stderr.trim()}` : ''
      }`,
    };
  }
  if (result.json.ok === true) {
    return {
      adapter: typeof result.json.adapter === 'string' ? result.json.adapter : null,
      data: result.json.data,
      kind: 'ok',
    };
  }

  const error = result.json.error || {};
  const code = typeof error.code === 'string' ? error.code : 'TOOL_FAILED';
  const message = typeof error.message === 'string' ? error.message : `${capability} failed`;

  // Three shapes mean the same thing -- this adapter cannot do it: the runner's own
  // `unavailable` envelope, a capability the adapter never declared, and a binary that is not
  // installed.
  if (result.json.unavailable === true) return { kind: 'unavailable', message };
  if (code === 'NOT_ALLOWED' && UNDECLARED_RE.test(message)) return { kind: 'unavailable', message };
  if (typeof error.missingBinary === 'string') return { kind: 'unavailable', message };

  const gate = toolchainFailure(error);
  if (gate.status === 'REFUSED' || gate.status === 'INVALID_INPUT') {
    return { kind: 'gate', result: gate };
  }
  return { code, kind: 'failed', message };
}

/**
 * Every issue the tracker holds, and the adapter that answered.
 *
 * @param {object} call the dispatcher's call object
 * @returns {{adapter: string|null, issues: object[]}|object} the rows, or a tagged engine result
 */
function readIssues(call) {
  const result = runToolchain(call, ['run', 'tracker.list']);
  if (!result.json) {
    return unavailable(
      'TRACKER_UNREADABLE',
      `tracker.list produced no JSON result (exit ${result.exitCode})${
        result.stderr ? `: ${result.stderr.trim()}` : ''
      }`
    );
  }
  if (result.json.ok !== true) return toolchainFailure(result.json.error);

  let payload = result.json.data;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return unavailable('TRACKER_UNREADABLE', 'tracker.list output is not valid JSON');
    }
  }
  // Every shipped tracker shape: a bare array (older `br`), `{issues}` (`br --json`) or the
  // normalized `{items}` a parsed adapter answers with.
  const issues = Array.isArray(payload)
    ? payload
    : payload && Array.isArray(payload.issues)
      ? payload.issues
      : payload && Array.isArray(payload.items)
        ? payload.items
        : null;
  if (!issues) {
    return unavailable('TRACKER_UNREADABLE', 'tracker.list output has no issue list');
  }

  return { adapter: typeof result.json.adapter === 'string' ? result.json.adapter : null, issues };
}

/**
 * The `[trd:...]` prefix a bead title starts with.
 * @param {*} title
 * @returns {string|null} the bracket including its brackets, or null
 */
function prefixOf(title) {
  const match = PREFIX_RE.exec(String(title == null ? '' : title));
  return match ? match[1] : null;
}

/**
 * The id a create answered with.
 *
 * An adapter that declares `parse` hands back an object; one that does not hands back its raw
 * text. Anything else -- including an object with no `id` -- is no id at all, and the caller
 * must refuse rather than record an empty string as a bead.
 *
 * @param {*} data a capability's `data`
 * @returns {string} the id, or `''`
 */
function idOf(data) {
  let value = data;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return '';
    try {
      value = JSON.parse(text);
    } catch {
      return '';
    }
  }
  if (!value || typeof value !== 'object') return '';
  const id = value.id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return typeof id === 'string' ? id.trim() : '';
}

/**
 * The beads of one TRD, and nothing else.
 *
 * Scope is the title prefix's own slug, compared for equality rather than by prefix: the beads
 * of `[trd:widget-engine-v2]` are a different TRD's and must never be counted, relabelled or
 * reported as this one's drift. A row with no id cannot be addressed and is dropped; list order
 * is kept, so a duplicate prefix resolves the way the scaffold's own cache resolves it.
 *
 * @param {object[]} issues the `tracker.list` rows
 * @param {string} slug the TRD's slug
 * The row's `dependencies` are carried through untouched: on a tracker whose list already holds
 * the links, they are the live edge set, and re-reading each bead to find that out would be a
 * read per bead for data already in hand.
 *
 * @returns {{dependencies: *, description: *, id: string, kind: string, labels: *,
 *   prefix: string, status: *, taskId: string|null, title: string}[]}
 */
function scopeBeads(issues, slug) {
  const scoped = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (!issue || typeof issue !== 'object') continue;
    const id = typeof issue.id === 'string' ? issue.id.trim() : '';
    if (id === '') continue;
    const title = String(issue.title == null ? '' : issue.title);
    const info = parseTitlePrefix(title);
    if (!info || info.slug !== slug) continue;
    scoped.push({
      dependencies: issue.dependencies,
      description: issue.description,
      id,
      kind: info.kind,
      labels: issue.labels,
      prefix: prefixOf(title),
      status: issue.status,
      taskId: info.taskId || null,
      title,
    });
  }
  return scoped;
}

/**
 * Whether a bead is done. Trackers spell the status differently in case only.
 * @param {{status: *}} bead
 * @returns {boolean}
 */
function isClosed(bead) {
  return String(bead && bead.status).toLowerCase() === 'closed';
}

/**
 * Whether a bead is one the build dispatches: the epic and its stories are not.
 * @param {string} kind a `parseTitlePrefix` kind
 * @returns {boolean}
 */
function isTaskLevel(kind) {
  return kind === 'task' || kind === 'test' || kind === 'synth';
}

/**
 * The id a dependency link names. Both shapes the normalized work-item schema allows are
 * accepted (`work-graph-scan.js:28-41`): a `{id}` object and a bare id string, each meaning
 * "blocked by that id". Anything else is a link this reader cannot follow.
 *
 * @param {*} entry one element of a bead's `dependencies`
 * @returns {string|null}
 */
function depIdOf(entry) {
  if (typeof entry === 'string') {
    const text = entry.trim();
    return text === '' ? null : text;
  }
  if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
    const text = entry.id.trim();
    return text === '' ? null : text;
  }
  return null;
}

module.exports = {
  UNDECLARED_RE,
  callCapability,
  classify,
  depIdOf,
  idOf,
  isClosed,
  isTaskLevel,
  prefixOf,
  readIssues,
  scopeBeads,
};
