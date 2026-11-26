'use strict';

/**
 * TRD-006 (TRD-2026-d571763f): the texts the engine prints, each one kept exactly as the skill
 * prints it today.
 *
 * A thinned skill that delegates a decision to the engine must still print what it printed
 * before, so these constants are copied verbatim from their source file and carry its anchor.
 * The `ERROR: ` prefix is part of the text for that reason. A test asserts each constant is a
 * substring of the file cited above it; retyping one would make that test fail, which is the
 * point.
 *
 * Texts with no verbatim source are authored in the pattern of the nearest sourced sentence and
 * say so.
 */
/** phase-1-preflight.md:7 */
const PLAN_EXECUTE_EXCLUSIVE = "ERROR: --plan and --execute are mutually exclusive.";

/** phase-1-preflight.md:8 */
const GENERATE_ONLY_CONFLICT = "ERROR: --generate-only only generates the workstream TRD and cannot be combined with --plan, --execute, --status, --reset-task, --list, --branch or --use-current-branch.";

/** phase-1-preflight.md:9 */
const MULTIPLE_TRDS = "ERROR: Multiple TRDs passed directly (deprecated: it can lose fidelity). Run /ensemble:implement-trd-tasks --workstream --generate-only <trd1> <trd2> ... then run the generated workstream TRD, or rerun with --workstream.";

/** phase-1-preflight.md:11 */
const GENERATE_ONLY_REQUIRES_WORKSTREAM = "ERROR: --generate-only requires --workstream and two or more TRD paths.";

/** implement-trd-tasks-reference/SKILL.md:64 */
const EXECUTE_NEEDS_SCAFFOLD = "ERROR: --execute requires an existing bead scaffold. Run /ensemble:implement-trd-tasks --plan first.";

/** implement-trd-tasks-reference/SKILL.md:63 */
const WORKTREE_DIRTY = "ERROR: working directory is dirty. Commit, stash or revert before starting a new build.";

/**
 * Two flags that cannot be given together. Authored in the pattern of
 * phase-1-preflight.md:7, because phase-1-preflight.md:16 and
 * implement-trd-tasks-reference/SKILL.md:21 only say HALT and print no text.
 * @param {string} first
 * @param {string} second
 * @returns {string}
 */
function exclusive(first, second) {
  return `ERROR: ${first} and ${second} are mutually exclusive.`;
}

/** Both branch flags at once (phase-1-preflight.md:16). */
const BRANCH_FLAGS_EXCLUSIVE = exclusive('--branch', '--use-current-branch');

/**
 * `--use-current-branch` on a detached HEAD. Authored in the pattern of
 * phase-1-preflight.md:7 around the reference's own words, because
 * `implement-trd-tasks-reference/SKILL.md:26` quotes the reason and the way out
 * ("requires a current branch ... use --branch=<name>") but prints no full sentence.
 */
const DETACHED_HEAD =
  'ERROR: --use-current-branch requires a current branch, but HEAD is detached; use --branch=<name>.';

/**
 * A named or saved branch that does not exist locally, which the reference HALTs on
 * (`implement-trd-tasks-reference/SKILL.md:29`: "must already exist (switch to it), else HALT").
 * Authored in the pattern of phase-1-preflight.md:7, because that line prints no text.
 * @param {string} name the branch that was asked for
 * @returns {string}
 */
function branchNotFound(name) {
  return `ERROR: branch '${name}' does not exist locally. Create it first, or pass --use-proposed-branch to use the proposed branch.`;
}

/**
 * An agent the roster names that no runtime registered (phase-1-preflight.md:26, which prints
 * this sentence for `beads-build-wave`; the agent name is the only part that varies).
 * @param {string} name the unqualified agent name
 * @returns {string}
 */
function agentNotRegistered(name) {
  return `ERROR: agent ${name} is not registered in this session. Run /ensemble:reinstall-plugins and re-run.`;
}

/**
 * The reasons `validate-git-town.sh` gives for the two exit codes the skill halts on, quoted from
 * that script's own header (`packages/git/skills/git-town/scripts/validate-git-town.sh:13-14`).
 */
