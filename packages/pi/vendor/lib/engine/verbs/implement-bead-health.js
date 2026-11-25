'use strict';

/**
 * TRD-012 (TRD-2026-d571763f): `ensemble implement bead-health <trd>`.
 *
 * What the beads of a TRD are now, against what `trd-cli scaffold-calls` says they should be.
 * The plan is the plan of record here exactly as it is in `implement scaffold`, so the two
 * verbs can never disagree about which beads and which edges a TRD has.
 *
 * The verb owns no state of its own (Constitution Rule 4): the tracker's contents are the
 * state, read fresh on every run. Every gate -- preflight, confirmation, allowlist -- belongs to
 * `toolchain-cli` and is returned unchanged rather than degraded around (Rule 5).
 *
 * The report itself is read-only. The three write flags are the repairs the report names:
 * `--label` backfills the TRD's scoping label, `--foreman` tags the beads a build dispatches and
 * `--reset-task` reopens one task bead. Each one runs only after every check that could refuse
 * the run has passed, so a run that refuses has written nothing.
 *
 * The verb is declared `sideEffect: 'write'` for every run, flags or not, because a verb that
 * changed its declared side effect with a flag would let a write slip past the gates that the
 * declaration selects.
 */

const MESSAGES = require('../messages');
const { isResult, refused, unavailable } = require('../result');
const { runTrd } = require('../cli-json');
const {
  callCapability,
  classify,
  depIdOf,
  isClosed,
  isTaskLevel,
  readIssues,
  scopeBeads,
} = require('../tracker');
const { requireTrd, slugOf } = require('../trd-source');
const { parseReferencesBlock } = require('../../bead-refs');

/** The two capabilities the work-graph step runs, in order. */
const WORK_GRAPH_CAPABILITIES = ['work-graph.plan', 'work-graph.graph-health'];

/** `blocked|blocker`, the key both the planned and the live edge sets are held under. */
function edgeKey(blocked, blocker) {
  return `${blocked}|${blocker}`;
}

/** Edges sorted by blocked, then blocker, so two runs of the same tracker read the same. */
function sortEdges(edges) {
  return edges.sort((a, b) =>
    edgeKey(a.blocked, a.blocker).localeCompare(edgeKey(b.blocked, b.blocker))
  );
}

/**
 * Every live dependency link of the scoped beads, as `blockedId|blockerId` keys.
 *
 * The rows are tried first because a tracker whose `list` carries the links needs no further
 * read; `tracker.show` is the fallback for the trackers whose list carries only a count. When
 * neither answers, the result says so: an unreadable edge set is not drift, and reporting every
 * planned edge as missing would send an operator to repair a tracker that is intact.
 *
 * @param {object} call the dispatcher's call object
 * @param {object[]} beads the scoped beads
 * @returns {{live: Set<string>, reason: string|null, source: 'list'|'show'|null}|object}
 */
function readLiveEdges(call, beads) {
  const fromRows = beads.filter(bead => Array.isArray(bead.dependencies));
  if (fromRows.length > 0) {
    return { live: collectEdges(fromRows), reason: null, source: 'list' };
  }

  // The probe: one read decides whether this tracker exposes the links at all.
  const probe = classify(
    callCapability(call, 'tracker.show', { id: beads[0].id }),
    'tracker.show'
  );
  if (probe.kind === 'gate') return probe.result;
  if (probe.kind === 'unreadable') {
    return unavailable('TRACKER_UNREADABLE', probe.message);
  }
  if (probe.kind !== 'ok') {
    return { live: new Set(), reason: probe.message, source: null };
  }
  if (!Array.isArray(probe.data && probe.data.dependencies)) {
    return {
      live: new Set(),
      reason: `tracker.show for ${beads[0].id} carries no 'dependencies'`,
      source: null,
    };
  }

  const detailed = [{ dependencies: probe.data.dependencies, id: beads[0].id }];
  for (const bead of beads.slice(1)) {
    const shown = classify(callCapability(call, 'tracker.show', { id: bead.id }), 'tracker.show');
    if (shown.kind === 'gate') return shown.result;
    if (shown.kind === 'unreadable') return unavailable('TRACKER_UNREADABLE', shown.message);
    if (shown.kind !== 'ok') {
      return { live: new Set(), reason: shown.message, source: null };
    }
    detailed.push({ dependencies: shown.data && shown.data.dependencies, id: bead.id });
  }
  return { live: collectEdges(detailed), reason: null, source: 'show' };
}

