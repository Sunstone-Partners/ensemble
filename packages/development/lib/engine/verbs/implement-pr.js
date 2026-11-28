'use strict';

/**
 * TRD-018 (TRD-2026-d571763f): `ensemble implement pr <trd> (--phase <N> | --completion)` -- the
 * phase and completion pull requests of `skills/implement-trd-tasks-reference/SKILL.md` section 3
 * and `phase-5-completion.md` Step 5.4.
 *
 * The verb does every mechanical step and asks the model for exactly one thing: the Risk and
 * How-to-revert prose (role `pr-prose`). In order:
 *
 * 1. Resolve the plan entry (`PR_ACTIONS[N]` or the completion entry), the branching strategy and
 *    the PR backend. Nothing is passed in that the plan or the environment already says.
 * 2. Run the FULL test suite. A red suite stops here, before any prose is requested or any
 *    branch is pushed (`phase-4-quality-gate.md:11`).
 * 3. Take the accepted `pr-prose` result for this HEAD, or hand the step out and stop.
 * 4. Render the body from `templates/pr-body.md`, grade it with the PR-description grader as an
 *    agent-authored body, and refuse a body that fails -- the prose is inserted exactly as
 *    accepted, never repaired to pass.
 * 5. Open the pull request through the backend, or return what a person (or the Azure DevOps
 *    tool) must run. `manual` pushes and creates nothing.
 *
 * The verb owns no state (Constitution Rule 4): the tracker, git, the plan and the toolchain say
 * everything it reports. It does not close a story, commit, or run a review -- those are the
 * gate's, `implement close`'s and `review run`'s -- and it never says a PR was merged: opening a
 * pull request is not landing it.
 */

const fs = require('fs');
const path = require('path');

const MESSAGES = require('../messages');
const { handOff, readAccepted } = require('../handoff');
const { currentBranch, gitProbe, remoteDefaultBranch } = require('../git');
const { loadPolicy } = require('../policy');
const { gateAction, completionAction, savedPlan } = require('../pr-plan');
const { isResult, refused, unavailable } = require('../result');
const { strategyFor } = require('../strategy');
const { callCapability, classify, isClosed, readIssues, scopeBeads } = require('../tracker');
const { readFrontmatter, readParsedTrd, requireTrd } = require('../trd-source');
const { runPhaseTests } = require('./implement-gate');
const { resolveBackends } = require('./implement-env');
const { checkDescription } = require('../../pr-review-description');
const { isUnsupportedForgeHost } = require('../../pr-strategy');

/** A GitHub login, the shape the PR-description grader reads a `Directed by:` line as. */
const LOGIN_RE = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/;

/** Where the body template is read from, a data path the vendor bundle carries beside this file. */
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'pr-body.md');

/** The Azure DevOps tool call the hand-off names (`SKILL.md:44`). */
const ADO_CREATE_CALL = 'repo_create_pull_request';

/** What the body says where the test runner reports no coverage figure. */
const COVERAGE_NOT_MEASURED = 'Unit: not measured, Integration: not measured (the test runner reports no coverage).';

/** The `text` of a single-quoted shell word. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Fill the body template. One pass over the placeholders, so a `{{...}}` inside inserted text is
 * left exactly as it was written rather than expanded again.
 * @param {Record<string, string>} values
 * @returns {string}
 */
function renderBody(values) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return template
    .replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match))
    .trimEnd()
    .concat('\n');
}

/**
 * The commit a PR's diff starts from: where `HEAD` left `base`. The remote-tracking ref is the
 * fallback, because a fresh clone may hold only `origin/<base>`.
 * @returns {string|object} the sha, or a tagged engine result
 */
