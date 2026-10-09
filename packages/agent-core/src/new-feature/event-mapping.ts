/**
 * Project-local, explicit opt-in configuration for event-triggered
 * `new-feature` starts (REQ-009). See
 * docs/TRD/TRD-2026-d6bbf322-new-feature-workflow.md (TRD-012, TRD-013,
 * TRD-018, TRD-020) for the authoritative behavior this file implements.
 *
 * Boundary validation (REQ-014, TRD-018): every input crossing the
 * workflow boundary is validated/resolved against a schema or index
 * before it can change any RunIndexStore state or select a tool to
 * invoke, and rejection happens at that boundary function itself, never
 * after a partial state change. Two boundary functions currently exist:
 * `validateEventPayload()` below for TRD-013's event payload (a pure
 * function -- an `ok: false` result has no RunIndexStore side effect of
 * its own, proven in event-mapping.test.ts), and `resolveByArtifact()`
 * in run-index.ts for TRD-005's `--path` resume input (a pure read that
 * returns `undefined` rather than throwing or guessing on an unindexed
 * path -- also never mutates).
 *
 * Default-deny: a project with no `.ensemble/new-feature/event-mapping.json`
 * file has no event entry path at all -- `loadEventMapping()` returns
 * `null`, never an implicit non-empty default, and the manual entry path
 * (TRD-005) is completely unaffected either way.
 */

import * as fs from "fs";
import * as path from "path";

/**
 * Project-local event-mapping config. `allowedEventTypes` is the explicit
 * allow-list; any event type not in this list is rejected at the boundary
 * (TRD-018). `reviewRequired` is always `true` -- there is no configuration
 * that skips human review or PRD elicitation for an event-triggered start
 * (TRD-013).
 */
export interface EventMappingConfig {
  allowedEventTypes: string[];
  reviewRequired: true;
}

/**
 * An inbound event payload crossing the workflow boundary. `summary` is
 * the minimum free-text description needed to start PRD elicitation --
 * exactly the same role `idea` plays for a manual invocation (TRD-005);
 * an event payload is never treated as a complete PRD input by itself
 * (TRD-013, Action 2), only as the seed for the same elicitation manual
 * invocation already requires.
 */
export interface EventPayload {
  type: string;
  source: string;
  summary: string;
}

/** Result of validating an `EventPayload` against an `EventMappingConfig`. */
export type EventValidationResult = { ok: true } | { ok: false; reason: string };

function eventMappingPath(projectRoot: string): string {
  return path.join(projectRoot, ".ensemble", "new-feature", "event-mapping.json");
}

/**
 * Load a project's event-mapping config, or `null` if none is configured
 * (the default-deny state). Never falls back to a non-empty implicit
 * default -- a project must explicitly opt in.
 *
 * Config-only, no hardcoded event-type list anywhere in this module
 * (REQ-014, TRD-020): `allowedEventTypes` always comes from reading
 * `event-mapping.json` fresh on this call -- never cached, never a
 * module-level constant. Editing the file is the only way to add or
 * remove an allowed event type; no code change is ever required.
 */
export function loadEventMapping(projectRoot: string): EventMappingConfig | null {
  const filePath = eventMappingPath(projectRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const isEnoent = typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
    if (isEnoent) return null;
    throw err;
  }

  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`event-mapping.json at ${filePath} must be a JSON object`);
  }
  if (!("allowedEventTypes" in parsed) || !Array.isArray((parsed as { allowedEventTypes: unknown }).allowedEventTypes)) {
    throw new Error(`event-mapping.json at ${filePath} must have an allowedEventTypes array`);
  }
  const allowedEventTypes = (parsed as { allowedEventTypes: unknown[] }).allowedEventTypes;
  if (!allowedEventTypes.every((t) => typeof t === "string")) {
    throw new Error(`event-mapping.json at ${filePath}: allowedEventTypes must be an array of strings`);
  }
  return { allowedEventTypes: allowedEventTypes as string[], reviewRequired: true };
}

/**
 * Validate an inbound event payload against the project's config, at the
 * workflow boundary, before any `RunIndexStore` call is made (TRD-018).
 * Pure function: never reads/writes the run index, never has a side
 * effect of its own -- rejection is reported to the caller, which is
 * responsible for not proceeding to `createRun()`/`mutate()` on an `ok:
 * false` result.
 */
export function validateEventPayload(mapping: EventMappingConfig | null, event: EventPayload): EventValidationResult {
  if (mapping === null) {
    return { ok: false, reason: "no event-mapping.json configured for this project (default-deny)" };
  }
  if (!mapping.allowedEventTypes.includes(event.type)) {
    return { ok: false, reason: `event type "${event.type}" is not in this project's allowedEventTypes` };
  }
  if (typeof event.source !== "string" || event.source.trim() === "") {
    return { ok: false, reason: "event payload is missing a non-empty source" };
  }
  if (typeof event.summary !== "string" || event.summary.trim() === "") {
    return {
      ok: false,
      reason: "event payload is missing a non-empty summary -- PRD elicitation needs a starting description, the same as the idea parameter for a manual invocation",
    };
  }
  return { ok: true };
}
