#!/usr/bin/env node
'use strict';

/**
 * pr-review-beads-cli.js -- record the findings of a PR review as beads in the tracker of the
 * repository UNDER REVIEW (kata n350, docs/plans/pr-review-speedup-plan.md section 3H item 1).
 * JSON in on stdin, one JSON object out on stdout.
 *
 * It is NOT a subcommand of pr-review-cli.js: that CLI's modules are pure (no shell, no file
 * reads), and this one runs the tracker (`br`) through the toolchain. What to do is decided by
 * the pure `pr-review-beads.js`; this file asks the tracker what it already holds, runs the plan
 * and reports what happened. It never edits a file, commits, pushes, spawns a fix agent or asks a
 * question, so it behaves the same under `--foreman` and interactively: it only RECORDS. It does
 * not decide or resolve anything either: a finding's `resolution`, `cleared` mark and the gate's
 * verdict are untouched, so a blocking finding still blocks after its bead is recorded.
 *
 * Usage: node pr-review-beads-cli.js < payload.json
 *
 *   payload  { repo, prNumber, headSha, ledger[], security?{findings[]}, votes?, followOnIds?[],
 *              reportLink?, repoRoot?, dryRun?, timeoutMs? }
 *     repo         `owner/name`, the repository identity half of every dedupe key
 *     ledger       the ledger's findings; `cleared`/`clearedBy` (from `ledger` `clearFixedFindings`)
 *                  mark a finding fixed at a later head and close its bead with that commit
 *     votes        the `votes` result (each finding's tally and whether it is presented)
 *     followOnIds  the findings the OPERATOR chose to defer; they get the `follow-on` label. Never
 *                  fill this from an agent's own judgement
 *     repoRoot     the repository under review (default: the current directory). It must be a git
 *                  repository or linked-worktree root, exactly as `toolchain-cli --project-root`
 *                  requires, and is treated the same way: a source of working directory and
 *                  `.ensemble/toolchain.yaml` only, never of adapter code (a PR head must not
 *                  supply the tracker that records its own findings)
 *     dryRun       plan only: look the keys up, print the actions, change nothing
 *
 *   result   { ok, status, recorded, counts, actions[], beads{ <findingId>: { action, reason, key, beadId? } } }
 *     status   RECORDED     every action ran (exit 0)
 *              PLANNED      `dryRun` (exit 0)
 *              UNAVAILABLE  the repository has no usable tracker, or its adapter lacks a capability
 *                           the plan needs: NO bead was recorded, `fallback` is `skip-finding-beads`;
 *                           the caller says so and still shows the findings list (exit 0)
 *              PARTIAL      some actions failed, each `actions[i].error` says which (exit 1)
 *              FAILED       the plan could not be made: bad input or the tracker could not be read (exit 1)
 *   Put `beads[id].beadId` on each ledger entry as `beadId` before calling `gate`: the operator's
 *   decision list shows it.
 */

const fs = require('fs');

const tracker = require('./tracker-findings');
const { beadKeys, planBeads } = require('./pr-review-beads');
const { redact, statePath } = require('./pr-review-state');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function failed(reason, extra) {
  return { ok: false, status: 'FAILED', recorded: false, reason, ...extra };
}

function unavailableResult(envelope, plan) {
  const message = envelope.error && envelope.error.message ? envelope.error.message : 'the tracker is unavailable';
  return {
    ok: true,
    status: 'UNAVAILABLE',
    recorded: false,
    fallback: tracker.SKIP_FALLBACK,
    reason: message,
    ...(plan === undefined ? {} : { counts: plan.counts }),
    actions: [],
    beads: {},
  };
}

/** Run one planned action through the tracker. Returns `{ok, beadId?, error?, unavailable?}`. */
function execute(deps, action) {
  if (action.action === 'create') {
    const result = tracker.createFinding(deps, action.create);
    if (!result.ok) return result;
    return { ok: true, beadId: result.data && result.data.id };
  }
  if (action.action === 'update') {
    if (action.update) {
      const updated = tracker.updateFinding(deps, action.update);
      if (!updated.ok) return updated;
    }
    if (action.addLabels) {
      const labelled = tracker.labelFinding(deps, { id: action.beadId, labels: action.addLabels });
      if (!labelled.ok) return labelled;
    }
    return { ok: true, beadId: action.beadId };
  }
  if (action.action === 'close') {
    const closed = tracker.closeFinding(deps, action.close);
    return closed.ok ? { ok: true, beadId: action.beadId } : closed;
  }
  return { ok: true, beadId: action.beadId };
}