/** The `blockedId|blockerId` keys of every readable dependency entry. */
function collectEdges(items) {
  const edges = new Set();
  for (const item of items) {
    for (const entry of Array.isArray(item.dependencies) ? item.dependencies : []) {
      const blocker = depIdOf(entry);
      if (blocker === null) continue;
      edges.add(edgeKey(item.id, blocker));
    }
  }
  return edges;
}

/**
 * The planned edges against the live ones, over the scoped beads only.
 *
 * @param {{deps: object[], idByPrefix: Map<string, string>, live: Set<string>,
 *   prefixById: Map<string, string>}} input
 * @returns {{extra: object[], live: number, missing: object[], planned: number,
 *   unresolved: object[]}}
 */
function diffEdges({ deps, idByPrefix, live, prefixById }) {
  const planned = new Map();
  for (const dep of deps) {
    const key = edgeKey(dep.blockedPrefix, dep.blockerPrefix);
    if (!planned.has(key)) planned.set(key, dep);
  }

  // Only edges between two beads of this TRD are this TRD's business: a link to another TRD's
  // bead is neither planned here nor drift here.
  const liveScoped = new Set();
  for (const key of live) {
    const [blockedId, blockerId] = key.split('|');
    const blocked = prefixById.get(blockedId);
    const blocker = prefixById.get(blockerId);
    if (blocked === undefined || blocker === undefined) continue;
    liveScoped.add(edgeKey(blocked, blocker));
  }

  const missing = [];
  const unresolved = [];
  for (const [key, dep] of planned) {
    const entry = { blocked: dep.blockedPrefix, blocker: dep.blockerPrefix, type: dep.type };
    if (!idByPrefix.has(dep.blockedPrefix) || !idByPrefix.has(dep.blockerPrefix)) {
      unresolved.push(entry);
      continue;
    }
    if (!liveScoped.has(key)) missing.push(entry);
  }

  const extra = [];
  for (const key of liveScoped) {
    if (planned.has(key)) continue;
    const [blocked, blocker] = key.split('|');
    extra.push({ blocked, blocker });
  }

  return {
    extra: sortEdges(extra),
    live: liveScoped.size,
    missing: sortEdges(missing),
    planned: planned.size,
    unresolved: sortEdges(unresolved),
  };
}

/** Whether a work-graph answer carries findings. Anything unrecognised fails closed. */
function findingsOf(data) {
  const findings = data && data.findings;
  if (Array.isArray(findings)) return findings;
  if (findings === null || findings === undefined) return [];
  if (typeof findings === 'object' && Object.keys(findings).length === 0) return [];
  return [findings];
}

/**
 * The work-graph step: the plan and the graph health of the repository's work graph.
 *
 * An unavailable backend is warned about and skipped -- the graph is simply not checked -- but a
 * backend that answered with findings halts the report, because beads whose dependencies are
 * unsound must not be dispatched.
 *
 * @returns {{findings: *[], workGraph: object}|object} a tagged engine result on failure
 */
