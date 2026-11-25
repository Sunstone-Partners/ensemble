'use strict';

/**
 * TRD-011 (TRD-2026-d571763f): `ensemble implement scaffold <trd>`.
 *
 * The bead hierarchy of a TRD, created once. `trd-cli scaffold-plan` is the plan of record and
 * this verb never re-derives it: it creates what the plan lists, in the plan's order, and wires
 * the plan's edges. That is what makes the verb resumable -- a crashed run leaves beads whose
 * title prefixes the next run recognises, so the re-run creates only what is missing instead of
 * a second copy of everything (`implement-trd-tasks-reference/SKILL.md:66`).
 *
 * The verb owns no lock, no queue and no record of its own progress (Constitution Rule 4): the
 * tracker's own contents are the state, re-read at the start of every run. Every gate it obeys
 * -- preflight, confirmation, the allowlist -- belongs to `toolchain-cli` and is returned
 * unchanged rather than degraded around (Rule 5).
 */

const MESSAGES = require('../messages');
const { isResult, refused, unavailable } = require('../result');
const { runTrd } = require('../cli-json');
const { callCapability, classify, idOf, prefixOf, readIssues } = require('../tracker');
const { requireTrd } = require('../trd-source');
const { findByKey } = require('../../tracker-findings');

/**
 * Every bead of the plan, in the order the scaffold creates them: the epic, then one story per
 * phase, then the tasks, then the synthesized tests.
 * @param {object} plan a `scaffold-plan` plan
 * @returns {object[]}
 */
function planEntries(plan) {
  return [plan.epic, ...plan.stories, ...plan.tasks, ...plan.synthesizedTests];
}

/**
 * The inter-phase edges an older, pre-planner scaffold wired and the planner no longer emits.
 *
 * No capability enumerates a tracker's edges, so the candidates are derived from the plan the
 * same way the old command derived them when it wrote them: "first task of phase N depends on
 * last task of phase N-1" (`implement-trd-tasks-reference/SKILL.md:67`). A gap in the phase
 * numbering therefore has no candidate -- phase N-1 must exist literally -- and a pair the TRD
 * itself declares is skipped, because removing it would delete a planned edge.
 *
 * @param {{beadByTaskId: Record<string, string>, phaseTaskIds: Record<string, string[]>,
 *   plannedPairs: Set<string>}} input `plannedPairs` holds `blockedId|blockerId` strings
 * @returns {{blocked: string, blocker: string}[]} in ascending phase order
 */
function staleCandidates({ beadByTaskId, phaseTaskIds, plannedPairs }) {
  const phases = Object.keys(phaseTaskIds)
    .map(Number)
    .filter(phase => Number.isInteger(phase) && phase >= 2)
    .sort((a, b) => a - b);

  const pairs = [];
  for (const phase of phases) {
    const current = phaseTaskIds[phase] || [];
    const previous = phaseTaskIds[phase - 1] || [];
    if (current.length === 0 || previous.length === 0) continue;
    const blocked = beadByTaskId[current[0]];
    const blocker = beadByTaskId[previous[previous.length - 1]];
    if (!blocked || !blocker) continue;
    if (plannedPairs.has(`${blocked}|${blocker}`)) continue;
    pairs.push({ blocked, blocker });
  }
  return pairs;
}

/**
 * The edges to wire and the ones no bead could be found for.
 * @param {{deps: object[], unresolved: object[]}} depArgs a `scaffold-dep-args` result
 * @returns {{edges: object[], unresolved: {blocked: string, blocker: string, type: string}[]}}
 */
