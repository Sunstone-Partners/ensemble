'use strict';

/**
 * TRD-015 (TRD-2026-d571763f): `ensemble implement close`, `sync-checkboxes`, `report`, and the
 * `pr-review` read of the completion review (phase-5-completion.md).
 *
 * `close` is the one verb that ends a run. It refuses -- before any change -- unless every
 * precondition holds, and it never reads one from a caller's say-so:
 *
 *  1. completion verification (`runVerification`, the same recipe `implement verify` runs) says
 *     `COMPLETE`, or an interactive operator passed `--override-incomplete`. A non-interactive
 *     `INCOMPLETE` is refused whatever flag came with it;
 *  2. no task or story bead of the TRD is open, and the listing that says so could be read;
 *  3. unless the saved plan is stacked AND its completion action says `createPr: false`, the
 *     whole-branch local review recorded for `<slug>-completion` is `LOCAL_REVIEW_COMPLETE` for
 *     the head being closed. A missing completion action, a missing, unparseable or stale review
 *     state, and any other review status are refusals -- never a skip.
 *
 * Then the closure ordering of `closure.js`: head sha, reason checked against policy, epic closed
 * with that reason and sha, tracker flushed, this TRD's beads staged, commit.
 *
 * Every verdict here is the engine's own reading of the tracker, the TRD and the recorded review;
 * nothing is taken from an earlier phase's claim.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { assertIndexClean, closeBead, composeReason, flushTracker, headSha, stageAndCommit } = require('../closure');
const { runTrd } = require('../cli-json');
const { currentBranch, git } = require('../git');
const { resolveInteractivity } = require('../interactivity');
const MESSAGES = require('../messages');
const { completionAction, savedPlan } = require('../pr-plan');
const { STRATEGIES, loadPolicy } = require('../policy');
const { isResult, refused } = require('../result');
const { strategyFor } = require('../strategy');
const { isClosed, isTaskLevel, readIssues, scopeBeads } = require('../tracker');
const { readFrontmatter, readParsedTrd, requireTrd } = require('../trd-source');
const { requirementGaps, runVerification } = require('../verification');
const { deriveStatus } = require('../../pr-review-status');
const { readState, statePath } = require('../../pr-review-state');

/** The commit `sync-checkboxes` makes. Fixed: the history reads the same on every run. */
const SYNC_COMMIT_MESSAGE = 'chore(trd): sync Master Task List checkboxes with closed beads';

/** The commit `close` makes after the epic is closed. */
function closeCommitMessage(slug) {
  return `chore(trd): close ${slug} epic after completion verification`;
}

/**
 * The tracker's own failure to list is never an empty list: a failure that is not already a
 * refusal is turned into one, because the verb must act as if beads remained (TRD-015).
 *
 * @param {object} result a tagged engine result from `readIssues`
 * @returns {object} a REFUSED result
 */
function listingRefusal(result) {
  if (result.status === 'REFUSED') return result;
  return refused(
    'BEAD_LISTING_FAILED',
    `the tracker's bead listing could not be read, so open beads cannot be ruled out: ${result.message || result.code}`,
    { cause: result.code }
  );
}

/**
 * The parsed TRD, or null when the parser cannot be trusted to have read it (a verification gap,
 * not a crash).
 * @param {object} call
 * @param {string} trdPath
 * @returns {object|null}
 */