const GIT_TOWN_EXIT_REASONS = Object.freeze({
  3: 'git-town version too old (< 14.0.0)',
  4: 'not a git repository',
});

/**
 * git-town cannot be used here at all. Authored in the pattern of phase-1-preflight.md:7, because
 * `implement-trd-tasks-reference/SKILL.md:11` only says HALT and prints no text; the reason is
 * the script's own.
 * @param {number} exitCode 3 or 4
 * @returns {string}
 */
function gitTownUnusable(exitCode) {
  const reason = GIT_TOWN_EXIT_REASONS[exitCode] || 'validation failed';
  return `validate-git-town.sh exited ${exitCode} (${reason})`;
}

/**
 * The PR backend cannot be resolved and nobody can be asked. The three values and the "export one
 * in your shell profile" hint are what `implement-trd-tasks-reference/SKILL.md:15` prints in the
 * non-interactive case; the sentence is authored around them in that line's own wording.
 */
const PR_BACKEND_UNRESOLVED = [
  'PR backend resolution needed (unsupported host, no ENSEMBLE_PR_BACKEND set). Export one of the',
  'following in your shell profile, or pass --pr-backend <ado|manual|gh>:',
  '  ENSEMBLE_PR_BACKEND=ado',
  '  ENSEMBLE_PR_BACKEND=manual',
  '  ENSEMBLE_PR_BACKEND=gh',
].join('\n');

/**
 * The scaffold could not be planned. Authored: `phase-2-scaffold.md:17` says only "HALT" and
 * prints no text, so this follows the `ERROR: ` pattern of phase-1-preflight.md:7.
 * @param {string} trdPath
 * @param {string} detail the planner's own message
 * @returns {string}
 */
function scaffoldPlanFailed(trdPath, detail) {
  return `ERROR: could not plan the scaffold of '${trdPath}': ${detail}`;
}

/**
 * A bead could not be created. Authored: `phase-2-scaffold.md:17` says "HALT" and names no text.
 * The resume hint is the behaviour `implement-trd-tasks-reference/SKILL.md:66` promises.
 * @param {string} titlePrefix the bead that failed, named so the operator can find it
 * @param {string} detail the tracker's own message
 * @returns {string}
 */
function createFailed(titlePrefix, detail) {
  return `ERROR: could not create bead '${titlePrefix}': ${detail}. Nothing further was created; run it again to resume.`;
}

/**
 * A create succeeded but answered with no id. Authored, as `createFailed`.
 * @param {string} titlePrefix
 * @returns {string}
 */
function createNoId(titlePrefix) {
  return `ERROR: the tracker returned no id for bead '${titlePrefix}'. Nothing further was created; run it again to resume.`;
}

/**
 * The external-key lookup that precedes a create failed. Authored, as `createFailed`.
 * @param {string} titlePrefix
 * @param {string} detail
 * @returns {string}
 */
function lookupFailed(titlePrefix, detail) {
  return `ERROR: could not look up bead '${titlePrefix}' by its external key: ${detail}. Nothing further was created.`;
}

/**
 * Two beads carry the one external key. Authored around `tracker-findings.js:209`'s own text,
 * which `detail` carries verbatim.
 * @param {string} titlePrefix
 * @param {string} detail
 * @returns {string}
 */
function ambiguousKey(titlePrefix, detail) {
  return `ERROR: bead '${titlePrefix}': ${detail}`;
}

/**
 * The dependency edges could not be resolved against the created beads. Authored: the beads
 * exist, so the sentence says so rather than implying the scaffold is lost.
 * @param {string} detail
 * @returns {string}
 */
function depArgsFailed(detail) {
  return `ERROR: could not resolve the dependency edges: ${detail}. The beads exist; run it again to wire the edges.`;
}

