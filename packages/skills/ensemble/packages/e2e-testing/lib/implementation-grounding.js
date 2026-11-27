'use strict';

/**
 * TRD-004: implementation-grounding lookup for /ensemble:author-playwright-tests.
 *
 * Given a REQ-NNN and a TRD path, resolves the real code that satisfies that
 * REQ so a later interactive session can ground a proposed Playwright test in
 * the actual implementing diff rather than PRD prose alone:
 *
 *   1. Parse the TRD (via ./trd-task-parser.js, in-process) to get `tasksById`.
 *   2. Find the task(s) whose `satisfies` includes the REQ.
 *   3. For each task's `targetFiles`, get that file's git diff on the current
 *      branch vs. its merge-base with main/origin main.
 *
 * TRD-033: this originally shelled out to packages/development/lib/trd-cli.js
 * via a hardcoded `path.resolve(__dirname, '../../development/lib/trd-cli.js')`
 * — correct only in the monorepo checkout, where e2e-testing and development
 * are sibling directories under a shared packages/ root. Once installed as
 * real, independently-published Claude Code plugins, they land in separate
 * top-level plugin-cache directories; that relative path resolves to a
 * location that never exists, and grounding failed outright, for every REQ,
 * unconditionally, the moment the plugin was actually installed (confirmed
 * live against a real, open PR in the consuming application: ENOENT resolving trd-cli.js — found live-
 * dogfooding this feature, same as the merge-base/ADO-status bugs it sits
 * beside). No Claude Code plugin-dependency mechanism guarantees a stable,
 * version-independent filesystem path between two separately-versioned
 * plugin installs, so no cross-package path could be made to work reliably
 * post-install. Fixed by porting a small, scoped parser
 * (./trd-task-parser.js) into this package instead — the same "slimmed-down
 * sibling, not imported cross-package" pattern packages/e2e-testing/lib/
 * prd-ac-parser.js already established for the PRD-parsing equivalent of
 * this exact problem.
 *
 * Implementation AC (TRD-004): a REQ whose implementing files can't be
 * located never silently returns nothing and never throws — it reports an
 * explicit grounding gap instead. Every early-exit path below returns a
 * `{grounded: false, gap: true, reason}` result rather than throwing.
 *
 * TRD-042 (found presenting coverage reports to a QA engineer: a bare "gap"
 * label doesn't say whether the problem is in the TRD's own planning or in
 * the code that plan describes): every structural gap also carries a
 * `gapType`, one of:
 *   - 'trd-gap' - the TRD itself doesn't say what implements this REQ at all
 *     (no task claims to satisfy it, a satisfying task declares no Target
 *     Files, or the TRD couldn't even be parsed/located) — the planning
 *     document has a hole, not the codebase.
 *   - 'code-gap' - the TRD DOES say what should implement this REQ (a task,
 *     with Target Files), but that code isn't actually there to ground a
 *     test in (files missing, never diffed vs. the base branch, or no
 *     merge-base could be resolved at all to diff against).
 * This is distinct from ac-gap-detector.js's semantic `'ac-gap'` (grounding
 * succeeded, but the grounded code doesn't satisfy the AC) and from
 * resume-scan.js's plain `'pending'` (grounded, AC satisfied, just no test
 * written yet — see author-playwright-tests.yaml's Phase 1 Step 2 for how
 * the orchestrator presents all four as one consistent vocabulary: TRD gap /
 * Code gap / AC gap / Test coverage gap).
 *
 * Follows the injectable-exec convention from ./pr-state.js so the sibling
 * TRD-004-TEST task can stub git / TRD-parsing / file-system calls.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');
const { parseTrdTasks } = require('./trd-task-parser');

const DEFAULT_BASE_BRANCH_CANDIDATES = ['main', 'origin/main'];

/** Default `git` invocation — swappable via `opts.gitExec` for tests. */
function defaultGitExec(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' });
}

/**
 * Default TRD parse — reads the TRD file and parses it in-process via
 * ./trd-task-parser.js's parseTrdTasks(). Swappable via `opts.parseTrd` for
 * tests. No subprocess, no cross-package path — see the module header for why.
 */
function defaultParseTrd(trdPath) {
  const text = fs.readFileSync(trdPath, 'utf8');
  return parseTrdTasks(text);
}

/**
 * Build the standard "grounding gap" result shape. Never throw — always this
 * instead. `gapType` ('trd-gap' | 'code-gap', TRD-042) categorizes WHY —
 * see the module header for the distinction.
 */
function gap(reqId, trdPath, reason, gapType) {
  return { grounded: false, gap: true, gapType, reqId, trdPath, reason };
}

/**
 * Resolve the merge-base SHA of HEAD against the first reachable candidate
 * branch (opts.baseBranch if given, else 'main' then 'origin/main').
 * Returns null (never throws) if none of the candidates resolve.
 *
 * When an explicit baseBranch is given, it's tried both bare and prefixed
 * with `origin/` (unless already so prefixed) — the same bare/origin-prefixed
 * pair the default candidates get. A PR's real target branch (e.g.
 * `integration` on a repo whose branches never target `main` directly)
 * is frequently unfetched locally; without the `origin/` fallback, grounding
 * failed outright instead of falling back the way the hardcoded default
 * already does for `main`.
 */