function runWorkGraph(call, warnings) {
  const skipped = [];
  let dependencyAware = false;
  let orderingSource = null;
  let findings = [];

  for (const capability of WORK_GRAPH_CAPABILITIES) {
    const answer = classify(callCapability(call, capability), capability);
    if (answer.kind === 'gate') return answer.result;
    if (answer.kind === 'unavailable') {
      skipped.push(capability);
      warnings.push(
        MESSAGES.unavailableWarning(capability, answer.message, 'the work graph is not checked')
      );
      continue;
    }
    if (answer.kind === 'unreadable') {
      return unavailable('WORK_GRAPH_UNREADABLE', answer.message);
    }
    if (answer.kind !== 'ok') {
      return unavailable('WORK_GRAPH_FAILED', answer.message);
    }
    const data = answer.data || {};
    if (typeof data.dependencyAware === 'boolean') dependencyAware = data.dependencyAware;
    if (typeof data.orderingSource === 'string') orderingSource = data.orderingSource;
    if (capability === 'work-graph.graph-health') findings = findingsOf(data);
  }

  let status = 'clean';
  if (skipped.length === WORK_GRAPH_CAPABILITIES.length) status = 'unavailable';
  else if (skipped.length > 0) status = 'partial';

  return {
    findings,
    workGraph: { dependencyAware, findings, orderingSource, skipped, status },
  };
}

/**
 * How many open beads of this TRD carry no `## References` block, and whether the root epic's
 * block resolves.
 *
 * @returns {{references: object}|object} a tagged engine result when `bead-context` refuses
 */
function checkReferences(call, { beads, rootEpicId, trdPath, warnings }) {
  const open = beads.filter(bead => !isClosed(bead));
  let missingCount = 0;
  let countable = true;

  for (const bead of open) {
    let description = typeof bead.description === 'string' ? bead.description : null;
    if (description === null) {
      const shown = classify(callCapability(call, 'tracker.show', { id: bead.id }), 'tracker.show');
      if (shown.kind === 'gate') return shown.result;
      if (shown.kind === 'ok' && typeof (shown.data || {}).description === 'string') {
        description = shown.data.description;
      } else {
        countable = false;
        warnings.push(
          MESSAGES.failedWarning(
            'tracker.show',
            bead.id,
            shown.message || 'it carries no description',
            'the reference count is unknown'
          )
        );
        continue;
      }
    }
    if (parseReferencesBlock(description) === null) missingCount += 1;
  }

  if (countable && missingCount > 0) warnings.push(MESSAGES.referencesWarning(missingCount));

  const beadContext = { checked: false, missing: [], ok: null };
  if (rootEpicId !== null) {
    const context = runTrd(call, ['bead-context', '--bead', rootEpicId, '--trd', trdPath]);
    if (!context.json) {
      return unavailable(
        'BEAD_CONTEXT_UNREADABLE',
        `trd-cli bead-context produced no JSON result (exit ${context.exitCode})${
          context.stderr ? `: ${context.stderr.trim()}` : ''
        }`
      );
    }
    if (context.json.ok !== true) {
      const missing = Array.isArray(context.json.missing) ? context.json.missing : [];
      return refused('BEAD_CONTEXT_FAILED', MESSAGES.beadContextFailed(rootEpicId, missing), {
        missing,
      });
    }
    beadContext.checked = true;
    beadContext.ok = true;
  }

  return {
    references: {
      beadContext,
      missingCount: countable ? missingCount : null,
      openScoped: open.length,
    },
  };
}

/** The label a Foreman build selects the beads it dispatches by (REF:73). */
const FOREMAN_LABEL = 'foreman-exec';

/**
 * Backfill the TRD's scoping label over every bead of this TRD.
 *
 * The work is `trd-cli beads-label`'s, not this verb's: that is the labeller the skill calls and
 * the one whose idempotence (`beads-label.js`) is already proven, so a second run labels nothing
 * again. A backend that cannot label at all is a warning rather than a refusal, because an
 * unlabelled bead is a scoping inconvenience and not drift.
 *
 * @param {object} call the dispatcher's call object
 * @param {string} slug the TRD's slug, which is also the label
 * @param {string[]} warnings collected warnings, appended to in place
 * @returns {{already: number, label: string, labeled: number, matched: number, skipped: boolean}
 *   |object} the report, or a tagged engine result
 */
