'use strict';

/**
 * Shared pure dependency-edge scan (TRD-2026-6995dc96 TRD-018; PRD REQ-007 AC-007-2,
 * AC-007-3, AC-007-5).
 *
 * Two functions, no I/O: `scanWorkGraph(items)` returns a dependency-first ordering of the
 * items it was handed plus any structural findings, and `isGraphHealthy(scanResult)` projects
 * that result onto the `work-graph` category contract's
 * `work-graph.graph-health` outputs (`packages/development/toolchain/categories/
 * work-graph.yaml`: `outputs: [status, findings]`). Nothing here reads the filesystem, spawns
 * a process, touches `process.env`, or consults any global: callers (TRD-017's kata edge
 * export, TRD-019's `work-graph.plan`/`work-graph.graph-health` kata module, TRD-026's
 * truthful builtin graph-health fallback, TRD-018-TEST's fixed graphs) fetch items through
 * `tracker.list`/`tracker.show` via `./runner.js#runCapability` and pass the results in. That
 * is why this is a separate module rather than more code inside
 * `./builtin/work-graph-links-fallback.js`: the same scan has to serve a kata-native adapter,
 * the builtin fallback, and tests, none of which should have to route through the other's
 * execution path.
 *
 * ## Input contract
 *
 * An **item** is any object carrying a non-empty string `id`. Ids are opaque strings; nothing
 * here parses, normalizes case, or trims them -- an id is exactly what the backing tracker
 * returned. An item with no usable `id` (missing, non-string, or empty) is not a graph vertex
 * at all and is reported as a `missing-id` finding rather than dropped silently.
 *
 * A **dependency link** is one entry of an item's `dependencies` array, in either shape the
 * repo's normalized work-item schema and the links-only fallback already accept (see
 * `packages/development/toolchain/schemas/normalized/work-item.json` and
 * `./builtin/work-graph-links-fallback.js#dependencyIds`):
 * - canonical: `{ id: '<dep id>', type?: '<link type>' }`
 * - tolerated: a bare id string `'<dep id>'`
 *
 * Semantics are "this item is blocked by that id": an edge points from the depended-on id to
 * the item that needs it, so dependency-first ordering places the depended-on id earlier.
 * A non-array `dependencies` (including absent) means "this tracker never told us" and
 * contributes no edges; an empty array means "present, nothing blocked on". A `dependencies`
 * entry that is neither of the two shapes above contributes no edge and is reported as a
 * `malformed-dependency` finding. `type` is carried through into findings for triage but
 * never affects ordering -- the scan is link-type-agnostic, matching the fallback.
 *
 * **Scanned scope** is exactly the array passed to `scanWorkGraph` -- the ids present in that
 * array, no more. This module never queries a tracker, so "in scope" and "named by an edge"
 * are the only two states: an edge naming an id absent from the array is a `dangling-edge`
 * finding (AC-007-5), not an implied node, not a silent skip. Callers that fetch detail per
 * item (TRD-017/TRD-019 do) decide what constitutes the scope by what they pass in; a
 * closed-and-therefore-filtered-out dependency still counts as out of scope, so callers
 * wanting "closed blocker is fine" semantics must keep closed items in the array (the fallback
 * does exactly that today).
 *
 * Duplicate ids in the input are one vertex; the first occurrence is the one carried into the
 * output. A self-dependency (`X` depends on `X`) is a cycle of length one, reported as a
 * `cycle` finding -- not ignored, not "already satisfied".
 *
 * ## Result shape (stable; downstream consumers depend on it)
 *
 * ```
 * scanWorkGraph(items) -> {
 *   ordered: object[],   // dependency-first, see ORDERING below; EMPTY if any finding exists
 *   findings: Finding[], // see FINDINGS below; [] when the graph is clean
 *   clean: boolean,      // findings.length === 0
 *   ids: string[],       // in-scope ids, input order, first occurrence, duplicates removed
 * }
 *
 * Finding = {
 *   type: 'cycle' | 'dangling-edge' | 'malformed-dependency' | 'missing-id',
 *   items: string[],     // in-scope item ids this finding is about, sorted ascending
 *   dependency?: string, // edge target: the id named by the link (dangling/malformed only)
 *   detail?: string,     // human-readable sentence, exact text below
 * }
 *
 * isGraphHealthy(result) -> { status: 'healthy'|'unhealthy', findings: Finding[] }
 * ```
 *
 * ## ORDERING -- deterministic, and blocked graphs get no order at all
 *
 * A clean scan uses Kahn's algorithm with a FIFO frontier seeded in **input order** and each
 * item's edges considered in input order, so `ordered` is a stable topological order: every
 * item appears after every item it depends on (AC-007-2), and the same input always produces
 * the byte-identical same array (AC-007-1's "two consecutive listings ... identical sequence"
 * requirement applies to the plan path too).
 *
 * A scan that produced ANY finding returns `ordered: []`. AC-007-3 is explicit that a cycle
 * must be reported "rather than a plan silently ordering the cycle anyway", and a partial
 * order that happens to place some cycle members early is precisely that silent ordering --
 * it looks plausible and hides the cycle. Dangling edges are treated the same way for the same
 * reason: a link to an id the scope never returned cannot be honored, so any order produced
 * alongside it silently violates AC-007-2. Callers wanting "best effort" output still have the
 * full `findings` list plus `ids` to triage from; nobody gets a trustworthy-looking order for
 * an untrustworthy graph.
 *
 * ## FINDINGS -- vocabulary and determinism
 *
 * Finding `type` values are a closed set, named after what was found:
 * - `'cycle'` -- a strongly-connected component of size > 1, or a self-edge. `items` are the
 *   ids in that component (sorted); a component spanning several mutually-reachable groups is
 *   one finding per component, so triage sees each cycle separately.
 * - `'dangling-edge'` -- an edge naming an id not in the scanned scope. `items` names the
 *   in-scope item(s) that declared that link (sorted), `dependency` names the absent id.
 *   One finding per distinct absent id, aggregating every in-scope item that points at it.
 * - `'malformed-dependency'` -- a `dependencies` entry that is neither `{id}` nor a bare
 *   string. `items` names the declaring item(s), `dependency` is `undefined`.
 * - `'missing-id'` -- an array element with no usable `id`. `items` is empty (the item has no
 *   id to name); `detail` gives its zero-based index in the input array.
 *
 * Ordering of `findings` is deterministic and independent of input order for the two
 * structural cases that matter to golden fixtures: findings are grouped by `type` in the fixed
 * order `cycle`, `dangling-edge`, `malformed-dependency`, `missing-id`, and within a type
 * sorted by `dependency` (when present) then by `items.join(',')`. Every `items` array is
 * sorted ascending with `Array.prototype.sort`'s default (UTF-16 code-unit) comparison. So
 * byte-for-byte fixture comparisons downstream (TRD-018-TEST, TRD-019-TEST, TRD-026-TEST) do
 * not depend on which item the scanner happened to reach first.
 *
 * `detail` is a fixed, generated sentence per type, not free-form:
 * - cycle: `` `dependency cycle among: ${items.join(', ')}` ``
 * - dangling-edge: `` `dependency '${dependency}' is not present in the scanned scope` ``
 * - malformed-dependency: `` `unrecognized dependency link shape on ${items.join(', ')}` ``
 * - missing-id: `` `item at index ${index} has no usable string id` ``
 *
 * `isGraphHealthy` is the thin projection for the contract's `work-graph.graph-health`:
 * `status` is `'healthy'` only when `findings` is empty, else `'unhealthy'`, and `findings` is
 * the same array (same order, same objects) `scanWorkGraph` returned. It never re-derives
 * anything, so plan and graph-health can never disagree about what is wrong.
 */

