'use strict';

/**
 * TRD-035: grounded-marker extraction for /ensemble:author-playwright-tests'
 * post-failure environment-mismatch triage (found live-dogfooding this
 * feature: a QA/staging environment can be reachable — HTTP check passes —
 * while still not be running the branch under test at all, e.g. a per-branch
 * or per-developer deploy slot that was never actually deployed with this
 * branch's code. That failure mode looks IDENTICAL to a real regression: the
 * test runs and fails on real assertions, and nothing points at "wrong
 * deploy" as a possible cause. Confirmed on a real, live PR before this
 * fix — a failing assertion cost real debugging time before the actual
 * cause (wrong environment, not a code defect) was found.
 *
 * This module answers one narrow question with a pure function: given the
 * diff a REQ/AC was grounded in, what are some concrete, checkable strings
 * that SHOULD be present on the live page if — and only if — that diff's
 * code is actually running there? Whether any of them actually show up is an
 * agent action at conversation time (Playwright: looking at the live,
 * rendered page), not something a pure function can determine — matching
 * ac-gap-detector.js's precedent for exactly this "pure extraction here,
 * live judgment there" split.
 *
 * Deliberately generic — no assumption about markup conventions, frameworks,
 * CSS methodologies, or naming schemes belonging to any one consuming repo
 * (this is not specific to any one consuming application; per-branch/per-developer deploy slots
 * are a common pattern anyone with more than one deploy target can hit).
 * Extracts from ADDED lines only (a diff's `+` lines, never `-`/context):
 *   1. Quoted string literals of a plausible marker length — covers class
 *      names, data-testid values, aria-labels, arbitrary attribute values,
 *      whatever a real diff happens to add.
 *   2. Individual whitespace-separated tokens within a multi-value quoted
 *      string (e.g. a `class="nav-icon-stack legacy-nav"` attribute) — a
 *      single-class change inside a longer class list is a common case, and
 *      only the changed token itself may reliably appear on the live page.
 *   3. Plain text between HTML/JSX tags (`>some text<`) — a lot of real UI
 *      changes are literal visible-text changes (a button label, a heading)
 *      that never appear inside quotes at all.
 * No AST, no framework-specific parsing. Over-extracting a few noisy
 * candidates is fine — the caller only needs ONE real hit to conclude "yes,
 * this code is live." Under-extracting the one marker that would have
 * proven it is the actual failure mode this module exists to avoid.
 */

const MARKER_MIN_LENGTH = 3;
const MARKER_MAX_LENGTH = 80;

// Common words/literals that could appear in any diff regardless of whether
// its specific feature is live — a hit on these proves nothing, so they are
// never useful as environment-mismatch evidence.
const GENERIC_NOISE_WORDS = new Set([
  'true', 'false', 'null', 'undefined', 'div', 'span', 'button', 'a', 'the',
  'and', 'or', 'use client', 'use strict',
]);

// Quantified with `*` (not a minimum length) so a too-short quoted string
// (e.g. "a") still consumes its own closing quote as a real match — capping
// the length inside the quantifier instead let a failed short match's own
// closing quote get reinterpreted as the OPENING quote of a bogus match
// spanning into unrelated code up to the NEXT string literal on the line.
// Length/plausibility filtering happens after extraction instead.
const QUOTED_STRING_RE = /(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g;

// Plain text between tags, e.g. `>Submit Claim<` -- excludes `{`/`}` so a
// JSX expression slot (`{someVar}`) is never mistaken for literal text.
const TAG_INNER_TEXT_RE = />([^<>{}\n]{2,80})</g;

function isPlausibleMarker(token) {
  const trimmed = token.trim();
  if (trimmed.length < MARKER_MIN_LENGTH || trimmed.length > MARKER_MAX_LENGTH) return false;
  if (!/[a-zA-Z]/.test(trimmed)) return false; // pure punctuation/numbers/whitespace
  return !GENERIC_NOISE_WORDS.has(trimmed.toLowerCase());
}

/**
 * Extract candidate "grounded markers" from a unified diff string — plain
 * strings that should appear on the live page if this diff's code is
 * actually deployed there.
 *
 * @param {string} diff - a unified diff (e.g. one entry of
 *   implementation-grounding.js's groundImplementation() result `.diffs`)
 * @returns {string[]} deduplicated candidate marker strings, in first-seen order
 */
function extractGroundedMarkers(diff) {
  const text = String(diff || '');
  const addedLines = text
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'));

  const markers = new Set();

  for (const line of addedLines) {
    QUOTED_STRING_RE.lastIndex = 0;
    let m;
    while ((m = QUOTED_STRING_RE.exec(line)) !== null) {
      const value = m[2];
      if (isPlausibleMarker(value)) markers.add(value);

      if (/\s/.test(value)) {
        for (const token of value.split(/\s+/)) {
          if (isPlausibleMarker(token)) markers.add(token);
        }
      }
    }

    TAG_INNER_TEXT_RE.lastIndex = 0;
    while ((m = TAG_INNER_TEXT_RE.exec(line)) !== null) {
      const value = m[1].trim();
      if (isPlausibleMarker(value)) markers.add(value);
    }
  }

  return Array.from(markers);
}

/**
 * Build the human-readable hint surfaced to the QA engineer when a test
 * failed AND none of its grounded markers were found on the live page —
 * the leading hypothesis should be "wrong environment," not "code is broken."
 *
 * @param {object} input
 * @param {string[]} input.markersChecked - every candidate marker that was looked for
 * @param {string[]} [input.markersFound] - the subset actually found on the live page (omit/empty if none)
 * @returns {string|null} the hint to surface, or null when at least one marker was found
 *   (no reason to suspect an environment mismatch)
 */
function buildEnvironmentMismatchHint({ markersChecked, markersFound } = {}) {
  const checked = Array.isArray(markersChecked) ? markersChecked : [];
  const found = Array.isArray(markersFound) ? markersFound : [];

  if (found.length > 0) return null; // at least one grounded marker is live -- no mismatch signal
  if (checked.length === 0) return null; // nothing to check against -- no signal either way

  return (
    'This test failed, but none of the grounded implementation markers were found on the live ' +
    'page — this may mean the QA/staging environment is not running the branch under test ' +
    '(e.g. a per-branch or per-developer deploy slot that has not been deployed with this ' +
    "branch's code yet), not that the implementation is actually broken. Checked for: " +
    `${checked.map((m) => `"${m}"`).join(', ')}. Confirm the environment is running this ` +
    'branch before treating this failure as a real regression.'
  );
}

module.exports = { extractGroundedMarkers, buildEnvironmentMismatchHint };
