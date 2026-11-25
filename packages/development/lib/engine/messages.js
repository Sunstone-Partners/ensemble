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

module.exports = {
  BRANCH_FLAGS_EXCLUSIVE,
  DETACHED_HEAD,
  EXECUTE_NEEDS_SCAFFOLD,
  FOREMAN_TAGGING_INCOMPLETE,
  GIT_TOWN_EXIT_REASONS,
  GENERATE_ONLY_CONFLICT,
  GENERATE_ONLY_REQUIRES_WORKSTREAM,
  MULTIPLE_TRDS,
  PLAN_EXECUTE_EXCLUSIVE,
  PR_BACKEND_UNRESOLVED,
  RESET_TASK_AMBIGUOUS,
  RESET_TASK_NOT_FOUND,
  WORKTREE_DIRTY,
  agentNotRegistered,
  ambiguousKey,
  beadContextFailed,
  branchNotFound,
  createFailed,
  createNoId,
  depArgsFailed,
  duplicatePrefixWarning,
  edgesUnreadable,
  exclusive,
  failedWarning,
  foremanTaggingFailed,
  foremanTaggingIncomplete,
  gitTownUnusable,
  labelFailed,
  labelsWarning,
  lookupFailed,
  notScaffolded,
  referencesWarning,
  resetTaskFailed,
  resetTaskNotFound,
  scaffoldPlanFailed,
  workGraphFindings,
  unavailableWarning,
};