function parseTrd(call, trdPath) {
  const result = runTrd(call, ['parse', trdPath]);
  if (!result.json || result.json.ok !== true || !result.json.trd) return null;
  return result.json.trd;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * The completion review of one PR id, read from its recorded state and re-derived through the one
 * status function. Fail closed: only a state recorded for this head (or this head's tree) whose
 * recorded AND re-derived local phase are both `LOCAL_REVIEW_COMPLETE` is complete.
 *
 * @param {object} call
 * @param {string} prId
 * @returns {object} a tagged engine result, or the review reading
 */
function readReview(call, prId) {
  const sha = headSha(call);
  if (isResult(sha)) return sha;
  const tree = git(call, ['rev-parse', 'HEAD^{tree}']);
  const treeSha = typeof tree === 'string' ? tree.trim() : undefined;
  const reportPath = statePath(prId, call.projectRoot);
  const read = readState(reportPath, sha, { cwd: call.projectRoot, treeSha });

  const base = { HEAD_SHA: sha, PR_ID: prId, REPORT_PATH: path.relative(call.projectRoot, reportPath) };
  if (!read || read.ok !== true) {
    return {
      ...base,
      REASONS: [`review state unreadable: ${(read && read.reason) || 'no answer'}`],
      STATE: 'unreadable',
    };
  }
  if (!read.exists) {
    return { ...base, REASONS: [`no review state recorded for ${prId}`], STATE: 'missing' };
  }
  if (read.discarded || !read.state) {
    return {
      ...base,
      REASONS: [`the recorded review of ${prId} was made for a different head`],
      STATE: 'stale',
    };
  }
  const derived = deriveStatus(read.state);
  const complete =
    read.state.localPhase === 'LOCAL_REVIEW_COMPLETE' && derived.localPhase === 'LOCAL_REVIEW_COMPLETE';
  return {
    ...base,
    LOCAL_PHASE: derived.localPhase,
    NEXT: derived.next,
    REASONS: Array.isArray(derived.reasons) ? derived.reasons.map(String) : [],
    REMOTE_PHASE: derived.remotePhase,
    STATE: complete ? 'complete' : 'incomplete',
    STATUS: derived.status,
  };
}

/** Whether the completion action lets this run skip the whole-branch review. */
function reviewSkippable(plan, completion) {
  return plan.stacked === true && completion !== null && completion.createPr === false;
}

// --------------------------------------------------------------------------------- close

function closeHandler(call) {
  const trd = requireTrd(call);
  if (isResult(trd)) return trd;
  const trdPath = trd.path;

  const { interactive } = resolveInteractivity({ env: call.env, globals: call.globals });
  const policy = loadPolicy({ projectRoot: call.projectRoot });
  if (isResult(policy)) return policy;
  const min = policy.values.closure_reason_min_length;

  const parsed = parseTrd(call, trdPath);
  const text = fs.readFileSync(path.resolve(call.projectRoot, trdPath), 'utf8');
  const slug = String((parsed && parsed.slug) || require('../trd-source').slugOf(trdPath));

  const listed = readIssues(call, { all: true });
  if (isResult(listed)) return listingRefusal(listed);
  const beads = scopeBeads(listed.issues, slug);

  // 1. Completion verification: the sole authority, run before anything changes.
  const report = runVerification(call, { beads, parsed, slug, text, trdPath });
  if (isResult(report)) return report;
  const overridden = report.verdict !== 'COMPLETE';
  if (overridden) {
    if (!interactive) {
      return refused('COMPLETION_INCOMPLETE', MESSAGES.completionFailed(report.gapCount, report.reportPath), {
        gaps: report.gaps,
        reportPath: report.reportPath,
      });
    }
    if (call.input['override-incomplete'] !== true) {
      return refused(
        'COMPLETION_INCOMPLETE',
        `${MESSAGES.completionFailed(report.gapCount, report.reportPath)} (pass --override-incomplete to close anyway)`,
        { gaps: report.gaps, reportPath: report.reportPath }
      );
    }
  }

  // 2. Open beads: an open task or story, whatever the verdict or override, stops the close.
  const open = beads.filter(bead => bead.kind !== 'epic' && !isClosed(bead));
  if (open.length > 0) {
    return refused(
      'OPEN_BEADS',
      `${open.length} task or story bead(s) of ${slug} are still open: ${open.map(b => b.id).join(', ')}`,
      { open: open.map(b => b.id) }
    );
  }
  const epics = beads.filter(bead => bead.kind === 'epic');
  if (epics.length === 0) {
    return refused('EPIC_NOT_FOUND', `${slug} has no epic bead to close`);
  }
  const epic = epics.find(bead => !isClosed(bead));
  if (!epic) {
    return refused('EPIC_ALREADY_CLOSED', `the epic of ${slug} is already closed`);
  }

  // 3. The whole-branch review, unless the plan itself says completion opens no PR.
  const plan = savedPlan(call, trdPath);
  if (isResult(plan)) return plan;
  const completion = completionAction(plan);
  let review = null;
  if (completion === null) {
    return refused(
      'COMPLETION_ACTION_MISSING',
      `the PR plan of ${slug} carries no completion action, so the review gate cannot be decided`
    );
  }
  if (!reviewSkippable(plan, completion)) {
    review = readReview(call, `${slug}-completion`);
    if (isResult(review)) return review;
    if (review.STATE !== 'complete') {
      return refused(
        'COMPLETION_REVIEW_NOT_COMPLETE',
        `the whole-branch local review of ${slug} must be LOCAL_REVIEW_COMPLETE before closing (${review.STATE}: ${review.REASONS.join('; ')})`,
        review
      );
    }
  }

  // Closure, in the order closure.js fixes.
  const sha = review ? review.HEAD_SHA : headSha(call);
  if (isResult(sha)) return sha;
  const reasonText = `epic ${epic.id} closed: TRD ${slug} completion ${
    overridden ? `OVERRIDDEN with ${report.gapCount} gap(s)` : 'verified with 0 gaps'
  } at HEAD ${sha}`;
  const reason = composeReason(epic.id, reasonText, min);
  if (isResult(reason)) return reason;

  const staged = assertIndexClean(call, []);
  if (staged) return staged;

  const closed = closeBead(call, { commit: sha, id: epic.id, reason });
  if (isResult(closed)) return closed;
  const warnings = [];
  const flushWarning = flushTracker(call);
  if (flushWarning) warnings.push(flushWarning);

  const commit = stageAndCommit(call, { message: closeCommitMessage(slug), slug });
  if (isResult(commit)) return commit;

  return {
    COMMIT: commit,
    EPIC_ID: epic.id,
    HEAD_SHA: sha,
    MESSAGE: overridden ? MESSAGES.completionFailed(report.gapCount, report.reportPath) : MESSAGES.completionPassed(report.reportPath),
    MODE: plan.stacked ? 'stacked' : 'single-pr',
    OVERRIDDEN: overridden,
    REASON: reason,
    REPORT_PATH: report.reportPath,
    REVIEW: review ? review.STATE : 'skipped',
    TRD_FILE_PATH: trdPath,
    TRD_SLUG: slug,
    VERDICT: report.verdict,
    WARNINGS: warnings,
    fallback: closed.fallback === true,
  };
}

// ----------------------------------------------------------------------- sync-checkboxes

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Flip `- [ ] **ID**` to `- [x] **ID**` for each closed id.
 * @param {string} text
 * @param {string[]} ids
 * @returns {{changed: string[], text: string}}
 */
function flipCheckboxes(text, ids) {
  const changed = [];
  let next = text;
  for (const id of ids) {
    const re = new RegExp(`^(\\s*[-*] )\\[ \\](\\s+\\*\\*${escapeRegExp(id)}\\*\\*)`, 'm');
    if (re.test(next)) {
      next = next.replace(re, '$1[x]$2');
      changed.push(id);
    }
  }
  return { changed, text: next };
}

function syncHandler(call) {
  const trd = requireTrd(call);
  if (isResult(trd)) return trd;
  const trdPath = trd.path;
  const absolute = path.resolve(call.projectRoot, trdPath);

  const parsed = readParsedTrd(call, trdPath);
  if (isResult(parsed)) return parsed;
  const slug = String(parsed.slug || require('../trd-source').slugOf(trdPath));

  const before = fs.readFileSync(absolute, 'utf8');
  const hash = sha256(before);
  const expected = call.input['expect-hash'];
  if (typeof expected === 'string' && expected !== '' && expected !== hash) {
    return refused('TRD_CHANGED', `${trdPath} changed since it was read (hash ${hash} does not match ${expected})`);
  }

  const listed = readIssues(call, { all: true });
  if (isResult(listed)) return listingRefusal(listed);
  const beads = scopeBeads(listed.issues, slug);
  const closedIds = [
    ...new Set(beads.filter(b => isTaskLevel(b.kind) && isClosed(b) && b.taskId).map(b => b.taskId)),
  ];

  const flipped = flipCheckboxes(before, closedIds);
  if (flipped.changed.length === 0) {
    return {
      CHANGED: [],
      COMMIT: null,
      HASH_AFTER: hash,
      HASH_BEFORE: hash,
      TRD_FILE_PATH: trdPath,
      TRD_SLUG: slug,
    };
  }

  // The file must still be what was read: a change in between is someone else's edit.
  const current = fs.readFileSync(absolute, 'utf8');
  if (sha256(current) !== hash) {
    return refused('TRD_CHANGED', `${trdPath} changed since it was read; nothing was written`);
  }
  const staged = assertIndexClean(call, [trdPath]);
  if (staged) return staged;

  fs.writeFileSync(absolute, flipped.text);
  const commit = stageAndCommit(call, { extraPaths: [trdPath], message: SYNC_COMMIT_MESSAGE, slug });
  if (isResult(commit)) return commit;

  return {
    CHANGED: flipped.changed,
    COMMIT: commit,
    HASH_AFTER: sha256(flipped.text),
    HASH_BEFORE: hash,
    TRD_FILE_PATH: trdPath,
    TRD_SLUG: slug,
  };
}

// ------------------------------------------------------------------------------- report

function reportHandler(call) {
  const trd = requireTrd(call);
  if (isResult(trd)) return trd;
  const trdPath = trd.path;
  const warnings = [];

  const policy = loadPolicy({ projectRoot: call.projectRoot });
  if (isResult(policy)) return policy;

  const parsed = readParsedTrd(call, trdPath);
  if (isResult(parsed)) return parsed;
  const slug = String(parsed.slug || require('../trd-source').slugOf(trdPath));

  const listed = readIssues(call, { all: true });
  if (isResult(listed)) return listed;
  const beads = scopeBeads(listed.issues, slug);

  const beadByTask = new Map();
  for (const bead of beads) {
    if (isTaskLevel(bead.kind) && bead.taskId && !beadByTask.has(bead.taskId)) beadByTask.set(bead.taskId, bead);
  }
  const tasks = beads.filter(b => isTaskLevel(b.kind));
  const closedTasks = tasks.filter(isClosed).length;
  const epic = beads.find(b => b.kind === 'epic') || null;

  const requirements = requirementGaps({
    beadByTask,
    projectRoot: call.projectRoot,
    slug,
    tasksById: parsed.tasksById || {},
    trd: parsed,
    trdPath,
  });
  const rows = (requirements.rows || []).map(row => ({
    priority: row.priority,
    req: row.req,
    status: row.status === 'SATISFIED' ? 'SATISFIED' : 'NOT VERIFIED',
    tasks: row.tasks,
  }));

  const branch = currentBranch(call);
  if (isResult(branch)) return branch;

  const strategy = strategyFor(call, {
    frontmatter: readFrontmatter(path.resolve(call.projectRoot, trdPath)).frontmatter,
    parsed,
    policy: policy.values,
    strategyArgument: call.input.strategy,
    warnings,
  });

  let status = 'IN-PROGRESS';
  if (epic && isClosed(epic)) status = 'CLOSED';
  else if (tasks.length > 0 && closedTasks === tasks.length) status = 'READY-TO-CLOSE';

  return {
    BRANCH: branch,
    EPIC_ID: epic ? epic.id : null,
    REQUIREMENTS: rows,
    STATUS: status,
    STRATEGY: strategy.strategy,
    STRATEGY_SOURCE: strategy.source,
    TOTALS: {
      requirements: rows.length,
      satisfied: rows.filter(r => r.status === 'SATISFIED').length,
      tasks: tasks.length,
      tasksClosed: closedTasks,
    },
    TRD_FILE_PATH: trdPath,
    TRD_SLUG: slug,
    WARNINGS: warnings,
  };
}

// ----------------------------------------------------------------------------- pr-review

function prReviewHandler(call) {
  const trd = requireTrd(call);
  if (isResult(trd)) return trd;
  const trdPath = trd.path;
  const parsed = readParsedTrd(call, trdPath);
  if (isResult(parsed)) return parsed;
  const slug = String(parsed.slug || require('../trd-source').slugOf(trdPath));

  const phase = call.input.phase;
  const prId = Number.isInteger(phase) ? `${slug}-phase-${phase}` : `${slug}-completion`;
  const review = readReview(call, prId);
  if (isResult(review)) return review;
  return { ...review, TRD_FILE_PATH: trdPath, TRD_SLUG: slug };
}

// -------------------------------------------------------------------------------- specs

const TRD_INPUT = { type: 'string', 'x-operand': true };

const COMMIT_SCHEMA = {
  additionalProperties: false,
  properties: {
    committed: { type: 'boolean' },
    reason: { type: ['string', 'null'] },
    sha: { type: ['string', 'null'] },
  },
  required: ['committed', 'reason', 'sha'],
  type: 'object',
};

const closeSpec = {
  exitCodes: [0, 1, 2, 4, 5],
  group: 'implement',
  handler: closeHandler,
  inputSchema: {
    additionalProperties: false,
    properties: { 'override-incomplete': { type: 'boolean' }, trd: TRD_INPUT },
    type: 'object',
  },
  name: 'close',
  outputSchema: {
    additionalProperties: false,
    properties: {
      COMMIT: COMMIT_SCHEMA,
      EPIC_ID: { type: 'string' },
      HEAD_SHA: { type: 'string' },
      MESSAGE: { type: 'string' },
      MODE: { enum: ['single-pr', 'stacked'], type: 'string' },
      OVERRIDDEN: { type: 'boolean' },
      REASON: { type: 'string' },
      REPORT_PATH: { type: 'string' },
      REVIEW: { enum: ['complete', 'skipped'], type: 'string' },
      TRD_FILE_PATH: { type: 'string' },
      TRD_SLUG: { type: 'string' },
      VERDICT: { enum: ['COMPLETE', 'INCOMPLETE'], type: 'string' },
      WARNINGS: { items: { type: 'string' }, type: 'array' },
      fallback: { type: 'boolean' },
    },
    required: [],
    type: 'object',
  },
  policyKeys: ['closure_reason_min_length'],
  sideEffect: 'write',
  summary: 'close the TRD epic after completion verification, the review gate and the open-bead check',
};

const syncSpec = {
  exitCodes: [0, 1, 2, 4, 5],
  group: 'implement',
  handler: syncHandler,
  inputSchema: {
    additionalProperties: false,
    properties: { 'expect-hash': { type: 'string' }, trd: TRD_INPUT },
    type: 'object',
  },
  name: 'sync-checkboxes',
  outputSchema: {
    additionalProperties: false,
    properties: {
      CHANGED: { items: { type: 'string' }, type: 'array' },
      COMMIT: { oneOf: [COMMIT_SCHEMA, { type: 'null' }] },
      HASH_AFTER: { type: 'string' },
      HASH_BEFORE: { type: 'string' },
      TRD_FILE_PATH: { type: 'string' },
      TRD_SLUG: { type: 'string' },
    },
    required: [],
    type: 'object',
  },
  policyKeys: [],
  sideEffect: 'write',
  summary: "tick the Master Task List checkbox of every task whose bead is closed and commit it with the TRD's beads",
};

const reportSpec = {
  exitCodes: [0, 1, 2, 5],
  group: 'implement',
  handler: reportHandler,
  inputSchema: {
    additionalProperties: false,
    properties: { strategy: { enum: [...STRATEGIES], type: 'string' }, trd: TRD_INPUT },
    type: 'object',
  },
  name: 'report',
  outputSchema: {
    additionalProperties: false,
    properties: {
      BRANCH: { type: 'string' },
      EPIC_ID: { type: ['string', 'null'] },
      REQUIREMENTS: {
        items: {
          additionalProperties: false,
          properties: {
            priority: { type: ['string', 'null'] },
            req: { type: 'string' },
            status: { enum: ['SATISFIED', 'NOT VERIFIED'], type: 'string' },
            tasks: { type: 'array' },
          },
          required: ['req', 'status'],
          type: 'object',
        },
        type: 'array',
      },
      STATUS: { enum: ['IN-PROGRESS', 'READY-TO-CLOSE', 'CLOSED'], type: 'string' },
      STRATEGY: { type: 'string' },
      STRATEGY_SOURCE: { type: 'string' },
      TOTALS: { type: 'object' },
      TRD_FILE_PATH: { type: 'string' },
      TRD_SLUG: { type: 'string' },
      WARNINGS: { items: { type: 'string' }, type: 'array' },
    },
    required: [],
    type: 'object',
  },
  policyKeys: ['strategy_detection'],
  sideEffect: 'read',
  summary: 'report the TRD status, branch, strategy, epic id and per-requirement SATISFIED or NOT VERIFIED',
};

const prReviewSpec = {
  exitCodes: [0, 1, 2, 5],
  group: 'implement',
  handler: prReviewHandler,
  inputSchema: {
    additionalProperties: false,
    properties: { phase: { type: 'integer' }, trd: TRD_INPUT },
    type: 'object',
  },
  name: 'pr-review',
  outputSchema: {
    additionalProperties: false,
    properties: {
      HEAD_SHA: { type: 'string' },
      LOCAL_PHASE: { type: 'string' },
      NEXT: { type: ['string', 'null'] },
      PR_ID: { type: 'string' },
      REASONS: { items: { type: 'string' }, type: 'array' },
      REMOTE_PHASE: { type: ['string', 'null'] },
      REPORT_PATH: { type: 'string' },
      STATE: { enum: ['complete', 'incomplete', 'missing', 'stale', 'unreadable'], type: 'string' },
      STATUS: { type: 'string' },
      TRD_FILE_PATH: { type: 'string' },
      TRD_SLUG: { type: 'string' },
    },
    required: [],
    type: 'object',
  },
  policyKeys: [],
  sideEffect: 'read',
  summary: 'read the recorded local review of the completion (or one phase) and its derived status',
};

const specs = [closeSpec, syncSpec, reportSpec, prReviewSpec];

module.exports = { flipCheckboxes, specs, spec: closeSpec };