/**
 * A capability this adapter cannot do. Authored in the pattern of `phase-2-scaffold.md:24`
 * ("warn once and skip the dependency wiring"), which names no text of its own.
 * @param {string} capability
 * @param {string} detail the runner's own message
 * @param {string} consequence what was skipped
 * @returns {string}
 */
function unavailableWarning(capability, detail, consequence) {
  return `${capability} unavailable (${detail}); ${consequence}`;
}

/**
 * A capability that exists and failed. Authored, as `unavailableWarning`.
 * @param {string} capability
 * @param {string} subject what it was called for
 * @param {string} detail the tracker's own message
 * @param {string} consequence
 * @returns {string}
 */
function failedWarning(capability, subject, detail, consequence) {
  return `${capability} failed for ${subject} (${detail}); ${consequence}`;
}

/**
 * More than one bead carries a title prefix. Authored: the idempotency rule of
 * `implement-trd-tasks-reference/SKILL.md:66` is by title prefix, so a duplicate makes the reuse
 * a choice, and a choice the operator cannot see is a silent one.
 * @param {string} prefix
 * @param {string[]} ids every bead carrying it
 * @param {string} reused the one that was reused
 * @returns {string}
 */
function duplicatePrefixWarning(prefix, ids, reused) {
  return `title prefix '${prefix}' is carried by ${ids.length} beads (${ids.join(', ')}); reusing ${reused}`;
}

/**
 * No bead of this TRD exists. Authored: `implement-trd-tasks-reference/SKILL.md:64` refuses
 * `--execute` without a scaffold in exactly this shape, and this verb reads the same scaffold.
 * @param {string} slug the TRD's slug
 * @returns {string}
 */
function notScaffolded(slug) {
  return `ERROR: no beads exist for TRD '${slug}'. Run /ensemble:implement-trd-tasks --plan first.`;
}

/**
 * The work graph is unsound. Authored: `phase-2-scaffold.md:26` halts on graph-health findings
 * and names `/ensemble:refine-beads` as the repair, but prints no text of its own.
 * @param {number} count how many findings
 * @returns {string}
 */
function workGraphFindings(count) {
  return `ERROR: work-graph reports ${count} finding(s). Fix the dependencies, or run /ensemble:refine-beads, before execution.`;
}

/**
 * A bead's reference block does not resolve. Authored: `bead-context` returns the reasons and
 * names none of its own, so each is listed under the `ERROR: ` pattern of phase-1-preflight.md:7.
 * @param {string} beadId the bead it refused
 * @param {string[]} missing its own reasons
 * @returns {string}
 */
function beadContextFailed(beadId, missing) {
  return [`ERROR: bead-context refused bead ${beadId}:`, ...missing.map(entry => `  ${entry}`)].join(
    '\n'
  );
}

/**
 * Open beads carry no `## References` block. Authored on the count-and-subject pattern of the
 * `phase-3-*.md:9` reference check, which reports the gap and does not halt.
 * @param {number} count how many open beads of this TRD
 * @returns {string}
 */
function referencesWarning(count) {
  return `${count} open bead(s) of this TRD have no '## References' block`;
}

/**
 * Beads of this TRD are unlabelled. Authored on the same pattern as `referencesWarning`
 * (`phase-3-*.md:8`), with the repair this verb itself offers.
 * @param {number} count how many beads
 * @param {string} label the label they should carry
 * @returns {string}
 */
function labelsWarning(count, label) {
  return `${count} bead(s) of this TRD do not carry the label '${label}'; run implement bead-health --label`;
}

/**
 * The tracker exposes no dependency data at all, so no edge can be compared. Authored, as
 * `unavailableWarning`: an unreadable edge set is not drift and must never be reported as drift.
 * @param {string} reason why no edge could be read
 * @returns {string}
 */
function edgesUnreadable(reason) {
  return `the tracker reports no dependency data (${reason}); the edge diff was skipped`;
}

/** implement-trd-tasks-reference/SKILL.md:69 */
const RESET_TASK_NOT_FOUND = "ERROR: No bead found for TASK_ID=<ID> with TRD_SLUG=<slug>";