function labelBeads(call, slug, warnings) {
  const result = runTrd(call, ['beads-label', '--label', slug, '--match', `[trd:${slug}`]);
  if (!result.json) {
    return unavailable(
      'LABEL_UNREADABLE',
      `trd-cli beads-label produced no JSON result (exit ${result.exitCode})${
        result.stderr ? `: ${result.stderr.trim()}` : ''
      }`
    );
  }
  const json = result.json;
  if (json.ok === true) {
    return {
      already: Number(json.already) || 0,
      label: slug,
      labeled: Number(json.labeled) || 0,
      matched: Number(json.matched) || 0,
      skipped: false,
    };
  }
  if (json.ok === false && json.unavailable === true) {
    warnings.push(
      MESSAGES.unavailableWarning(
        'beads-label',
        json.reason,
        'the beads of this TRD stay unlabelled'
      )
    );
    return {
      already: 0,
      label: slug,
      labeled: 0,
      matched: Number(json.matched) || 0,
      skipped: true,
    };
  }
  const detail = typeof json.error === 'string' ? json.error : JSON.stringify(json);
  return refused('LABEL_FAILED', MESSAGES.labelFailed(detail));
}

/**
 * Tag the beads a build dispatches with `foreman-exec`, and nothing else (REF:73).
 *
 * The epic and its stories are never tagged: a build that dispatched them would run a phase as
 * if it were a task. The tracker is flushed and then re-read, because a tag this verb believes
 * it wrote and the tracker did not keep is exactly the state a dispatch would silently skip --
 * so the count is taken from the tracker's own answer, never from this loop's bookkeeping.
 *
 * @param {object} call the dispatcher's call object
 * @param {{beads: object[], slug: string, warnings: string[]}} context the scoped beads
 * @returns {{alreadyTagged: number, labelled: number, listed: number, tagged: number}|object}
 *   the report, or a tagged engine result
 */
function tagForeman(call, { beads, slug, warnings }) {
  const taskBeads = beads.filter(bead => isTaskLevel(bead.kind));
  let alreadyTagged = 0;
  let labelled = 0;
  for (const bead of taskBeads) {
    const labels = Array.isArray(bead.labels) ? bead.labels : [];
    if (labels.includes(FOREMAN_LABEL)) {
      alreadyTagged += 1;
      continue;
    }
    const tagged = classify(
      callCapability(call, 'tracker.label', { ids: bead.id, labels: FOREMAN_LABEL }),
      'tracker.label'
    );
    if (tagged.kind === 'gate') return tagged.result;
    if (tagged.kind !== 'ok') {
      return refused(
        'FOREMAN_TAGGING_FAILED',
        MESSAGES.foremanTaggingFailed(bead.prefix, tagged.message),
        { titlePrefix: bead.prefix }
      );
    }
    labelled += 1;
  }

  const synced = classify(callCapability(call, 'tracker.sync'), 'tracker.sync');
  if (synced.kind === 'gate') return synced.result;
  if (synced.kind !== 'ok') {
    warnings.push(
      synced.kind === 'unavailable'
        ? MESSAGES.unavailableWarning('tracker.sync', synced.message, 'the tracker is not flushed')
        : MESSAGES.failedWarning(
            'tracker.sync',
            slug,
            synced.message,
            'the tracker is not flushed'
          )
    );
  }

  const relisted = readIssues(call);
  if (isResult(relisted)) return relisted;
  const listed = scopeBeads(relisted.issues, slug).filter(
    bead =>
      isTaskLevel(bead.kind) && Array.isArray(bead.labels) && bead.labels.includes(FOREMAN_LABEL)
  ).length;
  if (listed !== taskBeads.length) {
    return refused(
      'FOREMAN_TAGGING_INCOMPLETE',
      MESSAGES.foremanTaggingIncomplete(taskBeads.length, listed),
      { listed, tagged: taskBeads.length }
    );
  }

  return { alreadyTagged, labelled, listed, tagged: taskBeads.length };
}

