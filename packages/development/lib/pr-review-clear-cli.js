#!/usr/bin/env node
'use strict';

/**
 * pr-review-clear-cli.js -- derive `cleared` marks for a PR-review ledger from real git
 * (kata n350, AC-008-3).
 *
 * JSON in on stdin, one JSON object out on stdout. This is NOT a subcommand of
 * pr-review-cli.js: that CLI is pure (no shell, no file reads); this one reads git.
 * It only DERIVES marks. It never decides, resolves or closes anything, never writes a
 * file, ref or index, and never touches the tracker: the caller hands the returned ledger
 * on, and the bead recorder closes a bead only for an entry that carries a mark.
 *
 * Usage: node pr-review-clear-cli.js < payload.json
 *
 * payload { repoRoot, baseSha, headSha, lastReviewedSha?, ledger[], incoming?[] }
 *   repoRoot  REQUIRED git repository (or linked-worktree) root; no default to the cwd
 *   baseSha, headSha  REQUIRED full object ids; the head must descend from the base
 *   lastReviewedSha  the head the PRIOR round reviewed (the `reviewedHeadSha` its state report
 *             recorded: the value `review-range` is given). Every entry carried from that report
 *             was alive then, so what changed since is all that can have fixed it. Without it an
 *             entry's own `headSha` (when it has one) is the baseline: when the finding was first
 *             raised, a longer span that also counts an edit the finding survived
 *   ledger    REQUIRED entries recorded in earlier rounds
 *   incoming  the findings the review of `headSha` raised (what was handed to
 *             `ledger recordRound` as `incoming`); default []
 * result
 *   DERIVED (exit 0)  { ok, status, headSha, ledger[], cleared[{ id, clearedBy, recordedAt }],
 *                       kept[{ id, reason }] }
 *   FAILED  (exit 1)  { ok:false, status, reason }: bad input, head or base not commits of
 *                     this repository, head not descending from base. Nothing partial.
 *
 * The rule (what `clearFixedFindings` implements, with its facts read from git). For each
 * entry, in input order, the first match wins and the entry is kept as given:
 *   1. `cleared === true` already            -> already-cleared
 *   2. the baseline is this very head (own `headSha`, or `lastReviewedSha`: the same head
 *      reviewed again, nothing changed since)  -> recorded-at-this-head
 *   3. no baseline: no `lastReviewedSha` and no own `headSha` that is a commit
 *      -> no-recorded-head
 *   4. the baseline (`lastReviewedSha`, else the own head) not ON THE PR -> recorded-head-not-on-pr
 *      (an ancestor of head, not of base; a force-pushed old head is no longer an ancestor, and
 *      neither is a `lastReviewedSha` the repository no longer holds)
 *   5. re-reported at this head              -> re-reported: `incoming` holds the same
 *      `fingerprintFinding` identity (the LINE is not part of it, so a defect re-reported
 *      lower after the file shifted still counts), or, when either side has no fingerprint,
 *      the same exact `locationOrLink` + `failureMode`
 *   6. cites no file                         -> no-location
 *   7. `git diff` of the cited file from the baseline to this head cannot be read
 *      -> diff-failed; the cited line (or, for a file-only citation, any line) is untouched
 *      -> location-unchanged
 *   8. otherwise CLEARED: the original entry plus `cleared`, `clearedBy` (the full head id)
 *      and `clearedReason` as `clearFixedFindings` produced them (`not-cleared` if it
 *      declines).
 * Kept entries are returned exactly as given; the output ledger has the input's length and
 * order; a second run over its own output changes nothing; the input is never mutated.
 *
 * Honest limits: a changed location is the AC-008-3 heuristic, not proof the defect is
 * gone; the re-review not raising it again is the other half. A force-push that rewrites
 * the recorded head clears nothing, so such a bead stays open and a person closes it.
 */

const fs = require('fs');
const { isObjectId } = require('./pr-review-scope');
const { redact } = require('./pr-review-state');
const { anchorOf, clearFixedFindings, fingerprintFinding, fingerprintPath } = require('./pr-review-ledger');
const repo = require('./pr-review-repo');
const runtime = require('./review-record-runtime');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

function failed(reason) {
  return { ok: false, status: 'FAILED', reason };
}

/** The cited file and line of an entry: `{ file, line }`, `{ file, line: null }` (a file with no line) or `null`. */
function citedFile(entry) {
  const anchor = anchorOf(entry);
  if (anchor !== null) return { file: anchor.file, line: anchor.line };
  const file = fingerprintPath(entry);
  return file === null ? null : { file, line: null };
}

function reReported(entry, incoming) {
  const own = fingerprintFinding(entry);
  return incoming.some((other) => {
    const theirs = fingerprintFinding(other);
    if (own !== null && theirs !== null) return own === theirs;
    return other.locationOrLink === entry.locationOrLink && other.failureMode === entry.failureMode;
  });
}

