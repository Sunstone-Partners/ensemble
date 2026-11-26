'use strict';

/**
 * TRD-013 (TRD-2026-d571763f): closing a story and recording the commit that justifies it.
 *
 * `skills/ensemble-implement-trd-tasks/references/phase-4-quality-gate.md:10` closes a phase in
 * one fixed order: resolve HEAD, close with a reason of at least forty characters and that sha,
 * sync, stage only this TRD's beads, commit. Each step lives here so every verb that closes a
 * story does the same thing in the same order -- a second closer that staged the whole index or
 * composed a shorter reason would quietly produce commits nobody can review.
 *
 * Nothing here decides WHETHER to close. The caller has already made that decision; this module
 * refuses only when a step it is asked to perform cannot be done honestly.
 */

const MESSAGES = require('./messages');
const { refused } = require('./result');
const { runTrd } = require('./cli-json');
const { callCapability, classify } = require('./tracker');
const { stagePath, stagedPaths } = require('./git');

/** A sha, as `workflow.merge-base` answers one. */
const SHA_RE = /^[0-9a-f]{7,40}$/;

/** The tracked export `beads-stage` scopes, and the only path a checkpoint commit may add. */
const BEADS_EXPORT = '.beads/issues.jsonl';

/**
 * The sha `HEAD` points at, through the `workflow` category rather than `git` directly
 * (`phase-4-quality-gate.md:10`: `workflow.merge-base --arg refA=HEAD --arg refB=HEAD`).
 *
 * @param {object} call the dispatcher's call object
 * @returns {string|object} the sha, or a tagged engine result
 */
function headSha(call) {
  const answer = classify(
    callCapability(call, 'workflow.merge-base', { refA: 'HEAD', refB: 'HEAD' }),
    'workflow.merge-base'
  );
  if (answer.kind !== 'ok') return answer;
  const data = answer.data;
  const sha = String((data && typeof data === 'object' ? data.sha : data) || '').trim();
  // A close records WHICH commit the gate ran against. An empty or non-sha answer would record
  // a claim about a commit that may not exist, so it stops here rather than being passed on.
  if (!SHA_RE.test(sha)) return refused('HEAD_UNRESOLVED', MESSAGES.HEAD_UNRESOLVED);
  return sha;
}

/**
 * The reason a story is closed with, checked against policy before it is used.
 *
 * @param {string} id the story bead, named in the refusal
 * @param {string} text the composed reason
 * @param {number} min `closure_reason_min_length`
 * @returns {string|object} the reason, or a tagged engine result
 */
function composeReason(id, text, min) {
  if (text.length < min) {
    return refused('CLOSURE_REASON_TOO_SHORT', MESSAGES.closureReasonTooShort(id, text.length, min));
  }
  return text;
}

/**
 * Close one story, with its reason and the commit it was judged on.
 *
 * `tracker.close-with-reason` is an OPTIONAL capability: a tracker that lacks it closes through
 * `tracker.close` and the reason is reported rather than stored, exactly as the reference's own
 * `(NOT_ALLOWED: use tracker.close --arg id=<ID>)` note says. A gate refusal from the toolchain
 * is returned unchanged -- it is the gate doing its job, not a shape to degrade around.
 *
 * @param {object} call the dispatcher's call object
 * @param {{commit: string, id: string, reason: string}} input
 * @returns {{fallback: boolean}|object} how it closed, or a tagged engine result
 */
function closeBead(call, { commit, id, reason }) {
  const withReason = classify(
    callCapability(call, 'tracker.close-with-reason', { id, reason, commit }),
    'tracker.close-with-reason'
  );
  if (withReason.kind === 'ok') return { fallback: false };
  if (withReason.kind === 'gate') return withReason;
  if (withReason.kind !== 'unavailable') {
    return refused('STORY_CLOSE_FAILED', MESSAGES.storyCloseFailed(id, withReason.message));
  }

  const plain = classify(callCapability(call, 'tracker.close', { id }), 'tracker.close');
  if (plain.kind === 'ok') return { fallback: true };
  if (plain.kind === 'gate') return plain;
  return refused('STORY_CLOSE_FAILED', MESSAGES.storyCloseFailed(id, plain.message));
}