/**
 * Put one task bead back to open, so its task can be built again (REF:69).
 *
 * The bead is found by the task id its title carries, not by position, and exactly one match is
 * required: resetting the wrong bead of a TRD reopens work nobody asked for, and resetting two
 * hides which one was meant.
 *
 * @param {object} call the dispatcher's call object
 * @param {{taskId: string, trdPath: string}} context
 * @returns {object} the report, or a tagged engine result
 */
function resetTask(call, { taskId, trdPath }) {
  const slug = slugOf(trdPath);
  const listed = readIssues(call);
  if (isResult(listed)) return listed;

  const marker = `[trd:${slug}:task:${taskId}]`;
  const candidates = (listed.issues || []).filter(issue =>
    String(issue && issue.title == null ? '' : issue.title).includes(marker)
  );
  if (candidates.length === 0) {
    return refused('RESET_TASK_NOT_FOUND', MESSAGES.resetTaskNotFound(taskId, slug));
  }
  if (candidates.length > 1) {
    return refused('RESET_TASK_AMBIGUOUS', MESSAGES.RESET_TASK_AMBIGUOUS, {
      ids: candidates.map(issue => issue.id),
    });
  }

  const bead = candidates[0];
  const reset = classify(
    callCapability(call, 'tracker.set-status', { id: bead.id, status: 'open' }),
    'tracker.set-status'
  );
  if (reset.kind === 'gate') return reset.result;
  if (reset.kind === 'unavailable') {
    return unavailable('RESET_TASK_UNAVAILABLE', reset.message);
  }
  if (reset.kind !== 'ok') {
    return refused('RESET_TASK_FAILED', MESSAGES.resetTaskFailed(bead.id, reset.message));
  }

  return {
    MODE: 'reset-task',
    RESET_TASK: {
      beadId: bead.id,
      previousStatus: bead.status == null ? null : String(bead.status),
      status: 'open',
      taskId,
    },
    TRD_FILE_PATH: trdPath,
    TRD_SLUG: slug,
    WARNINGS: [],
  };
}

/**
 * @param {object} call the dispatcher's call object
 * @returns {object} the report, or a tagged engine result
 */