/** implement-trd-tasks-reference/SKILL.md:69 */
const RESET_TASK_AMBIGUOUS = "ERROR: Multiple beads match — ambiguous TASK_ID, please be more specific";

/** implement-trd-tasks-reference/SKILL.md:73 */
const FOREMAN_TAGGING_INCOMPLETE = "ERROR: foreman-exec tagging incomplete";

/**
 * No bead carries this task id. The skill prints the placeholders literally
 * (implement-trd-tasks-reference/SKILL.md:69); the engine fills them in, so the operator reads
 * the id it actually looked for.
 * @param {string} taskId the task id asked for
 * @param {string} slug the TRD slug it was looked for under
 * @returns {string}
 */
function resetTaskNotFound(taskId, slug) {
  return RESET_TASK_NOT_FOUND.replace('<ID>', taskId).replace('<slug>', slug);
}

/**
 * The tracker lists fewer tagged beads than were tagged. The skill's own text
 * (implement-trd-tasks-reference/SKILL.md:73) is kept verbatim and both counts it names are
 * appended, because the text alone does not carry them.
 * @param {number} tagged how many beads this run tagged or found already tagged
 * @param {number} listed how many the tracker reports carrying the label afterwards
 * @returns {string}
 */
function foremanTaggingIncomplete(tagged, listed) {
  return `${FOREMAN_TAGGING_INCOMPLETE} (tagged ${tagged}, tracker.list reports ${listed})`;
}

/**
 * The labelling pass itself failed. Authored in the pattern of `createFailed`, naming the
 * subject and the tracker's own words.
 * @param {string} detail what the labeller reported
 * @returns {string}
 */
function labelFailed(detail) {
  return `ERROR: could not label the beads of this TRD: ${detail}`;
}

/**
 * One bead could not be tagged. Authored in the pattern of `createFailed`; it names the bead by
 * its title prefix and says the pass stopped, because a half-tagged run must not look complete.
 * @param {string} titlePrefix the bead's `[trd:...]` title prefix
 * @param {string} detail what the tracker reported
 * @returns {string}
 */
function foremanTaggingFailed(titlePrefix, detail) {
  return `ERROR: could not tag bead '${titlePrefix}' with foreman-exec: ${detail}. Nothing further was tagged.`;
}

/**
 * The status write of `reset-task` failed. Authored in the pattern of `createFailed`.
 * @param {string} beadId the bead that stayed as it was
 * @param {string} detail what the tracker reported
 * @returns {string}
 */
function resetTaskFailed(beadId, detail) {
  return `ERROR: could not set bead ${beadId} to open: ${detail}`;
}

// ---------------------------------------------------------------------------
// TRD-013: the quality gate.
//
// `skills/ensemble-implement-trd-tasks/references/phase-4-quality-gate.md`
// ---------------------------------------------------------------------------

/**
 * The result the gate records on a phase's story, verbatim from
 * `skills/ensemble-implement-trd-tasks/references/phase-4-quality-gate.md:9`.
 *
 * `PASS|FAIL` is the TEST run's result, not the gate's verdict: an informational strategy still
 * records `FAIL` for a failing suite, because the comment is the evidence of what the tests did.
 *
 * @param {boolean} success whether the suite passed
 * @param {number} passed
 * @param {number} total
 * @param {string} strategy
 * @returns {string}
 */
function qualityGateComment(success, passed, total, strategy) {
  return `Quality gate result: ${success ? 'PASS' : 'FAIL'} | passed: ${passed}/${total} | strategy: ${strategy}`;
}

/**
 * The checkpoint commit's subject, verbatim from `phase-4-quality-gate.md:10`.
 * @param {string} beadPrefix the story's `[trd:...]` prefix word
 * @param {number} phaseN
 * @param {number} passed
 * @param {number} total
 * @returns {string}
 */
function checkpointCommit(beadPrefix, phaseN, passed, total) {
  return `chore(${beadPrefix} ${phaseN}): checkpoint (tests pass; passed ${passed}/${total})`;
}