/**
 * @param {{git?:Function, cwd:string, baseSha:string, headSha:string, lastReviewedSha?:string, ledger:Object[], incoming?:Object[], now?:Function}} input
 * @returns {Object} the DERIVED or FAILED result
 */
function deriveCleared(input) {
  const { cwd, baseSha, headSha, ledger } = input;
  const git = input.git || runtime.defaultGit();
  const incoming = input.incoming === undefined ? [] : input.incoming;
  const now = input.now || Date.now;

  const head = repo.resolveCommit(git, cwd, headSha);
  if (head === null || head !== headSha.toLowerCase()) return failed('headSha is not a commit of this repository');
  const base = repo.resolveCommit(git, cwd, baseSha);
  if (base === null || base !== baseSha.toLowerCase()) return failed('baseSha is not a commit of this repository');
  const descends = repo.isAncestor(git, cwd, base, head);
  if (descends === null) return failed('could not tell whether headSha descends from baseSha');
  if (descends === false) return failed('headSha does not descend from baseSha');

  // The prior round's reviewed head, when the caller has it: the one baseline every carried entry shares. An
  // object the repository no longer holds (a force-push replaced it) resolves to null: a baseline that is not on the PR.
  const shared = input.lastReviewedSha === undefined ? undefined : repo.resolveCommit(git, cwd, input.lastReviewedSha);

  const recordedAt = new Date(now()).toISOString();
  const cleared = [];
  const kept = [];
  const keep = (entry, reason) => {
    kept.push({ id: entry.id, reason });
    return entry;
  };

  const out = ledger.map((entry) => {
    if (entry.cleared === true) return keep(entry, 'already-cleared');
    const own = typeof entry.headSha === 'string' ? repo.resolveCommit(git, cwd, entry.headSha) : null;
    if (own === head) return keep(entry, 'recorded-at-this-head');
    const recorded = shared === undefined ? own : shared;
    if (recorded === null) return keep(entry, shared === undefined ? 'no-recorded-head' : 'recorded-head-not-on-pr');
    if (recorded === head) return keep(entry, 'recorded-at-this-head');
    if (!repo.commitOnPr(git, cwd, { commit: recorded, headSha: head, baseSha: base }).ok) {
      return keep(entry, 'recorded-head-not-on-pr');
    }
    if (reReported(entry, incoming)) return keep(entry, 're-reported');
    const cited = citedFile(entry);
    if (cited === null) return keep(entry, 'no-location');

    const changed = repo.changedOldLines(git, cwd, { from: recorded, to: head, file: cited.file });
    if (!changed.ok) return keep(entry, 'diff-failed');
    const { lines } = changed;
    const touched =
      cited.line === null ? lines === null || lines.length > 0 : lines === null || lines.includes(cited.line);
    if (!touched) return keep(entry, 'location-unchanged');

    const decision = clearFixedFindings({
      ledger: [entry],
      changedLocations: [{ path: cited.file, lines }],
      headSha: head,
      reReported: []
    });
    const mark = decision.ok === true ? decision.findings[0] : null;
    if (mark === null || mark.cleared !== true) return keep(entry, 'not-cleared');
    cleared.push({ id: entry.id, clearedBy: mark.clearedBy, recordedAt });
    return { ...entry, cleared: mark.cleared, clearedBy: mark.clearedBy, clearedReason: mark.clearedReason };
  });

  return { ok: true, status: 'DERIVED', headSha: head, ledger: out, cleared, kept };
}

/**
 * @param {Object} [io]  `{ readJson, emit, now, git }`, replaced by tests.
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

  const { repoRoot, baseSha, headSha, lastReviewedSha, ledger, incoming } = payload;
  if (!isText(repoRoot)) return finish(failed("'repoRoot' must be a non-empty path"));
  if (!isObjectId(baseSha)) return finish(failed("'baseSha' must be a full object id"));
  if (!isObjectId(headSha)) return finish(failed("'headSha' must be a full object id"));
  if (lastReviewedSha !== undefined && !isObjectId(lastReviewedSha)) {
    return finish(failed("'lastReviewedSha' must be a full object id when given"));
  }
  if (!Array.isArray(ledger) || !ledger.every(isObject)) return finish(failed("'ledger' must be an array of objects"));
  if (incoming !== undefined && (!Array.isArray(incoming) || !incoming.every(isObject))) {
    return finish(failed("'incoming' must be an array of objects when given"));
  }

  const { resolveProjectRootFlag } = require('./toolchain-cli');
  const resolved = resolveProjectRootFlag(repoRoot);
  if (resolved.error) return finish(failed(resolved.error.message));

  return finish(
    deriveCleared({
      git: io.git || runtime.defaultGit(),
      cwd: resolved.projectRoot,
      baseSha,
      headSha,
      lastReviewedSha,
      ledger,
      incoming: incoming === undefined ? [] : incoming,
      now
    })
  );
}

module.exports = { main, deriveCleared };

if (require.main === module) process.exit(main());