const FINDING_TYPE_ORDER = Object.freeze([
  'cycle',
  'dangling-edge',
  'malformed-dependency',
  'missing-id',
]);

/**
 * One in-scope item id, or `null` when the value has no usable one.
 *
 * @param {unknown} item
 * @returns {string | null}
 */
function itemIdOf(item) {
  if (!item || typeof item !== 'object') return null;
  const id = item.id ?? item.Id ?? item.ID;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * One `dependencies[]` entry's target id, or `null` when the entry has no usable one.
 *
 * @param {unknown} dep
 * @returns {string | null}
 */
function dependencyIdOf(dep) {
  if (typeof dep === 'string') return dep.length > 0 ? dep : null;
  if (!dep || typeof dep !== 'object') return null;
  const id = dep.id ?? dep.Id ?? dep.ID;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** @param {string[]} ids @returns {string} */
function sortIds(ids) {
  return [...new Set(ids)].sort();
}

/** @param {Finding-ish} a @param {Finding-ish} b @returns {number} */
function compareFindings(a, b) {
  const byType =
    FINDING_TYPE_ORDER.indexOf(a.type) - FINDING_TYPE_ORDER.indexOf(b.type);
  if (byType !== 0) return byType;
  const aDep = a.dependency ?? '';
  const bDep = b.dependency ?? '';
  if (aDep !== bDep) return aDep < bDep ? -1 : 1;
  const aKey = a.items.join(',');
  const bKey = b.items.join(',');
  if (aKey !== bKey) return aKey < bKey ? -1 : 1;
  return 0;
}

/**
 * Tarjan's strongly-connected components, iterative (no recursion depth limit on wide real
 * backlogs), in a deterministic traversal: vertices visited in `ids` order, successors visited
 * in the order their edges were recorded. Components of size > 1 are cycles; a size-1 component
 * is a cycle only when it holds a self-edge.
 *
 * @param {string[]} ids in-scope ids, input order
 * @param {Map<string, string[]>} edges adjacency from depended-on id to items needing it
 * @param {Set<string>} selfDependent ids that depend on themselves
 * @returns {{items: string[], detail: string}[]} cycle findings, unsorted
 */
function cycleFindings(ids, edges, selfDependent) {
  const indexById = new Map();
  const lowLink = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let nextIndex = 0;

  for (const root of ids) {
    if (indexById.has(root)) continue;

    // Explicit DFS frame: [id, successor cursor].
    const frames = [[root, 0]];
    indexById.set(root, nextIndex);
    lowLink.set(root, nextIndex);
    nextIndex += 1;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const [node, cursor] = frame;
      const successors = edges.get(node) ?? [];

      if (cursor < successors.length) {
        frame[1] += 1;
        const successor = successors[cursor];
        if (!indexById.has(successor)) {
          indexById.set(successor, nextIndex);
          lowLink.set(successor, nextIndex);
          nextIndex += 1;
          stack.push(successor);
          onStack.add(successor);
          frames.push([successor, 0]);
        } else if (onStack.has(successor)) {
          lowLink.set(node, Math.min(lowLink.get(node), indexById.get(successor)));
        }
        continue;
      }

      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1][0];
        lowLink.set(parent, Math.min(lowLink.get(parent), lowLink.get(node)));
      }
      if (lowLink.get(node) === indexById.get(node)) {
        const component = [];
        let popped = stack.pop();
        onStack.delete(popped);
        component.push(popped);
        while (popped !== node) popped = stack.pop(), onStack.delete(popped), component.push(popped);
        components.push(component);
      }
    }
  }

  const findings = [];
  for (const component of components) {
    const members =
      component.length > 1 ? component : selfDependent.has(component[0]) ? component : null;
    if (!members) continue;
    // A multi-member component is only a real cycle if its members really do block one
    // another; edges here are exactly the blocking links, so membership already implies it.
    const items = sortIds(members);
    findings.push({
      type: 'cycle',
      items,
      detail: `dependency cycle among: ${items.join(', ')}`,
    });
  }
  return findings;
}