/**
 * The same checkpoint, when the gate recorded a failing suite as informational. Authored in the
 * shape of `checkpointCommit` (`phase-4-quality-gate.md:10`): the reference has one subject
 * because it only commits after a pass, and a commit that says "tests pass" when they did not
 * would make the history lie.
 * @param {string} beadPrefix
 * @param {number} phaseN
 * @param {number} passed
 * @param {number} total
 * @returns {string}
 */
function checkpointCommitInformational(beadPrefix, phaseN, passed, total) {
  return `chore(${beadPrefix} ${phaseN}): checkpoint (informational gate; passed ${passed}/${total})`;
}

/**
 * The same checkpoint, when the operator chose `skip` over a failing suite. Authored for the
 * same reason as `checkpointCommitInformational`.
 * @param {string} beadPrefix
 * @param {number} phaseN
 * @param {number} passed
 * @param {number} total
 * @returns {string}
 */
function checkpointCommitSkipped(beadPrefix, phaseN, passed, total) {
  return `chore(${beadPrefix} ${phaseN}): checkpoint (gate skipped; passed ${passed}/${total})`;
}

/**
 * The note the reference prints when `tracker.close-with-reason` is not available, verbatim from
 * `phase-4-quality-gate.md:10`.
 * @param {string} id the story bead
 * @returns {string}
 */
function closeWithReasonFallback(id) {
  return `(NOT_ALLOWED: use tracker.close --arg id=${id})`;
}

/**
 * No bead of this TRD exists at all. Authored: this verb's caller is a maintainer running
 * `ensemble`, so it names the verb that creates them rather than the slash command
 * `notScaffolded` names.
 * @param {string} slug
 * @returns {string}
 */
function gateNotScaffolded(slug) {
  return `no beads exist for TRD '${slug}'; run ensemble implement scaffold first`;
}

/**
 * A phase is complete but has no story to record the gate on. Authored: the reference assumes
 * the story exists (`phase-4-quality-gate.md:7`, "story = its story bead") and says nothing
 * about its absence, so the message names the exact title prefix that is missing.
 * @param {number} phaseN
 * @param {string} slug
 * @param {string} prFormat `phase` or `pr`
 * @returns {string}
 */
function storyNotFound(phaseN, slug, prFormat) {
  return `phase ${phaseN} of TRD '${slug}' has no story bead '[trd:${slug}:${prFormat}:${phaseN}]'`;
}

/**
 * The PR plan says nothing usable about this phase. Authored: `GATE_ACTION = PR_ACTIONS[N]`
 * (`phase-4-quality-gate.md:10`) has two documented branches, `createPr == false` and
 * `createPr == true`, and a third answer must stop rather than pick one.
 * @param {number} phaseN
 * @returns {string}
 */
function gateActionMissing(phaseN) {
  return `the PR plan has no gate action for phase ${phaseN}, or its createPr is neither true nor false`;
}

/**
 * The project has no usable test runner. Authored: the reference runs `test-runner.run`
 * (`phase-4-quality-gate.md:8`) and never contemplates its absence, and a gate that passed
 * because no tests could run is a check that cannot fail (Constitution Rule 7).
 * @param {string} detail what the toolchain reported
 * @returns {string}
 */
function testRunnerUnavailable(detail) {
  return `test-runner.run is unavailable: ${detail}`;
}

/**
 * The test run itself failed. Authored in the pattern of `testRunnerUnavailable`.
 * @param {string} detail
 * @returns {string}
 */
function testRunFailed(detail) {
  return `test-runner.run failed: ${detail}`;
}

/**
 * The runner answered something the category contract does not allow. Authored: the reference
 * parses `{success,passed,failed,skipped,total,duration,failures}` (`phase-4-quality-gate.md:8`)
 * and a missing count would silently become zero, which reads as a pass.
 * @returns {string}
 */
const TEST_RESULT_INVALID =
  'test-runner.run returned a result without a boolean success or non-negative integer passed, failed and total';