function handler(call) {
  const input = call.input;
  const taskId = input['reset-task'];
  // Checked before anything is read, so a request that cannot be honoured touches nothing: a
  // reset and a labelling pass are different jobs and running both would hide which was meant.
  if (typeof taskId === 'string') {
    if (input.label === true) {
      return refused('RESET_TASK_EXCLUSIVE', MESSAGES.exclusive('--reset-task', '--label'));
    }
    if (input.foreman === true) {
      return refused('RESET_TASK_EXCLUSIVE', MESSAGES.exclusive('--reset-task', '--foreman'));
    }
  }

  const trd = requireTrd(call);
  if (isResult(trd)) return trd;
  const trdPath = trd.path;

  if (typeof taskId === 'string') return resetTask(call, { taskId, trdPath });

  const calls = runTrd(call, ['scaffold-calls', trdPath]);
  if (!calls.json) {
    return unavailable(
      'SCAFFOLD_CALLS_UNREADABLE',
      `trd-cli scaffold-calls produced no JSON result (exit ${calls.exitCode})${
        calls.stderr ? `: ${calls.stderr.trim()}` : ''
      }`
    );
  }
  if (calls.json.ok !== true) {
    return refused('SCAFFOLD_PLAN_FAILED', MESSAGES.scaffoldPlanFailed(trdPath, calls.json.error));
  }
  const slug = calls.json.slug;
  const creates = calls.json.creates || [];
  const deps = calls.json.deps || [];

  const listed = readIssues(call);
  if (isResult(listed)) return listed;
  const beads = scopeBeads(listed.issues, slug);
  if (beads.length === 0) {
    return refused('NOT_SCAFFOLDED', MESSAGES.notScaffolded(slug));
  }

  // First in list order wins, as the scaffold's own title-prefix cache resolves it.
  const idByPrefix = new Map();
  const prefixById = new Map();
  for (const bead of beads) {
    if (!idByPrefix.has(bead.prefix)) idByPrefix.set(bead.prefix, bead.id);
    prefixById.set(bead.id, bead.prefix);
  }

  const warnings = [];

  const read = readLiveEdges(call, beads);
  if (isResult(read)) return read;
  const EDGES =
    read.source === null
      ? {
          checked: false,
          extra: [],
          live: 0,
          missing: [],
          planned: new Set(deps.map(dep => edgeKey(dep.blockedPrefix, dep.blockerPrefix))).size,
          reason: read.reason,
          source: null,
          unresolved: [],
        }
      : {
          checked: true,
          ...diffEdges({ deps, idByPrefix, live: read.live, prefixById }),
          reason: null,
          source: read.source,
        };
  if (!EDGES.checked) warnings.push(MESSAGES.edgesUnreadable(EDGES.reason));

  const graph = runWorkGraph(call, warnings);
  if (isResult(graph)) return graph;
  if (graph.findings.length > 0) {
    return refused('WORK_GRAPH_FINDINGS', MESSAGES.workGraphFindings(graph.findings.length), {
      findings: graph.findings,
    });
  }

  // An open epic is the one a build would dispatch from; a closed one still answers for the
  // hierarchy's references.
  const epics = beads.filter(bead => bead.kind === 'epic');
  const rootEpic = epics.find(bead => !isClosed(bead)) || epics[0] || null;
  const rootEpicId = rootEpic ? rootEpic.id : null;

  const checked = checkReferences(call, { beads, rootEpicId, trdPath, warnings });
  if (isResult(checked)) return checked;

  const missingLabel = beads.filter(
    bead => !(Array.isArray(bead.labels) && bead.labels.includes(slug))
  );
  if (missingLabel.length > 0) warnings.push(MESSAGES.labelsWarning(missingLabel.length, slug));

  // Every check that can refuse this run has passed, so from here the repairs may write.
  let LABEL = null;
  if (call.input.label === true) {
    LABEL = labelBeads(call, slug, warnings);
    if (isResult(LABEL)) return LABEL;
  }

  let FOREMAN = null;
  if (call.input.foreman === true) {
    FOREMAN = tagForeman(call, { beads, slug, warnings });
    if (isResult(FOREMAN)) return FOREMAN;
  }

  return {
    ...(FOREMAN ? { FOREMAN } : {}),
    ...(LABEL ? { LABEL } : {}),
    BEADS: {
      found: creates.filter(entry => idByPrefix.has(entry.titlePrefix)).length,
      planned: creates.length,
    },
    EDGES,
    LABELS: { expected: slug, missingCount: missingLabel.length },
    MODE: 'health',
    REFERENCES: checked.references,
    ROOT_EPIC_ID: rootEpicId,
    TRD_FILE_PATH: trdPath,
    TRD_SLUG: slug,
    WARNINGS: warnings,
    WORK_GRAPH: graph.workGraph,
  };
}

const EDGE_ENDPOINTS = {
  additionalProperties: false,
  properties: { blocked: { type: 'string' }, blocker: { type: 'string' } },
  required: ['blocked', 'blocker'],
  type: 'object',
};

const TYPED_EDGE = {
  additionalProperties: false,
  properties: {
    blocked: { type: 'string' },
    blocker: { type: 'string' },
    type: { type: 'string' },
  },
  required: ['blocked', 'blocker', 'type'],
  type: 'object',
};