function mergeBaseSha(call, base) {
  for (const ref of [base, `origin/${base}`]) {
    const resolved = gitProbe(call, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (isResult(resolved)) return resolved;
    if (resolved.exit === 1) continue;
    const common = gitProbe(call, ['merge-base', resolved.stdout.trim(), 'HEAD']);
    if (isResult(common)) return common;
    if (common.exit === 1) continue;
    return common.stdout.trim();
  }
  return refused('BASE_UNRESOLVED', MESSAGES.prBaseUnresolved(base), { base });
}

/**
 * A toolchain capability whose answer must be `ok`. A refusal the toolchain issued (preflight,
 * confirmation, allowlist) is returned unchanged; an outage stays an outage.
 * @returns {{data: *}|object} the answer, or a tagged engine result
 */
function mustRun(call, capability, args, failureCode) {
  const answer = classify(callCapability(call, capability, args), capability);
  if (answer.kind === 'ok') return { data: answer.data };
  if (answer.kind === 'gate') return answer.result;
  if (answer.kind === 'unavailable') return unavailable(`${failureCode}_UNAVAILABLE`, answer.message);
  return refused(`${failureCode}_FAILED`, answer.message);
}

/** The PR url a creation answer carries, or `null`. */
function urlOf(data) {
  const url = data && typeof data === 'object' ? data.url : null;
  return typeof url === 'string' && url.trim().length > 0 ? url.trim() : null;
}

/**
 * Everything the body and the PR are built from that only the repository can say.
 * @returns {object|object} the facts, or a tagged engine result
 */
function readFacts(call, { completion, phaseN, slug, trdPath, parsed, policy, warnings }) {
  const listed = readIssues(call, { all: true });
  if (isResult(listed)) return listed;
  const beads = scopeBeads(listed.issues, slug);
  if (beads.length === 0) return refused('NOT_SCAFFOLDED', MESSAGES.gateNotScaffolded(slug));

  const strategy = strategyFor(call, {
    frontmatter: readFrontmatter(path.resolve(call.projectRoot, trdPath)).frontmatter,
    parsed,
    policy,
    strategyArgument: undefined,
    warnings,
  });

  if (completion) {
    const epic = beads.find(bead => bead.kind === 'epic');
    if (!epic) return refused('EPIC_NOT_FOUND', `no root epic bead for TRD ${slug} is in the tracker`);
    const phases = parsed.phases || [];
    const taskCount = Object.keys(parsed.tasksById || {}).length;
    return {
      header: `Implements TRD ${slug}. Strategy: ${strategy.strategy}. ${phases.length} phases, ${taskCount} tasks — all complete. Bead: ${epic.id}.`,
      strategy: strategy.strategy,
    };
  }

  const story = beads.find(bead => {
    const match = bead.kind === 'story' && /:(?:phase|pr):(\d+)\]/.exec(bead.prefix || '');
    return match && Number(match[1]) === phaseN;
  });
  if (!story) return refused('STORY_NOT_FOUND', MESSAGES.storyNotFound(phaseN, slug, 'phase'));
  const inPhase = new Set((parsed.phases || []).find(phase => Number(phase.n) === phaseN)?.taskIds || []);
  const done = beads
    .filter(bead => bead.taskId && inPhase.has(bead.taskId) && isClosed(bead))
    .map(bead => bead.taskId);
  return { phaseStory: story.id, strategy: strategy.strategy, tasks: done };
}

/**
 * The body of a pull request from its parts, graded before anything leaves the repository.
 * @returns {string|object} the body, or a tagged refusal naming what the grader found missing
 */
function buildBody(values) {
  // The Directed by line sits under the last section, and the grader reads everything up to the
  // next heading as that section's content: an empty How to revert would be filled in by it. So
  // the two sections the model wrote are graded on their own first, which is what makes "how to
  // revert said nothing" a failure the grader can see.
  const prose = checkDescription({
    agentAuthored: false,
    body: `## Testing\n${values.TESTING}\n\n## Risk\n${values.RISK}\n\n## How to revert\n${values.HOW_TO_REVERT}\n`,
  });
  const body = renderBody(values);
  const grade = checkDescription({ agentAuthored: true, body });
  const missing = [...new Set([...(prose.ready ? [] : prose.missing), ...(grade.ready ? [] : grade.missing)])];
  if (missing.length > 0) {
    return refused('PR_BODY_GRADE_FAILED', MESSAGES.prBodyGradeFailed(missing), {
      empty: [...new Set([...prose.empty, ...grade.empty])],
      missing,
    });
  }
  return body;
}

/**
 * What a person must run to open this PR, and the stacked-append that follows it.
 */
function manualCommands({ base, body, branch, remoteUrl, title }) {
  const create = isUnsupportedForgeHost(remoteUrl)
    ? `az repos pr create --source-branch ${shellQuote(branch)} --target-branch ${shellQuote(base)} --title ${shellQuote(title)} --description ${shellQuote(body)}`
    : `gh pr create --base ${shellQuote(base)} --head ${shellQuote(branch)} --title ${shellQuote(title)} --body ${shellQuote(body)}`;
  return [`git push -u origin ${shellQuote(branch)}`, create];
}