/**
 * The gate failed. Authored around the reference's own rule (`phase-4-quality-gate.md:9`: "Not
 * passed under tdd/refactor/bug-fix: print failures and pause for the user") and TRD:95's error
 * code `TESTS_FAILED`; the failures are named so the refusal says what to fix.
 * @param {number} phaseN
 * @param {{failed: number, failures: string[], strategy: string, total: number}} detail
 * @returns {string}
 */
function testsFailed(phaseN, { failed, failures, strategy, total }) {
  const named = failures.length > 0 ? `: ${failures.join('; ')}` : '';
  return `quality gate failed for phase ${phaseN}: ${failed} of ${total} test(s) failed under strategy ${strategy}${named}`;
}

/** What a non-interactive run under a pausing strategy adds to `testsFailed`. Authored. */
const ON_FAILURE_HINT = '; in an interactive run pass --on-failure fix, skip or abort';

/**
 * The operator chose `abort`. Authored from the reference's `fix / skip / abort` pause
 * (`phase-4-quality-gate.md:9`), which names the options and no text.
 * @param {number} phaseN
 * @returns {string}
 */
function gateAborted(phaseN) {
  return `quality gate aborted for phase ${phaseN} by --on-failure abort`;
}

/**
 * The result could not be recorded. Authored: the reference records before it closes
 * (`phase-4-quality-gate.md:9` then :10), so a failed record stops the run rather than closing
 * a story whose evidence was never written.
 * @param {string} id the story bead
 * @param {string} detail
 * @returns {string}
 */
function commentFailed(id, detail) {
  return `recording the quality gate result on story ${id} failed: ${detail}`;
}

/**
 * The composed closure reason is shorter than policy allows. Authored: the reference's own
 * floor is the literal `>=40-char reason` of `phase-4-quality-gate.md:10`, which this engine
 * makes a policy value (`closure_reason_min_length`) rather than a constant.
 * @param {string} id the story bead
 * @param {number} length the reason's length
 * @param {number} min the policy minimum
 * @returns {string}
 */
function closureReasonTooShort(id, length, min) {
  return `the closure reason for ${id} is ${length} characters; closure_reason_min_length is ${min}`;
}

/**
 * The close itself failed. Authored in the pattern of `createFailed`.
 * @param {string} id the story bead
 * @param {string} detail
 * @returns {string}
 */
function storyCloseFailed(id, detail) {
  return `closing story ${id} failed: ${detail}`;
}

/**
 * Someone else's work is already staged. Authored: `beads-stage` scopes the EXPORT to this TRD
 * (`phase-4-quality-gate.md:10`) but cannot unstage a file somebody added by hand, and the
 * checkpoint commit would carry it.
 * @param {string[]} paths the foreign paths
 * @returns {string}
 */
function stagedForeignPaths(paths) {
  return `the index already holds paths this commit must not carry: ${paths.join(', ')}; unstage them and re-run`;
}

/**
 * Staging this TRD's beads failed after the story was already closed. Authored: the close
 * happens before the stage in the reference's own order (`phase-4-quality-gate.md:10`), so the
 * message says what was already done and the exact commands that finish it.
 * @param {string} slug
 * @param {string} detail
 * @returns {string}
 */
function beadsStageFailed(slug, detail) {
  return `trd-cli beads-stage failed: ${detail}; the story is closed, finish with: trd-cli beads-stage --match "[trd:${slug}" then workflow.commit`;
}

/**
 * The checkpoint commit failed after the story was already closed. Authored for the same reason
 * as `beadsStageFailed`.
 * @param {string} slug
 * @param {string} detail
 * @returns {string}
 */
function commitFailed(slug, detail) {
  return `workflow.commit failed: ${detail}; the story is closed, finish with: trd-cli beads-stage --match "[trd:${slug}" then workflow.commit`;
}

/**
 * `workflow.merge-base` answered no sha. Authored: the reference reads HEAD_SHA from it
 * (`phase-4-quality-gate.md:10`) and a close recorded against an empty commit would point at
 * nothing.
 */