/**
 * Dependency-first ordering of a scanned item set, plus structural findings.
 *
 * Pure: same input always yields the same output, and the input array and its items are never
 * mutated. See the module header for the input contract, the result shape, the ordering rule,
 * and why a graph with any finding gets `ordered: []`.
 *
 * @param {unknown[]} items scanned scope: work items with a string `id` and optional
 *   `dependencies` of `{id}` objects or bare id strings
 * @returns {{ordered: object[], findings: object[], clean: boolean, ids: string[]}}
 */
function scanWorkGraph(items) {
  const list = Array.isArray(items) ? items : [];

  const byId = new Map();
  const ids = [];
  const findings = [];
  const missingIdIndexes = [];

  list.forEach((item, index) => {
    const id = itemIdOf(item);
    if (id === null) {
      missingIdIndexes.push(index);
      return;
    }
    if (!byId.has(id)) {
      byId.set(id, item);
      ids.push(id);
    }
  });

  /** item id -> ids it depends on (in scope or not), input order */
  const blocking = new Map();
  /** depended-on id -> ids needing it, input order */
  const edges = new Map();
  const selfDependent = new Set();
  /** absent dependency id -> in-scope items declaring it */
  const dangling = new Map();
  /** malformed dependency -> in-scope items declaring it */
  const malformed = new Map();

  for (const id of ids) {
    const deps = byId.get(id).dependencies;
    const own = [];
    blocking.set(id, own);
    if (deps === undefined || deps === null) continue;
    if (!Array.isArray(deps)) {
      const key = `${id}\u0000non-array`;
      if (!malformed.has(key)) malformed.set(key, [id]);
      continue;
    }
    for (const dep of deps) {
      const depId = dependencyIdOf(dep);
      if (depId === null) {
        const key = `${id}\u0000malformed`;
        if (!malformed.has(key)) malformed.set(key, [id]);
        continue;
      }
      own.push(depId);
      if (depId === id) selfDependent.add(id);
      if (!byId.has(depId)) {
        if (!dangling.has(depId)) dangling.set(depId, []);
        dangling.get(depId).push(id);
        continue;
      }
      if (!edges.has(depId)) edges.set(depId, []);
      edges.get(depId).push(id);
    }
  }

  for (const index of missingIdIndexes) {
    findings.push({
      type: 'missing-id',
      items: [],
      detail: `item at index ${index} has no usable string id`,
    });
  }

  for (const [dependency, declaredBy] of dangling) {
    findings.push({
      type: 'dangling-edge',
      items: sortIds(declaredBy),
      dependency,
      detail: `dependency '${dependency}' is not present in the scanned scope`,
    });
  }

  for (const declaredBy of malformed.values()) {
    findings.push({
      type: 'malformed-dependency',
      items: sortIds(declaredBy),
      detail: `unrecognized dependency link shape on ${sortIds(declaredBy).join(', ')}`,
    });
  }

  findings.push(...cycleFindings(ids, edges, selfDependent));

  if (findings.length > 0) {
    return {
      ordered: [],
      findings: findings.sort(compareFindings),
      clean: false,
      ids,
    };
  }

  // Clean graph: Kahn's algorithm, FIFO frontier seeded in input order, successors in input
  // order. Every in-scope id is reachable or has no in-scope dependency, so the drain below
  // always consumes all of them (any residue would itself be a cycle, already caught).
  const inDegree = new Map();
  for (const id of ids) {
    inDegree.set(id, blocking.get(id).filter((depId) => byId.has(depId)).length);
  }
  const frontier = ids.filter((id) => inDegree.get(id) === 0);
  const ordered = [];
  for (let i = 0; i < frontier.length; i += 1) {
    const id = frontier[i];
    ordered.push(byId.get(id));
    for (const dependent of edges.get(id) ?? []) {
      const remaining = inDegree.get(dependent) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) frontier.push(dependent);
    }
  }

  return { ordered, findings: [], clean: true, ids };
}

/**
 * Project a `scanWorkGraph` result onto the `work-graph` category contract's
 * `work-graph.graph-health` outputs (`status`, `findings`). No re-derivation: an empty
 * `findings` is `'healthy'`, anything else is `'unhealthy'`.
 *
 * @param {{findings: object[]}} scanResult a `scanWorkGraph` return value
 * @returns {{status: 'healthy' | 'unhealthy', findings: object[]}}
 */
function isGraphHealthy(scanResult) {
  const findings = Array.isArray(scanResult?.findings) ? scanResult.findings : [];
  return {
    status: findings.length === 0 ? 'healthy' : 'unhealthy',
    findings,
  };
}

module.exports = { scanWorkGraph, isGraphHealthy };