/**
 * Append the next stacked branch (`SKILL.md:49`), after the PR exists.
 *
 * Plain git branches off the current HEAD through the capability. git-town has no capability for a
 * stacked append, so the engine returns its native command rather than calling one that would cut
 * the new branch from the trunk. `manual` never creates anything, and neither does a run whose PR
 * was not confirmed created: the instruction is returned for later.
 */
function appendNext(call, { backend, created, next, strategy, warnings }) {
  if (typeof next !== 'string' || next.length === 0) return null;
  const command = strategy === 'git-town' ? `git town append ${shellQuote(next)}` : `git switch -c ${shellQuote(next)}`;
  const instruction = { branch: next, command, performed: false };
  // Only a confirmed creation moves HEAD: after a hand-off, a failed create or a manual run the
  // pull request does not exist yet, and a switched branch would break the retry (BRANCH_MISMATCH).
  if (!created || backend === 'manual' || strategy === 'git-town') return instruction;
  const made = classify(callCapability(call, 'workflow.branch-create', { name: next }), 'workflow.branch-create');
  if (made.kind === 'ok') return { ...instruction, performed: true };
  if (made.kind === 'gate') return made.result;
  warnings.push(`the next stacked branch '${next}' was not created (${made.message}); run: ${command}`);
  return instruction;
}

/**
 * Open the PR through the backend.
 * @returns {{created: boolean, url: string|null, handoff: object|null, commands: string[], note: string|null}|object}
 */
function openPullRequest(call, input) {
  const { backend, base, body, branch, remoteUrl, strategy, title, adoTool } = input;
  const commands = manualCommands({ base, body, branch, remoteUrl, title });
  const none = { commands: [], created: false, handoff: null, note: null, url: null };

  if (backend === 'manual') return { ...none, commands };

  if (backend === 'gh' && strategy === 'git-town') {
    // The reference sends no body through `propose` (SKILL.md:42).
    const proposed = mustRun(call, 'workflow.propose', { baseBranch: base, headBranch: branch, title }, 'PR_CREATE');
    if (isResult(proposed)) return proposed;
    return { ...none, created: true, url: urlOf(proposed.data) };
  }

  const pushed = mustRun(call, 'workflow.push', { branch }, 'PUSH');
  if (isResult(pushed)) return pushed;

  if (backend === 'ado' && typeof adoTool === 'string' && adoTool.length > 0) {
    return {
      ...none,
      handoff: {
        arguments: {
          description: body,
          sourceRefName: `refs/heads/${branch}`,
          targetRefName: `refs/heads/${base}`,
          title,
        },
        call: ADO_CREATE_CALL,
        tool: adoTool,
      },
    };
  }

  const args = { baseBranch: base, headBranch: branch, title, description: body };
  if (backend !== 'ado') {
    const created = mustRun(call, 'host.change-request-create', args, 'PR_CREATE');
    if (isResult(created)) return created;
    return { ...none, created: true, url: urlOf(created.data) };
  }

  // `ado` with no Azure DevOps tool connected: the change-request capability, and a failure
  // there is instructions for a person, not a refusal (SKILL.md:44).
  const answer = classify(callCapability(call, 'host.change-request-create', args), 'host.change-request-create');
  if (answer.kind === 'ok') return { ...none, created: true, url: urlOf(answer.data) };
  if (answer.kind === 'gate') return answer.result;
  return { ...none, commands: commands.slice(1), note: MESSAGES.prManualInstructions(answer.message) };
}

/**
 * @param {object} call the dispatcher's call object
 * @returns {object} the PR report, or a tagged engine result
 */