const HEAD_UNRESOLVED = 'workflow.merge-base returned no HEAD sha';

/**
 * Why a passing phase's story was closed. Authored: the reference requires a reason of at least
 * 40 characters (`phase-4-quality-gate.md:10`) and supplies no text, so this states the two
 * facts that justify the close -- the tests and the task beads.
 * @param {number} phaseN
 * @param {{passed: number, slug: string, strategy: string, total: number}} detail
 * @returns {string}
 */
function closureReasonPassed(phaseN, { passed, slug, strategy, total }) {
  return `Quality gate passed for phase ${phaseN} of TRD ${slug}: ${passed}/${total} tests under strategy ${strategy}; every task bead in the phase is closed.`;
}

/**
 * Why a phase whose tests failed under an informational strategy was still closed. Authored in
 * the pattern of `closureReasonPassed`: the reason must not claim a pass that did not happen.
 * @param {number} phaseN
 * @param {{failed: number, slug: string, strategy: string, total: number}} detail
 * @returns {string}
 */
function closureReasonInformational(phaseN, { failed, slug, strategy, total }) {
  return `Quality gate recorded ${failed} of ${total} failing test(s) for phase ${phaseN} of TRD ${slug} as informational under strategy ${strategy}; every task bead in the phase is closed.`;
}

/**
 * Why a phase the operator chose to skip over was closed. Authored in the pattern of
 * `closureReasonPassed`; it names the choice, so the history says who decided.
 * @param {number} phaseN
 * @param {{failed: number, slug: string, total: number}} detail
 * @returns {string}
 */
function closureReasonSkipped(phaseN, { failed, slug, total }) {
  return `Quality gate skipped for phase ${phaseN} of TRD ${slug} after ${failed} of ${total} failing test(s), by operator choice; every task bead in the phase is closed.`;
}

/**
 * What happens next in stacked mode. Authored from `phase-4-quality-gate.md:11`, which keeps the
 * story open and runs a pre-PR test gate and a local review -- both later verbs' work.
 * @param {string} id the story bead
 * @param {string} branch the phase's branch
 * @returns {string}
 */
function stackedNext(id, branch) {
  return `story ${id} stays open: run the pre-PR test run and local review on branch ${branch} next`;
}

/** No phase is waiting for a gate. Authored. */
const NO_GATE_CANDIDATE = 'no complete phase is waiting for a quality gate';

/**
 * completion-verification/SKILL.md:84 -- the skill writes this reason inside a shell-quoted
 * string, so the file spells the inner quotes `\"`; the text the skill prints is this one.
 */
const PARSE_FAILED_CLI = 'node "$TRD_CLI" parse exited non-zero or returned malformed JSON';

/** completion-verification/SKILL.md:93 */
const TASKS_BY_ID_EMPTY = 'tasksById is empty';

/** completion-verification/SKILL.md:272 */
const VERDICT_COMPLETE = '**VERDICT: COMPLETE (0 gaps)**';

/**
 * phase-5-completion.md:8
 * @param {number} gapCount
 * @param {string} reportPath
 * @returns {string}
 */
function completionFailed(gapCount, reportPath) {
  return `COMPLETION VERIFICATION FAILED: ${gapCount} gap(s) found. Report: ${reportPath}`;
}

/**
 * phase-5-completion.md:9
 * @param {string} reportPath
 * @returns {string}
 */
function completionPassed(reportPath) {
  return `Completion verification: PASSED (0 gaps). Report: ${reportPath}`;
}

/**
 * completion-verification/SKILL.md:97
 * @param {number} parsed how many tasks the parser returned
 * @param {number} independent how many task-shaped checkbox lines a raw grep found
 * @returns {string}
 */
function parseCountMismatch(parsed, independent) {
  return `deterministic parser found ${parsed} task(s) but a raw grep of the TRD file found ${independent} task-shaped checkbox line(s) — the parser silently missed real tasks (check for a formatting deviation such as a missing **bold** wrap around a task id)`;
}

/**
 * completion-verification/SKILL.md:89
 * @param {string} warning
 * @returns {string}
 */