function resolveMergeBase(gitExec, baseBranch) {
  let candidates;
  if (baseBranch) {
    candidates = baseBranch.startsWith('origin/') ? [baseBranch] : [baseBranch, `origin/${baseBranch}`];
  } else {
    candidates = DEFAULT_BASE_BRANCH_CANDIDATES;
  }
  for (const branch of candidates) {
    try {
      const sha = gitExec(['merge-base', 'HEAD', branch]).trim();
      if (sha) return { branch, sha };
    } catch {
      // branch doesn't exist locally / no merge-base — try the next candidate
    }
  }
  return null;
}

/** Diff a single file between the merge-base SHA and HEAD. Returns null (not throw) on git failure. */
function diffFile(gitExec, mergeBaseSha, file) {
  try {
    return gitExec(['diff', mergeBaseSha, 'HEAD', '--', file]);
  } catch {
    return null;
  }
}

/**
 * Ground a REQ in its real implementing code.
 *
 * @param {string} reqId - e.g. "REQ-002"
 * @param {string} trdPath - path to the TRD markdown file
 * @param {object} [opts]
 * @param {(args: string[]) => string} [opts.gitExec] - injectable git runner
 * @param {(trdPath: string, opts: object) => object} [opts.parseTrd] - injectable TRD parser
 * @param {(p: string) => boolean} [opts.existsSync] - injectable fs.existsSync
 * @param {string} [opts.baseBranch] - override the branch to merge-base against
 * @returns {{grounded: true, reqId: string, files: string[], diffs: Array<{file:string, diff:string}>, partialGaps: string[]}
 *          | {grounded: false, gap: true, gapType: 'trd-gap'|'code-gap', reqId: string, trdPath: string, reason: string}}
 */
function groundImplementation(reqId, trdPath, opts = {}) {
  const gitExec = opts.gitExec || defaultGitExec;
  const parseTrd = opts.parseTrd || defaultParseTrd;
  const existsSync = opts.existsSync || fs.existsSync;

  if (!reqId) return gap(reqId, trdPath, 'No REQ id was provided', 'trd-gap');
  if (!trdPath) return gap(reqId, trdPath, 'No TRD path was provided', 'trd-gap');

  const normalizedReqId = String(reqId).toUpperCase();

  let trd;
  try {
    trd = parseTrd(trdPath, opts);
  } catch (err) {
    return gap(reqId, trdPath, `Failed to parse TRD '${trdPath}': ${err.message}`, 'trd-gap');
  }

  const tasksById = (trd && trd.tasksById) || {};
  const matchingTasks = Object.values(tasksById).filter(
    (task) => Array.isArray(task.satisfies) && task.satisfies.includes(normalizedReqId)
  );

  if (matchingTasks.length === 0) {
    return gap(reqId, trdPath, `No task in '${trdPath}' satisfies ${normalizedReqId}`, 'trd-gap');
  }

  const targetFiles = [];
  for (const task of matchingTasks) {
    for (const file of task.targetFiles || []) {
      if (!targetFiles.includes(file)) targetFiles.push(file);
    }
  }

  if (targetFiles.length === 0) {
    const taskIds = matchingTasks.map((t) => t.id).join(', ');
    return gap(
      reqId,
      trdPath,
      `${normalizedReqId} maps to task(s) ${taskIds} but none declare Target Files`,
      'trd-gap'
    );
  }

  const mergeBase = resolveMergeBase(gitExec, opts.baseBranch);
  if (!mergeBase) {
    return gap(reqId, trdPath, 'Could not resolve a merge-base branch (main/origin/main) to diff against', 'code-gap');
  }

  const diffs = [];
  const ungrounded = [];

  for (const file of targetFiles) {
    if (!existsSync(file)) {
      ungrounded.push(`${file} (not found on disk)`);
      continue;
    }
    const diff = diffFile(gitExec, mergeBase.sha, file);
    if (diff === null) {
      ungrounded.push(`${file} (git diff failed)`);
      continue;
    }
    if (diff.trim() === '') {
      ungrounded.push(`${file} (no diff vs ${mergeBase.branch} — never touched)`);
      continue;
    }
    diffs.push({ file, diff });
  }

  if (diffs.length === 0) {
    return gap(
      reqId,
      trdPath,
      `All target file(s) for ${normalizedReqId} are ungrounded: ${ungrounded.join('; ')}`,
      'code-gap'
    );
  }

  return {
    grounded: true,
    reqId: normalizedReqId,
    files: diffs.map((d) => d.file),
    diffs,
    // Files that were listed as Target Files but couldn't be grounded even
    // though the REQ overall was — surfaced rather than silently dropped.
    partialGaps: ungrounded,
  };
}

module.exports = {
  groundImplementation,
  // exported for unit testing of the helpers
  resolveMergeBase,
  diffFile,
};