function handler(call) {
  const { input } = call;
  const completion = input.completion === true;
  const phaseN = input.phase;
  if (completion === (phaseN !== undefined)) {
    return refused('PR_TARGET_REQUIRED', MESSAGES.PR_TARGET_REQUIRED);
  }

  const rawLogin = input['directed-by'];
  if (typeof rawLogin !== 'string' || !LOGIN_RE.test(rawLogin.replace(/^@/, ''))) {
    return refused('DIRECTED_BY_REQUIRED', MESSAGES.directedByRequired(typeof rawLogin === 'string' ? rawLogin : null));
  }
  const directedBy = rawLogin.replace(/^@/, '');

  const trd = requireTrd(call);
  if (isResult(trd)) return trd;
  const trdPath = trd.path;
  const label = completion ? 'the completion' : `phase ${phaseN}`;

  const plan = savedPlan(call, trdPath);
  if (isResult(plan)) return plan;
  const action = completion ? completionAction(plan) : gateAction(plan, phaseN);
  if (!action || typeof action.createPr !== 'boolean') {
    return refused('PR_ACTION_MISSING', completion ? 'the PR plan has no completion entry' : MESSAGES.gateActionMissing(phaseN));
  }
  if (action.createPr !== true) return refused('PR_NOT_DUE', MESSAGES.prNotDue(label));

  const branch = currentBranch(call);
  if (isResult(branch)) return branch;
  const planned = typeof action.branch === 'string' ? action.branch : '';
  if (branch === '' || (planned !== '' && planned !== branch)) {
    return refused('BRANCH_MISMATCH', MESSAGES.prBranchMismatch(planned || '<a branch>', branch), { branch, planned });
  }

  const env = resolveBackends(call, input['pr-backend']);
  if (isResult(env)) return env;
  const backend = env.backend.backend;
  const strategy = env.branching.strategy;
  const warnings = [...env.warnings];

  // The full suite, before any prose is requested or anything is pushed.
  const tests = runPhaseTests(call, { file: '.', framework: input.framework });
  if (isResult(tests)) return tests;
  if (!tests.success) {
    return refused('TESTS_FAILED', MESSAGES.PR_TESTS_FAILED, {
      failed: tests.failed,
      failures: tests.failures,
      passed: tests.passed,
      total: tests.total,
    });
  }

  const base = (typeof action.parentBranch === 'string' && action.parentBranch) || remoteDefaultBranch(call);
  const baseSha = mergeBaseSha(call, base);
  if (isResult(baseSha)) return baseSha;

  const parsed = readParsedTrd(call, trdPath);
  if (isResult(parsed)) return parsed;
  const slug = String(parsed.slug || '');
  const policy = loadPolicy({ projectRoot: call.projectRoot }).values;
  const facts = readFacts(call, { completion, parsed, phaseN, policy, slug, trdPath, warnings });
  if (isResult(facts)) return facts;

  const head = gitProbe(call, ['rev-parse', 'HEAD']);
  if (isResult(head)) return head;
  // The step id carries the HEAD it was dispatched at, so a record from an earlier HEAD can
  // never be mistaken for this one and a fresh hand-off never collides with it.
  const stepLabel = `${completion ? 'completion' : `phase-${phaseN}`}-${head.stdout.trim().slice(0, 12)}`;
  const accepted = readAccepted(call, { step: `pr-prose--${stepLabel}` });
  if (isResult(accepted)) return accepted;
  if (accepted === null) {
    return handOff(call, {
      agents: [{ brief: { base: baseSha, branch }, label: stepLabel, name: 'prose' }],
      role: 'pr-prose',
    });
  }

  const title =
    (typeof action.proposeTitle === 'string' && action.proposeTitle) ||
    (completion ? `Implement ${slug}` : `Phase ${phaseN} of ${slug}`);
  const header = completion
    ? facts.header
    : [
        `PR/Phase ${phaseN} of TRD ${slug}.`,
        `**Shippable:** ${(typeof action.shippableState === 'string' && action.shippableState) || 'See TRD for scope'}`,
        `Strategy: ${facts.strategy}. Tasks: ${facts.tasks.join(', ')}. Bead: ${facts.phaseStory}.`,
      ].join('\n');
  const body = buildBody({
    DIRECTED_BY: directedBy,
    HEADER: header,
    HOW_TO_REVERT: accepted.result.howToRevert,
    RISK: accepted.result.risk,
    TESTING: `test-runner.run, full suite: PASSED (${tests.passed}/${tests.total}). ${COVERAGE_NOT_MEASURED}`,
  });
  if (isResult(body)) return body;

  const opened = openPullRequest(call, {
    adoTool: input['ado-tool'],
    backend,
    base,
    body,
    branch,
    remoteUrl: env.remoteUrl,
    strategy,
    title,
  });
  if (isResult(opened)) return opened;
  if (opened.created && opened.url === null) {
    warnings.push('the pull request was opened but the host reported no URL; read it from the host');
  }

  const appended = completion
    ? null
    : appendNext(call, { backend, created: opened.created, next: action.appendNextBranch, strategy, warnings });
  if (isResult(appended)) return appended;

  return {
    ADO_HANDOFF: opened.handoff,
    APPEND: appended,
    BACKEND: backend,
    BASE: base,
    BODY: body,
    BRANCH: branch,
    BRANCHING_STRATEGY: strategy,
    COMMANDS: opened.commands,
    NEXT: nextText({ appended, opened }),
    NOTE: opened.note,
    PHASE_PR_MAP: !completion && opened.url !== null ? { [String(phaseN)]: opened.url } : {},
    PR_CREATED: opened.created,
    PR_URL: opened.url,
    TARGET: completion ? 'completion' : 'phase',
    TITLE: title,
    WARNINGS: warnings,
  };
}