function parserWarning(warning) {
  return `parser warning: '${warning}'`;
}

/**
 * completion-verification/SKILL.md:143
 * @param {string} prdReference
 * @returns {string}
 */
function prdUnresolvable(prdReference) {
  return `PRD reference '${prdReference}' could not be resolved to a file`;
}

/**
 * completion-verification/SKILL.md:176
 * @param {string} prdPath the resolved PRD path
 * @param {number} count how many REQ ids it holds
 * @returns {string}
 */
function reqPriorityUnparsed(prdPath, count) {
  return `${prdPath}: ${count} REQ(s), none with a MoSCoW priority`;
}

/**
 * completion-verification/SKILL.md:261
 * @param {string} req
 * @param {string} priority
 * @returns {string}
 */
function reqUnsatisfied(req, priority) {
  return `${req} (${priority}): no closed satisfying task`;
}

/**
 * completion-verification/SKILL.md:255
 * @param {string} id
 * @returns {string}
 */
function taskStillOpen(id) {
  return `${id}: still open`;
}

/**
 * completion-verification/SKILL.md:258
 * @param {string} id the implementation task whose test pair is open
 * @returns {string}
 */
function testPairOpen(id) {
  return `${id} closed without ${id}-TEST closed`;
}

/**
 * completion-verification/SKILL.md:278
 * @param {number} gapCount
 * @returns {string}
 */
function verdictIncomplete(gapCount) {
  return `**VERDICT: INCOMPLETE (${gapCount} gaps found)**`;
}

module.exports = {
  BRANCH_FLAGS_EXCLUSIVE,
  DETACHED_HEAD,
  EXECUTE_NEEDS_SCAFFOLD,
  FOREMAN_TAGGING_INCOMPLETE,
  GIT_TOWN_EXIT_REASONS,
  GENERATE_ONLY_CONFLICT,
  GENERATE_ONLY_REQUIRES_WORKSTREAM,
  HEAD_UNRESOLVED,
  MULTIPLE_TRDS,
  NO_GATE_CANDIDATE,
  ON_FAILURE_HINT,
  PARSE_FAILED_CLI,
  PLAN_EXECUTE_EXCLUSIVE,
  PR_BACKEND_UNRESOLVED,
  RESET_TASK_AMBIGUOUS,
  RESET_TASK_NOT_FOUND,
  TASKS_BY_ID_EMPTY,
  TEST_RESULT_INVALID,
  VERDICT_COMPLETE,
  WORKTREE_DIRTY,
  agentNotRegistered,
  ambiguousKey,
  beadContextFailed,
  beadsStageFailed,
  branchNotFound,
  checkpointCommit,
  checkpointCommitInformational,
  checkpointCommitSkipped,
  closeWithReasonFallback,
  closureReasonInformational,
  closureReasonPassed,
  closureReasonSkipped,
  closureReasonTooShort,
  commentFailed,
  commitFailed,
  completionFailed,
  completionPassed,
  createFailed,
  createNoId,
  depArgsFailed,
  duplicatePrefixWarning,
  edgesUnreadable,
  exclusive,
  failedWarning,
  foremanTaggingFailed,
  foremanTaggingIncomplete,
  gateAborted,
  gateActionMissing,
  gateNotScaffolded,
  gitTownUnusable,
  labelFailed,
  labelsWarning,
  lookupFailed,
  notScaffolded,
  parseCountMismatch,
  parserWarning,
  prdUnresolvable,
  qualityGateComment,
  referencesWarning,
  reqPriorityUnparsed,
  reqUnsatisfied,
  resetTaskFailed,
  resetTaskNotFound,
  scaffoldPlanFailed,
  stackedNext,
  stagedForeignPaths,
  storyCloseFailed,
  storyNotFound,
  taskStillOpen,
  testPairOpen,
  testRunFailed,
  testRunnerUnavailable,
  testsFailed,
  verdictIncomplete,
  workGraphFindings,
  unavailableWarning,
};