/**
 * Ask the tracker to flush whatever it keeps on disk. Best effort by contract: `tracker.sync` is
 * optional (`phase-4-quality-gate.md:9` calls it "optional"), and a tracker without it is not a
 * failure of the close that already happened.
 *
 * @param {object} call the dispatcher's call object
 * @returns {string|null} a warning, or null
 */
function flushTracker(call) {
  const answer = classify(callCapability(call, 'tracker.sync'), 'tracker.sync');
  if (answer.kind === 'ok') return null;
  return MESSAGES.unavailableWarning(
    'tracker.sync',
    answer.message || 'tracker.sync failed',
    'the tracker was not flushed before the checkpoint commit'
  );
}

/**
 * Refuse when the index already holds something this commit must not carry.
 *
 * `beads-stage` scopes the EXPORT to this TRD, but it cannot unstage a file someone added by
 * hand: without this check the checkpoint commit would silently carry that file under a message
 * that says it is a bead checkpoint.
 *
 * @param {object} call the dispatcher's call object
 * @param {string[]} extraPaths paths this commit is allowed to carry
 * @returns {null|object} null when the index is clean enough, or a tagged engine result
 */
function assertIndexClean(call, extraPaths = []) {
  const staged = stagedPaths(call);
  if (staged && staged.status) return staged;
  const allowed = new Set([BEADS_EXPORT, ...extraPaths]);
  const foreign = staged.filter(entry => !allowed.has(entry));
  if (foreign.length > 0) {
    return refused('STAGED_FOREIGN_PATHS', MESSAGES.stagedForeignPaths(foreign));
  }
  return null;
}

/**
 * Stage this TRD's beads (plus any path the caller owns) and make the checkpoint commit.
 *
 * Staging goes through `trd-cli beads-stage`, which rewrites the export so only this TRD's beads
 * differ from HEAD; committing the whole file would carry another TRD's bead changes.
 *
 * A commit with nothing staged is not an error: on a re-run where the export already matches
 * HEAD there is genuinely nothing to record, and failing there would turn a no-op into a stop.
 *
 * @param {object} call the dispatcher's call object
 * @param {{extraPaths?: string[], message: string, slug: string}} input
 * @returns {{committed: boolean, reason: string|null, sha: string|null}|object}
 */
function stageAndCommit(call, { extraPaths = [], message, slug }) {
  for (const relPath of extraPaths) {
    const added = stagePath(call, relPath);
    if (added && added.status) return added;
  }

  const staged = runTrd(call, ['beads-stage', '--match', `[trd:${slug}`]);
  if (!staged.json || staged.json.ok !== true) {
    const detail =
      (staged.json && typeof staged.json.error === 'string' && staged.json.error) ||
      `exit ${staged.exitCode}${staged.stderr ? `: ${staged.stderr.trim()}` : ''}`;
    return refused('BEADS_STAGE_FAILED', MESSAGES.beadsStageFailed(slug, detail));
  }

  const nowStaged = stagedPaths(call);
  if (nowStaged && nowStaged.status) return nowStaged;
  if (nowStaged.length === 0) {
    return { committed: false, reason: 'nothing staged', sha: null };
  }

  const committed = classify(callCapability(call, 'workflow.commit', { message }), 'workflow.commit');
  if (committed.kind === 'gate') return committed;
  if (committed.kind !== 'ok') {
    return refused('COMMIT_FAILED', MESSAGES.commitFailed(slug, committed.message));
  }
  const data = committed.data;
  const sha = String((data && typeof data === 'object' ? data.sha : data) || '').trim();
  return { committed: true, reason: null, sha: SHA_RE.test(sha) ? sha : null };
}

module.exports = {
  BEADS_EXPORT,
  assertIndexClean,
  closeBead,
  composeReason,
  flushTracker,
  headSha,
  stageAndCommit,
};