function partitionEdges(depArgs) {
  const seen = new Set();
  const edges = [];
  for (const dep of depArgs.deps || []) {
    const key = `${dep.id}|${dep.dependsOnId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(dep);
  }
  const unresolved = (depArgs.unresolved || [])
    .map(entry => ({
      blocked: entry.blockedPrefix,
      blocker: entry.blockerPrefix,
      type: entry.type,
    }))
    .sort((a, b) => `${a.blocked}|${a.blocker}`.localeCompare(`${b.blocked}|${b.blocker}`));
  return { edges, unresolved };
}

/** A tracker row's id, as a trimmed string, or `''`. */
function rowId(row) {
  const id = row && row.id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return typeof id === 'string' ? id.trim() : '';
}

/**
 * The title-prefix cache: the one bead per prefix a re-run reuses.
 * @param {object[]} issues the tracker's rows
 * @param {string[]} warnings appended to when a prefix is carried by more than one bead
 * @returns {Map<string, string>} title prefix -> bead id
 */
function buildCache(issues, warnings) {
  const byPrefix = new Map();
  for (const issue of issues) {
    const prefix = prefixOf(issue && issue.title);
    const id = rowId(issue);
    // A row with no id cannot be reused: recording it would make the next run believe a bead
    // exists that nothing can be wired to.
    if (!prefix || id === '') continue;
    const existing = byPrefix.get(prefix);
    if (existing === undefined) {
      byPrefix.set(prefix, [id]);
      continue;
    }
    existing.push(id);
  }
  const cache = new Map();
  for (const [prefix, ids] of byPrefix) {
    if (ids.length > 1) {
      warnings.push(MESSAGES.duplicatePrefixWarning(prefix, ids, ids[0]));
    }
    cache.set(prefix, ids[0]);
  }
  return cache;
}

/** The failure detail a create refusal carries, so the operator can resume from the right bead. */
function createDetails(titlePrefix, counts, failure) {
  return { created: counts.created, failure, reused: counts.reused, titlePrefix };
}

/**
 * Look a bead up by the external key the plan gave it, on the adapters that need it.
 *
 * @param {object} call
 * @param {string} key
 * @returns {object} a `tracker-findings` findByKey result
 */
function lookupByKey(call, key) {
  return findByKey(
    {
      run: (capability, args) => {
        const result = callCapability(call, capability, args);
        return (
          result.json || {
            error: {
              code: 'TRACKER_UNREADABLE',
              message: `${capability} produced no JSON result (exit ${result.exitCode})`,
            },
            ok: false,
          }
        );
      },
    },
    { key }
  );
}

/**
 * Create the beads the plan lists, reusing whatever already exists.
 * @returns {{idByPrefix: Map<string, string>, counts: {created: number, reused: number}}|object}
 */
function createBeads(call, { cache, callArgsByPrefix, entries, kata, warnings }) {
  const idByPrefix = new Map();
  const counts = { created: 0, reused: 0 };
  let lookupUnavailable = false;
  let detailedUnavailable = false;

  for (const entry of entries) {
    const prefix = entry.titlePrefix;

    const cached = cache.get(prefix);
    if (cached !== undefined) {
      idByPrefix.set(prefix, cached);
      counts.reused += 1;
      continue;
    }

    const callArgs = callArgsByPrefix ? callArgsByPrefix.get(prefix) : null;

    // The list of some trackers shows open work only, so a closed bead is invisible to the
    // cache and has to be found by its external key before a second one is created.
    if (kata && !lookupUnavailable && callArgs) {
      const found = lookupByKey(call, callArgs.externalKey);
      if (found.ok === true && found.found === true) {
        const id = rowId(found.item);
        if (id === '') {
          return refused(
            'LOOKUP_FAILED',
            MESSAGES.lookupFailed(prefix, 'the matched bead has no id'),
            createDetails(prefix, counts, 'LOOKUP_FAILED')
          );
        }
        idByPrefix.set(prefix, id);
        counts.reused += 1;
        continue;
      }
      if (found.ok !== true) {
        const error = found.error || {};
        if (found.unavailable === true) {
          lookupUnavailable = true;
          warnings.push(
            MESSAGES.unavailableWarning(
              'tracker.find-by-key',
              error.message || 'no detail',
              'beads are matched by title prefix only'
            )
          );
        } else if (error.code === 'AMBIGUOUS_KEY') {
          return refused('AMBIGUOUS_KEY', MESSAGES.ambiguousKey(prefix, error.message), {
            ...createDetails(prefix, counts, 'AMBIGUOUS_KEY'),
            ids: error.ids,
          });
        } else {
          return refused(
            'LOOKUP_FAILED',
            MESSAGES.lookupFailed(prefix, error.message || 'no detail'),
            createDetails(prefix, counts, 'LOOKUP_FAILED')
          );
        }
      }
    }

    let capability = 'tracker.create';
    let args = { title: entry.title, type: entry.type, description: entry.description };
    if (kata && callArgs && !detailedUnavailable) {
      capability = 'tracker.create-detailed';
      args = callArgs;
    }

    let created = classify(callCapability(call, capability, args), capability);
    if (created.kind === 'unavailable' && capability === 'tracker.create-detailed') {
      detailedUnavailable = true;
      warnings.push(
        MESSAGES.unavailableWarning(
          'tracker.create-detailed',
          created.message,
          'beads are created with tracker.create'
        )
      );
      capability = 'tracker.create';
      args = { title: entry.title, type: entry.type, description: entry.description };
      created = classify(callCapability(call, capability, args), capability);
    }

    if (created.kind === 'gate') {
      const gate = created.result;
      if (gate.status === 'INVALID_INPUT') return gate;
      return refused(
        gate.code,
        MESSAGES.createFailed(prefix, gate.message),
        createDetails(prefix, counts, gate.code)
      );
    }
    if (created.kind !== 'ok') {
      return refused(
        'CREATE_FAILED',
        MESSAGES.createFailed(prefix, created.message),
        createDetails(prefix, counts, created.kind === 'failed' ? created.code : created.kind)
      );
    }

    const id = idOf(created.data);
    if (id === '') {
      return refused(
        'CREATE_NO_ID',
        MESSAGES.createNoId(prefix),
        createDetails(prefix, counts, 'CREATE_NO_ID')
      );
    }
    idByPrefix.set(prefix, id);
    counts.created += 1;
  }

  return { counts, idByPrefix };
}

/** An edge the tracker says is not there is the normal case for a scaffold that never had it. */
const EDGE_ABSENT_RE = /not\s+found|no such|does not exist|no (?:such )?(?:dependency|edge|link)/i;

/**
 * Remove the stale inter-phase edges, before the plan's own edges are wired.
 * @returns {{absent: number, candidates: number, failed: number,
 *   removed: {blocked: string, blocker: string}[], skipped: number}|object}
 */
function removeStaleEdges(call, { pairs, skipped, warnings }) {
  const stale = { absent: 0, candidates: pairs.length, failed: 0, removed: [], skipped };
  for (const pair of pairs) {
    const result = classify(
      callCapability(call, 'tracker.dep-remove', { dependsOnId: pair.blocker, id: pair.blocked }),
      'tracker.dep-remove'
    );
    if (result.kind === 'ok') {
      stale.removed.push({ blocked: pair.blocked, blocker: pair.blocker });
      continue;
    }
    if (result.kind === 'gate') return result.result;
    if (result.kind === 'unavailable') {
      warnings.push(
        MESSAGES.unavailableWarning(
          'tracker.dep-remove',
          result.message,
          'stale inter-phase edges are left in place'
        )
      );
      return stale;
    }
    if (EDGE_ABSENT_RE.test(result.message)) {
      stale.absent += 1;
      continue;
    }
    stale.failed += 1;
    warnings.push(
      MESSAGES.failedWarning(
        'tracker.dep-remove',
        `${pair.blocked} <- ${pair.blocker}`,
        result.message,
        'the edge is left in place'
      )
    );
  }
  return stale;
}

/**
 * Wire the plan's edges.
 * @returns {{added: number, skipped: number}|object}
 */
function addEdges(call, { edges, warnings }) {
  let added = 0;
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    const result = classify(
      callCapability(call, 'tracker.dep-add', {
        dependsOnId: edge.dependsOnId,
        id: edge.id,
        type: edge.type,
      }),
      'tracker.dep-add'
    );
    if (result.kind === 'ok') {
      added += 1;
      continue;
    }
    if (result.kind === 'gate') return result.result;
    const remaining = edges.length - index;
    warnings.push(
      result.kind === 'unavailable'
        ? MESSAGES.unavailableWarning(
            'tracker.dep-add',
            result.message,
            `${remaining} dependency edges are not wired`
          )
        : MESSAGES.failedWarning(
            'tracker.dep-add',
            `${edge.id} <- ${edge.dependsOnId}`,
            result.message,
            `${remaining} dependency edges are not wired`
          )
    );
    return { added, skipped: remaining };
  }
  return { added, skipped: 0 };
}

/**
 * @param {object} call the dispatcher's call object
 * @returns {object} the scaffold's result, or a tagged engine result
 */
function handler(call) {
  const selected = requireTrd(call);
  if (isResult(selected)) return selected;
  const trdPath = selected.path;

  const planned = runTrd(call, ['scaffold-plan', trdPath]);
  if (!planned.json) {
    return unavailable(
      'SCAFFOLD_PLAN_UNREADABLE',
      `trd-cli scaffold-plan produced no JSON result (exit ${planned.exitCode})${
        planned.stderr ? `: ${planned.stderr.trim()}` : ''
      }`
    );
  }
  if (planned.json.ok !== true) {
    return refused(
      'SCAFFOLD_PLAN_FAILED',
      MESSAGES.scaffoldPlanFailed(trdPath, planned.json.error)
    );
  }

  const plan = planned.json.plan;
  const slug = planned.json.slug;
  const entries = planEntries(plan);
  const warnings = [...(plan.warnings || [])];

  const listed = readIssues(call);
  if (isResult(listed)) return listed;
  const cache = buildCache(listed.issues, warnings);
  const kata = listed.adapter === 'kata';

  let callArgsByPrefix = null;
  if (kata) {
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
      return refused(
        'SCAFFOLD_PLAN_FAILED',
        MESSAGES.scaffoldPlanFailed(trdPath, calls.json.error)
      );
    }
    callArgsByPrefix = new Map(calls.json.creates.map(entry => [entry.titlePrefix, entry.args]));
    const missing = entries.find(entry => !callArgsByPrefix.has(entry.titlePrefix));
    if (missing) {
      return refused(
        'PLAN_CALLS_MISMATCH',
        `the scaffold plan lists bead '${missing.titlePrefix}' and the create calls do not`
      );
    }
  }

  const beads = createBeads(call, { cache, callArgsByPrefix, entries, kata, warnings });
  if (isResult(beads)) return beads;
  const { counts, idByPrefix } = beads;

  const phaseStoryIds = {};
  for (const story of plan.stories) {
    phaseStoryIds[story.phaseN] = idByPrefix.get(story.titlePrefix);
  }
  const beadByTaskId = {};
  const phaseTasks = {};
  const phaseTaskIds = {};
  // Tasks first, then the synthesized tests: the synthesized tests of a phase come last.
  for (const group of [plan.tasks, plan.synthesizedTests]) {
    for (const task of group) {
      beadByTaskId[task.id] = idByPrefix.get(task.titlePrefix);
      if (!phaseTasks[task.phaseN]) {
        phaseTasks[task.phaseN] = [];
        phaseTaskIds[task.phaseN] = [];
      }
      phaseTasks[task.phaseN].push(task.id);
      phaseTaskIds[task.phaseN].push(beadByTaskId[task.id]);
    }
  }

  const ids = {};
  for (const [prefix, id] of idByPrefix) ids[prefix] = id;
  const depArgs = runTrd(call, ['scaffold-dep-args', trdPath, '--ids', JSON.stringify(ids)]);
  if (!depArgs.json) {
    return unavailable(
      'SCAFFOLD_DEP_ARGS_UNREADABLE',
      `trd-cli scaffold-dep-args produced no JSON result (exit ${depArgs.exitCode})${
        depArgs.stderr ? `: ${depArgs.stderr.trim()}` : ''
      }`
    );
  }
  if (depArgs.json.ok !== true) {
    return refused('DEP_ARGS_FAILED', MESSAGES.depArgsFailed(depArgs.json.error));
  }
  const { edges, unresolved } = partitionEdges(depArgs.json);

  const plannedPairs = new Set(edges.map(edge => `${edge.id}|${edge.dependsOnId}`));
  const allPairs = staleCandidates({
    beadByTaskId,
    phaseTaskIds: phaseTasks,
    plannedPairs: new Set(),
  });
  const pairs = staleCandidates({ beadByTaskId, phaseTaskIds: phaseTasks, plannedPairs });
  const stale = removeStaleEdges(call, {
    pairs,
    skipped: allPairs.length - pairs.length,
    warnings,
  });
  if (isResult(stale)) return stale;

  const wired = addEdges(call, { edges, warnings });
  if (isResult(wired)) return wired;

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

  return {
    ADAPTER: listed.adapter,
    BEADS: {
      created: counts.created,
      reused: counts.reused,
      total: counts.created + counts.reused,
    },
    EDGES: {
      added: wired.added,
      planned: wired.added + wired.skipped + unresolved.length,
      skipped: wired.skipped,
      unresolved,
    },
    PHASE_STORY_IDS: phaseStoryIds,
    PHASE_TASK_IDS: phaseTaskIds,
    ROOT_EPIC_ID: idByPrefix.get(plan.epic.titlePrefix),
    STALE_EDGES: stale,
    SYNCED: synced.kind === 'ok',
    TRD_FILE_PATH: trdPath,
    TRD_SLUG: slug,
    TRD_TO_BEAD_MAP: beadByTaskId,
    WARNINGS: warnings,
  };
}

const spec = {
  exitCodes: [0, 1, 2, 5],
  group: 'implement',
  handler,
  inputSchema: {
    additionalProperties: false,
    properties: {
      trd: { type: 'string', 'x-operand': true },
    },
    type: 'object',
  },
  name: 'scaffold',
  outputSchema: {
    additionalProperties: false,
    properties: {
      ADAPTER: { type: ['string', 'null'] },
      BEADS: {
        additionalProperties: false,
        properties: {
          created: { type: 'integer' },
          reused: { type: 'integer' },
          total: { type: 'integer' },
        },
        required: ['created', 'reused', 'total'],
        type: 'object',
      },
      EDGES: {
        additionalProperties: false,
        properties: {
          added: { type: 'integer' },
          planned: { type: 'integer' },
          skipped: { type: 'integer' },
          unresolved: {
            items: {
              additionalProperties: false,
              properties: {
                blocked: { type: 'string' },
                blocker: { type: 'string' },
                type: { type: 'string' },
              },
              required: ['blocked', 'blocker', 'type'],
              type: 'object',
            },
            type: 'array',
          },
        },
        required: ['added', 'planned', 'skipped', 'unresolved'],
        type: 'object',
      },
      PHASE_STORY_IDS: { additionalProperties: { type: 'string' }, type: 'object' },
      PHASE_TASK_IDS: {
        additionalProperties: { items: { type: 'string' }, type: 'array' },
        type: 'object',
      },
      ROOT_EPIC_ID: { type: 'string' },
      STALE_EDGES: {
        additionalProperties: false,
        properties: {
          absent: { type: 'integer' },
          candidates: { type: 'integer' },
          failed: { type: 'integer' },
          removed: {
            items: {
              additionalProperties: false,
              properties: { blocked: { type: 'string' }, blocker: { type: 'string' } },
              required: ['blocked', 'blocker'],
              type: 'object',
            },
            type: 'array',
          },
          skipped: { type: 'integer' },
        },
        required: ['absent', 'candidates', 'failed', 'removed', 'skipped'],
        type: 'object',
      },
      SYNCED: { type: 'boolean' },
      TRD_FILE_PATH: { type: 'string' },
      TRD_SLUG: { type: 'string' },
      TRD_TO_BEAD_MAP: { additionalProperties: { type: 'string' }, type: 'object' },
      WARNINGS: { items: { type: 'string' }, type: 'array' },
    },
    required: [
      'ADAPTER',
      'BEADS',
      'EDGES',
      'PHASE_STORY_IDS',
      'PHASE_TASK_IDS',
      'ROOT_EPIC_ID',
      'STALE_EDGES',
      'SYNCED',
      'TRD_FILE_PATH',
      'TRD_SLUG',
      'TRD_TO_BEAD_MAP',
      'WARNINGS',
    ],
    type: 'object',
  },
  policyKeys: [],
  // Creating beads is a write: the verb is declared side-effecting so the toolchain's own
  // preflight and confirmation gates apply to every capability it runs.
  sideEffect: 'write',
  summary: 'create the epic, story and task beads of a TRD, resuming without duplicates',
};

module.exports = { partitionEdges, spec, staleCandidates };