/** What the caller does next. Says nothing about review outcome or landing: the PR is only open. */
function nextText({ appended, opened }) {
  const later = appended ? `; once it exists, run: ${appended.command}` : '';
  if (opened.handoff) return `create the pull request with the ${opened.handoff.tool} ${opened.handoff.call} call named in ADO_HANDOFF${later}`;
  if (opened.created) {
    return appended && appended.performed === false
      ? `the pull request is open for review; then run: ${appended.command}`
      : 'the pull request is open for review';
  }
  if (opened.commands.length > 0) return `run COMMANDS in order; nothing was created by the engine${later}`;
  return 'no pull request was opened';
}

const spec = {
  exitCodes: [0, 1, 2, 3, 4, 5],
  group: 'implement',
  handler,
  inputSchema: {
    additionalProperties: false,
    properties: {
      'ado-tool': { minLength: 1, type: 'string' },
      completion: { type: 'boolean' },
      'directed-by': { type: 'string' },
      framework: { enum: ['jest', 'pytest', 'exunit', 'xunit', 'rspec'], type: 'string' },
      phase: { minimum: 1, type: 'integer' },
      'pr-backend': { enum: ['gh', 'ado', 'manual'], type: 'string' },
      trd: { type: 'string', 'x-operand': true },
    },
    type: 'object',
  },
  name: 'pr',
  outputSchema: {
    additionalProperties: false,
    properties: {
      ADO_HANDOFF: {
        oneOf: [
          {
            additionalProperties: false,
            properties: {
              arguments: { type: 'object' },
              call: { type: 'string' },
              tool: { type: 'string' },
            },
            required: ['arguments', 'call', 'tool'],
            type: 'object',
          },
          { type: 'null' },
        ],
      },
      APPEND: {
        oneOf: [
          {
            additionalProperties: false,
            properties: {
              branch: { type: 'string' },
              command: { type: 'string' },
              performed: { type: 'boolean' },
            },
            required: ['branch', 'command', 'performed'],
            type: 'object',
          },
          { type: 'null' },
        ],
      },
      BACKEND: { enum: ['gh', 'ado', 'manual'], type: 'string' },
      BASE: { type: 'string' },
      BODY: { type: 'string' },
      BRANCH: { type: 'string' },
      BRANCHING_STRATEGY: { enum: ['git-town', 'plain-git'], type: 'string' },
      CHOICE: {
        additionalProperties: false,
        properties: {
          flag: { type: ['string', 'null'] },
          id: { type: 'string' },
          options: {
            items: {
              additionalProperties: false,
              properties: {
                args: { items: { type: 'string' }, type: 'array' },
                label: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['args', 'label', 'value'],
              type: 'object',
            },
            type: 'array',
          },
          question: { type: 'string' },
        },
        required: ['flag', 'id', 'options', 'question'],
        type: 'object',
      },
      COMMANDS: { items: { type: 'string' }, type: 'array' },
      NEXT: { type: 'string' },
      NOTE: { type: ['string', 'null'] },
      PHASE_PR_MAP: { additionalProperties: { type: 'string' }, type: 'object' },
      PR_CREATED: { type: 'boolean' },
      PR_URL: { type: ['string', 'null'] },
      TARGET: { enum: ['phase', 'completion'], type: 'string' },
      TITLE: { type: 'string' },
      WARNINGS: { items: { type: 'string' }, type: 'array' },
    },
    // A `NEEDS_CHOICE` answer carries only `CHOICE`; a `NEEDS_AGENT` one is the hand-off manifest.
    required: [],
    type: 'object',
  },
  policyKeys: ['constitution_methodology', 'default_strategy', 'strategy_detection'],
  sideEffect: 'write',
  summary: 'open the pull request for a phase or the completed TRD, with the model supplying only Risk and How to revert',
};

module.exports = { spec };