/**
 * Look up every key, plan, and run the plan.
 *
 * @param {object} input  the payload (see the file header), minus the CLI-only keys
 * @param {{run: Function}} deps  tracker deps (`createToolchainDeps`, or a fake in tests)
 * @param {{dryRun?: boolean}} [options]
 */
function recordBeads(input, deps, options = {}) {
  const wanted = beadKeys(input);
  if (!wanted.ok) return failed(wanted.reason);

  let byKey = {};
  if (wanted.keys.length > 0) {
    const listed = tracker.findByKeys(deps, { keys: wanted.keys });
    if (!listed.ok) {
      if (listed.unavailable) return unavailableResult(listed);
      return failed(`tracker lookup failed: ${listed.error && listed.error.message}`, { error: listed.error });
    }
    byKey = listed.byKey;
  }

  const plan = planBeads(input, byKey);
  if (!plan.ok) return failed(plan.reason);
  if (options.dryRun === true) {
    return { ok: true, status: 'PLANNED', recorded: false, counts: plan.counts, actions: plan.actions, beads: plan.byFinding };
  }

  const beads = { ...plan.byFinding };
  let unavailable = null;
  let errors = 0;
  const actions = plan.actions.map((action) => {
    const { create, update, close, ...summary } = action;
    if (action.action === 'error') {
      errors += 1;
      return summary;
    }
    const outcome = execute(deps, action);
    if (!outcome.ok) {
      errors += 1;
      if (outcome.unavailable && unavailable === null) unavailable = outcome;
      return { ...summary, ok: false, error: outcome.error, ...(outcome.unavailable ? { unavailable: true } : {}) };
    }
    if (outcome.beadId !== undefined) {
      summary.beadId = outcome.beadId;
      for (const id of action.findingIds) beads[id] = { ...beads[id], beadId: outcome.beadId };
    }
    return { ...summary, ok: true };
  });

  // Nothing ran at all because the tracker lacks what the plan needs: that is "skip the beads",
  // the same answer as a repository with no tracker, not a half-recorded run.
  const ran = actions.some((a) => a.ok === true && (a.action === 'create' || a.action === 'update' || a.action === 'close'));
  if (unavailable !== null && !ran) return unavailableResult(unavailable, plan);

  return {
    ok: errors === 0,
    status: errors === 0 ? 'RECORDED' : 'PARTIAL',
    recorded: errors === 0,
    counts: plan.counts,
    actions,
    beads,
  };
}

/**
 * @param {Object} [io]  `{ readJson, emit, deps, env, now }`, replaced by tests. `deps` are the
 *   tracker deps: when absent they are built for the repository under review.
 */
function main(io = {}) {
  const readJson = io.readJson || (() => JSON.parse(fs.readFileSync(0, 'utf8')));
  const emit = io.emit || ((value) => process.stdout.write(`${JSON.stringify(redact(value))}\n`));
  const now = io.now || Date.now;
  const started = now();
  const finish = (result) => {
    emit({ ...result, wallMs: now() - started });
    return result.ok === true ? 0 : 1;
  };

  let payload;
  try {
    payload = readJson();
  } catch (err) {
    return finish(failed(`invalid JSON on stdin: ${err.message}`));
  }
  if (!isObject(payload)) return finish(failed('payload must be a JSON object'));

  const { repoRoot, dryRun, timeoutMs, ...input } = payload;
  if (dryRun !== undefined && typeof dryRun !== 'boolean') return finish(failed("'dryRun' must be true or false when given"));

  let deps = io.deps;
  let projectRoot = typeof repoRoot === 'string' ? repoRoot : process.cwd();
  if (repoRoot !== undefined && (typeof repoRoot !== 'string' || repoRoot.trim() === '')) {
    return finish(failed("'repoRoot' must be a non-empty path when given"));
  }
  if (deps === undefined || input.reportLink === undefined) {
    const { resolveProjectRootFlag } = require('./toolchain-cli');
    const resolved = resolveProjectRootFlag(projectRoot);
    if (resolved.error) return finish(failed(resolved.error.message));
    projectRoot = resolved.projectRoot;
  }
  if (deps === undefined) {
    deps = tracker.createToolchainDeps({
      projectRoot,
      env: io.env || process.env,
      timeoutMs,
      // The reviewed tree is a source of cwd and config only, never of the adapter that records
      // its own findings (see the file header).
      untrustedProjectRoot: true,
    });
  }
  if (input.reportLink === undefined && Number.isInteger(input.prNumber) && input.prNumber >= 1) {
    input.reportLink = statePath(input.prNumber, projectRoot);
  }

  return finish(recordBeads(input, deps, { dryRun: dryRun === true }));
}

module.exports = { main, recordBeads };

if (require.main === module) {
  process.exit(main());
}
