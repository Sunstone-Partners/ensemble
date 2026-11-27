'use strict';

/**
 * The High-tier explainer offer: which explainers a review report OFFERS, and
 * which of them a person actually asked for (REQ-022, AC-022-3).
 *
 * NO side effects, NO shell, NO network calls, and -- by construction -- NO
 * explainer. This module decides only *whether to offer* and *what was
 * accepted*; writing an explainer is the `pr-review-explainer` skill's job
 * (TRD-036), and it runs only for the modules named in `generate`.
 *
 * The two rules it enforces, because both cost real work when they slip:
 *   - Only a **High** effective tier offers anything (AC-022-3). A Low treated
 *     as Medium is not High, so the assigned tier never decides this.
 *   - An offer is an invitation, never a job: `generate` is empty until a
 *     person names a module. A request for something that was never offered
 *     is named in `unknownRequested` and generates nothing.
 *
 * FAIL CLOSED means, here, "offer nothing and generate nothing, with the
 * reason named": an unreadable tier or an unreadable path classification is
 * never read as "no sensitive modules were touched", and never as licence to
 * spend a model on an explainer nobody asked for.
 *
 * TRD Reference: docs/TRD/TRD-2026-70e784f2-code-review-process.md#trd-043
 */

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

/** The one tier that gets an offer. */
const OFFER_TIER = 'high';

function refused(reason) {
  return {
    ok: false,
    offered: false,
    tier: null,
    modules: [],
    accepted: [],
    generate: [],
    unknownRequested: [],
    reason,
    warnings: [],
  };
}

/** The effective tier word, from a tier result or a bare word. `null` when it cannot be read. */
function readTier(value) {
  if (isText(value)) return value.trim().toLowerCase();
  if (!isObject(value) || value.ok === false) return null;
  const word = isText(value.effectiveTier) ? value.effectiveTier : value.tier;
  return isText(word) ? word.trim().toLowerCase() : null;
}

/**
 * The per-path records to read: a `classifyPaths` result, or the bare
 * `paths[]` array from one. `null` when the classification cannot be read --
 * including a classification that refused its own input.
 */
function readPathRecords(value) {
  if (Array.isArray(value)) return value.every(isObject) ? value : null;
  if (!isObject(value) || value.ok === false || !Array.isArray(value.paths)) return null;
  return value.paths.every(isObject) ? value.paths : null;
}

/**
 * The module a sensitive path belongs to: the declaration or default entry
 * that matched it, so two files under one sensitive area are offered once.
 * A sensitive path with no readable match is its own module -- it is never
 * dropped from the offer.
 */
function moduleOf(record) {
  if (isText(record.matchedBy)) return record.matchedBy.trim();
  return isText(record.path) ? record.path.trim() : null;
}

/**
 * Decide what the review report offers, and what an accepted offer generates.
 *
 * @param {Object} input
 * @param {Object|string} input.tier      The `effectiveTier` result, or the tier word.
 * @param {Object|Object[]} input.paths   A `classifyPaths` result, or its `paths[]` records.
 * @param {string[]} [input.requested]    Module names (or paths inside them) a person asked for.
 * @returns {{ok:boolean, offered:boolean, tier:string|null,
 *   modules:Array<{module:string, paths:string[], source:string|null}>,
 *   accepted:string[], generate:string[], unknownRequested:string[],
 *   reason:string, warnings:string[]}}
 */
function offerExplainers(input) {
  if (!isObject(input)) return refused('invalid-input');

  const tier = readTier(input.tier);
  if (tier === null) return refused('unreadable-tier');

  const records = readPathRecords(input.paths);
  if (records === null) return { ...refused('unreadable-paths'), tier };

  if (input.requested !== undefined && input.requested !== null && !Array.isArray(input.requested)) {
    return { ...refused('unreadable-requested'), tier };
  }
  const requested = Array.isArray(input.requested)
    ? input.requested.filter((entry) => isText(entry)).map((entry) => entry.trim())
    : [];
  const warnings = [];
  if (Array.isArray(input.requested) && requested.length !== input.requested.length) {
    warnings.push('unreadable-requested-entry');
  }

  // AC-022-3, second half: no offer below High, and nothing to accept.
  if (tier !== OFFER_TIER) {
    if (requested.length > 0) warnings.push('request-outside-offer');
    return {
      ok: true,
      offered: false,
      tier,
      modules: [],
      accepted: [],
      generate: [],
      unknownRequested: requested,
      reason: 'not-high-tier',
      warnings,
    };
  }

  // --- One offer per touched sensitive module, in the order reported ------
  const modules = [];
  const byName = new Map();
  for (const record of records) {
    if (record.sensitive !== true) continue;
    const name = moduleOf(record);
    if (name === null) {
      warnings.push('unreadable-sensitive-path');
      continue;
    }
    const path = isText(record.path) ? record.path.trim() : null;
    if (!byName.has(name)) {
      const entry = { module: name, paths: [], source: isText(record.source) ? record.source : null };
      byName.set(name, entry);
      modules.push(entry);
    }
    const entry = byName.get(name);
    if (path !== null && !entry.paths.includes(path)) entry.paths.push(path);
  }

  if (modules.length === 0) {
    return {
      ok: true,
      offered: false,
      tier,
      modules: [],
      accepted: [],
      generate: [],
      unknownRequested: requested,
      reason: 'no-sensitive-modules-touched',
      warnings,
    };
  }

  // --- What a person actually accepted ------------------------------------
  const accepted = [];
  const unknownRequested = [];
  for (const wanted of requested) {
    const match = modules.find((entry) => entry.module === wanted || entry.paths.includes(wanted));
    if (match === undefined) {
      unknownRequested.push(wanted);
      continue;
    }
    if (!accepted.includes(match.module)) accepted.push(match.module);
  }

  return {
    ok: true,
    offered: true,
    tier,
    modules,
    accepted,
    // An offer is an invitation, never a job: nothing is generated unasked.
    generate: accepted.slice(),
    unknownRequested,
    reason: accepted.length > 0 ? 'offer-accepted' : 'offered-awaiting-request',
    warnings,
  };
}

module.exports = { offerExplainers, OFFER_TIER };