const spec = {
  exitCodes: [0, 1, 2, 5],
  group: 'implement',
  handler,
  inputSchema: {
    additionalProperties: false,
    properties: {
      foreman: { type: 'boolean' },
      label: { type: 'boolean' },
      'reset-task': { pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$', type: 'string' },
      trd: { type: 'string', 'x-operand': true },
    },
    type: 'object',
  },
  name: 'bead-health',
  outputSchema: {
    additionalProperties: false,
    properties: {
      BEADS: {
        additionalProperties: false,
        properties: { found: { type: 'integer' }, planned: { type: 'integer' } },
        required: ['found', 'planned'],
        type: 'object',
      },
      EDGES: {
        additionalProperties: false,
        properties: {
          checked: { type: 'boolean' },
          extra: { items: EDGE_ENDPOINTS, type: 'array' },
          live: { type: 'integer' },
          missing: { items: TYPED_EDGE, type: 'array' },
          planned: { type: 'integer' },
          reason: { type: ['string', 'null'] },
          source: { enum: ['list', 'show', null] },
          unresolved: { items: TYPED_EDGE, type: 'array' },
        },
        required: [
          'checked',
          'extra',
          'live',
          'missing',
          'planned',
          'reason',
          'source',
          'unresolved',
        ],
        type: 'object',
      },
      FOREMAN: {
        additionalProperties: false,
        properties: {
          alreadyTagged: { type: 'integer' },
          labelled: { type: 'integer' },
          listed: { type: 'integer' },
          tagged: { type: 'integer' },
        },
        required: ['alreadyTagged', 'labelled', 'listed', 'tagged'],
        type: 'object',
      },
      LABEL: {
        additionalProperties: false,
        properties: {
          already: { type: 'integer' },
          label: { type: 'string' },
          labeled: { type: 'integer' },
          matched: { type: 'integer' },
          skipped: { type: 'boolean' },
        },
        required: ['already', 'label', 'labeled', 'matched', 'skipped'],
        type: 'object',
      },
      LABELS: {
        additionalProperties: false,
        properties: { expected: { type: 'string' }, missingCount: { type: 'integer' } },
        required: ['expected', 'missingCount'],
        type: 'object',
      },
      MODE: { enum: ['health', 'reset-task'] },
      REFERENCES: {
        additionalProperties: false,
        properties: {
          beadContext: {
            additionalProperties: false,
            properties: {
              checked: { type: 'boolean' },
              missing: { items: { type: 'string' }, type: 'array' },
              ok: { type: ['boolean', 'null'] },
            },
            required: ['checked', 'missing', 'ok'],
            type: 'object',
          },
          missingCount: { type: ['integer', 'null'] },
          openScoped: { type: 'integer' },
        },
        required: ['beadContext', 'missingCount', 'openScoped'],
        type: 'object',
      },
      RESET_TASK: {
        additionalProperties: false,
        properties: {
          beadId: { type: 'string' },
          previousStatus: { type: ['string', 'null'] },
          status: { enum: ['open'] },
          taskId: { type: 'string' },
        },
        required: ['beadId', 'previousStatus', 'status', 'taskId'],
        type: 'object',
      },
      ROOT_EPIC_ID: { type: ['string', 'null'] },
      TRD_FILE_PATH: { type: 'string' },
      TRD_SLUG: { type: 'string' },
      WARNINGS: { items: { type: 'string' }, type: 'array' },
      WORK_GRAPH: {
        additionalProperties: false,
        properties: {
          dependencyAware: { type: 'boolean' },
          findings: { type: 'array' },
          orderingSource: { type: ['string', 'null'] },
          skipped: { items: { type: 'string' }, type: 'array' },
          status: { enum: ['clean', 'partial', 'unavailable'] },
        },
        required: ['dependencyAware', 'findings', 'orderingSource', 'skipped', 'status'],
        type: 'object',
      },
    },
    // Only what both modes answer with is required: `reset-task` reports one bead and reads no
    // health, so requiring the health keys would make its own answer invalid.
    required: ['MODE', 'TRD_FILE_PATH', 'TRD_SLUG', 'WARNINGS'],
    type: 'object',
  },
  policyKeys: [],
  // The write flags of this verb land on this same spec, so it is declared side-effecting from
  // the start: a declaration that changed with a flag would let a write past the gates the
  // declaration selects.
  sideEffect: 'write',
  summary: 'report how the beads of a TRD differ from its plan, and label, tag or reset them on request',
};

module.exports = { diffEdges, spec };
