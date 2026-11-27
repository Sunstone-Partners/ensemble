'use strict';

/**
 * TRD-005: resume-detection scan for /ensemble:author-playwright-tests.
 * Extended by TRD-023 (AC-011-2: full-session idempotence) — see that
 * section below the original TRD-005 doc block.
 *
 * Scans the consuming application's E2E test project's *.spec.ts files for the per-AC "@hash:" tag this
 * repo's own Gherkin generator already uses (see
 * packages/product/lib/feature-gen.js renderScenario(), which emits
 * "@AC-001-1 @hash:<12-hex>" above each Scenario:). TRD-015's
 * traceability-tagger.js is the sibling module that *writes* this tag once a
 * test is confirmed and landed; this module only *reads* it, so an
 * interrupted authoring session can resume without re-proposing tests for
 * ACs that are already confirmed.
 *
 * Tag shape in a .spec.ts file (TypeScript has no Gherkin comment line, so
 * the tag lives in a `//` comment directly above, or on the same line as,
 * the AC id it belongs to):
 *
 *   // @AC-001-1 @hash:abcdef123456
 *   test('...', async ({ page }) => { ... });
 *
 * Matching rule (deliberately simple): an AC id (AC-NNN, AC-NNN-M, or
 * AC-NNNa shape, matching packages/development/lib/trd-parser.js's
 * AC_ID_RE) is "confirmed" if a `@hash:<hex>` tag appears on the same line
 * as the AC id, or on the line immediately before/after it. Anything else
 * is "pending".
 *
 * Pure matching logic (findTaggedAcIds) takes text, not files — the disk
 * I/O is isolated to the thin scanConfirmedAcsInFiles wrapper below.
 *
 * --- TRD-023 extension: recognizing 'manual' and 'ac-gap' ACs on resume ---
 *
 * AC-011-2 requires that a story where every AC is already confirmed OR
 * manual (manual-ac-tracker.js, TRD-012) OR ac-gap (ac-gap-detector.js,
 * TRD-020) is reported as "already complete" with NO changes on a re-run —
 * including a re-run after a full SESSION RESTART, not just mid-session.
 * Both manual-ac-tracker.js and ac-gap-detector.js are purely in-memory:
 * neither writes anything to the spec file, so their records don't survive
 * a session restart on their own. Since a manual/gap AC has no associated
 * `[Test]`/test() method, there's no natural anchor line to hang a tag off
 * of the way `@hash:` hangs off a real test method's comment.
 *
 * This module resolves that by ALSO recognizing two lightweight marker tags
 * that can appear ANYWHERE in a spec file as their own standalone comment
 * line (not attached to any test method) — e.g. a tracking block appended
 * near the top of the file:
 *
 *   // @AC-017-1 @manual
 *   // @AC-009-1 @ac-gap
 *
 * Matching rule: SAME LINE ONLY (unlike `@hash:`'s ±1-line window) — see
 * findAcIdsByTag()'s `adjacent` parameter doc for why a stacked tracking
 * block requires this.
 *
 * SCOPE BOUNDARY (deliberate, matching ac-gap-detector.js's own "what this
 * module does and doesn't do" precedent): this module only *reads* these
 * marker tags if/when they're present in a spec file. It does NOT write
 * them. Appending `// @AC-xxx @manual` / `// @AC-xxx @ac-gap` marker lines
 * into a spec file so they survive a session restart is a job for a FUTURE
 * task (extending spec-writer.js and/or traceability-tagger.js) — those two
 * files are explicitly NOT TRD-023's target files. Until that write side
 * exists, manual/gap coverage from a session that never persisted these
 * markers will not be recognized on the next resume — same known gap as
 * any other read-only detector waiting on its write-side counterpart.
 *
 * New API surface for TRD-023: scanAcCoverage() (a superset of
 * scanConfirmedAcs() that also reports manual/gap) and isStoryFullyCovered()
 * (the AC-011-2 check itself). scanConfirmedAcs()'s own `{confirmed,
 * pending}` return shape is left untouched — see its doc comment for why.
 */

const fs = require('fs');

// Mirrors packages/development/lib/trd-parser.js's AC_ID_RE shape.
const AC_ID_RE = /\bAC-\d+(?:-\d+|[a-z])?\b/gi;
const HASH_TAG_RE = /@hash:[0-9a-f]+/i;
const MANUAL_TAG_RE = /@manual\b/i;
const AC_GAP_TAG_RE = /@ac-gap\b/i;

/**
 * Find every AC id in `specText` that has `tagRe` on the same line as it (or,
 * when `adjacent` is true, the line directly before/after too). Shared
 * matching core behind findTaggedAcIds/findManualAcIds/findAcGapAcIds below.
 *
 * `adjacent` defaults to true (the original @hash: behavior: a test method's
 * AC id and its landed tag can legitimately sit one line apart). It must be
 * false for the TRD-023 marker tags (@manual/@ac-gap): those are designed as
 * a single, self-contained marker line (`// @AC-017-1 @manual`), and a
 * tracking block stacks several such lines back-to-back —
 *
 *   // @AC-017-1 @manual
 *   // @AC-009-1 @ac-gap
 *
 * — so a ±1-line window would wrongly treat each marker line as "adjacent"
 * to its neighbor's tag too, cross-contaminating AC-017-1 with @ac-gap and
 * AC-009-1 with @manual. Same-line-only matching avoids that entirely.
 *
 * @param {string} specText - contents of one .spec.ts file
 * @param {RegExp} tagRe - the marker tag to look for (e.g. HASH_TAG_RE)
 * @param {boolean} [adjacent=true] - also check the line before/after
 * @returns {Set<string>} uppercased AC ids matched to a `tagRe` occurrence
 */
function isMarkerLine(line) {
  return MANUAL_TAG_RE.test(line) || AC_GAP_TAG_RE.test(line);
}

function findAcIdsByTag(specText, tagRe, adjacent = true) {
  const lines = String(specText || '').split(/\r\n|\r|\n/);
  const found = new Set();

  lines.forEach((line, i) => {
    const acMatches = line.match(AC_ID_RE);
    if (!acMatches) return;

    // A @manual/@ac-gap marker line is self-contained (see findAcIdsByTag's
    // doc comment) -- its own AC id must never borrow a tag from a
    // neighboring line's adjacency window, or a marker line sitting next to
    // an unrelated AC's @hash:-tagged line would wrongly also read as
    // confirmed via that neighbor.
    const hasTag =
      tagRe.test(line) ||
      (adjacent && !isMarkerLine(line) && (tagRe.test(lines[i - 1] || '') || tagRe.test(lines[i + 1] || '')));

    if (!hasTag) return;
    for (const id of acMatches) found.add(id.toUpperCase());
  });

  return found;
}

/**
 * Find every AC id in `specText` that is tagged with an adjacent `@hash:`
 * marker (same line, or the line directly before/after).
 *
 * @param {string} specText - contents of one .spec.ts file
 * @returns {Set<string>} uppercased AC ids confirmed by a @hash: tag
 */
function findTaggedAcIds(specText) {
  return findAcIdsByTag(specText, HASH_TAG_RE);
}

/**
 * Find every AC id in `specText` marked `@manual` (TRD-023 extension — see
 * module header's "TRD-023 extension" section for the marker-tag shape and
 * scope boundary). Same-line match only — see findAcIdsByTag()'s `adjacent`
 * doc for why a ±1-line window is wrong for this tag.
 *
 * @param {string} specText - contents of one .spec.ts file
 * @returns {Set<string>} uppercased AC ids marked manual
 */
function findManualAcIds(specText) {
  return findAcIdsByTag(specText, MANUAL_TAG_RE, false);
}

/**
 * Find every AC id in `specText` flagged `@ac-gap` (TRD-023 extension — see
 * module header's "TRD-023 extension" section for the marker-tag shape and
 * scope boundary). Same-line match only — see findAcIdsByTag()'s `adjacent`
 * doc for why a ±1-line window is wrong for this tag.
 *
 * @param {string} specText - contents of one .spec.ts file
 * @returns {Set<string>} uppercased AC ids flagged as an ac-gap
 */
function findAcGapAcIds(specText) {
  return findAcIdsByTag(specText, AC_GAP_TAG_RE, false);
}

/**
 * Resume-detection scan: given the spec file text(s) already on disk and
 * the AC ids the session expects to cover, report which ACs already have a
 * confirmed, landed test (tagged with @hash:) vs. which are still pending
 * and need to be proposed this session.
 *
 * Return shape is exactly `{confirmed, pending}` — deliberately UNCHANGED by
 * the TRD-023 extension below (tests/ado-sync-resilience.test.js asserts
 * this exact key set via `Object.keys(scan).sort()`, as part of its
 * status-vocabulary collision check, so this function's contract is frozen).
 * scanAcCoverage() below is the TRD-023 superset with manual/gap awareness.
 *
 * @param {string|string[]} specTexts - one spec file's text, or an array of them
 * @param {string[]} expectedAcIds - all AC ids the session expects to cover
 * @returns {{confirmed: string[], pending: string[]}}
 */
function scanConfirmedAcs(specTexts, expectedAcIds) {
  const texts = Array.isArray(specTexts) ? specTexts : [specTexts];
  const confirmedSet = new Set();
  for (const text of texts) {
    for (const id of findTaggedAcIds(text)) confirmedSet.add(id);
  }

  const expected = (expectedAcIds || []).map((id) => String(id).toUpperCase());
  return {
    confirmed: expected.filter((id) => confirmedSet.has(id)),
    pending: expected.filter((id) => !confirmedSet.has(id)),
  };
}

/**
 * TRD-023 superset of scanConfirmedAcs(): also reports which expected ACs
 * are marked `@manual` or flagged `@ac-gap` (see module header's "TRD-023
 * extension" section), so a caller can determine full coverage across all
 * three legitimate "don't need a test written this session" outcomes, not
 * just `@hash:`-confirmed ones.
 *
 * A separate function rather than widening scanConfirmedAcs()'s own return
 * shape, because that shape is depended on elsewhere as an exact contract
 * (see scanConfirmedAcs()'s own doc comment) — this avoids reopening that.
 *
 * `pending` here is every expected AC in none of confirmed/manual/gap; when
 * no manual/gap markers are present in `specTexts` this reduces to exactly
 * scanConfirmedAcs()'s own `pending`.
 *
 * @param {string|string[]} specTexts - one spec file's text, or an array of them
 * @param {string[]} expectedAcIds - all AC ids the session expects to cover
 * @returns {{confirmed: string[], manual: string[], gap: string[], pending: string[]}}
 */
function scanAcCoverage(specTexts, expectedAcIds) {
  const texts = Array.isArray(specTexts) ? specTexts : [specTexts];
  const confirmedSet = new Set();
  const manualSet = new Set();
  const gapSet = new Set();
  for (const text of texts) {
    for (const id of findTaggedAcIds(text)) confirmedSet.add(id);
    for (const id of findManualAcIds(text)) manualSet.add(id);
    for (const id of findAcGapAcIds(text)) gapSet.add(id);
  }

  const expected = (expectedAcIds || []).map((id) => String(id).toUpperCase());
  const isCovered = (id) => confirmedSet.has(id) || manualSet.has(id) || gapSet.has(id);

  return {
    confirmed: expected.filter((id) => confirmedSet.has(id)),
    manual: expected.filter((id) => manualSet.has(id)),
    gap: expected.filter((id) => gapSet.has(id)),
    pending: expected.filter((id) => !isCovered(id)),
  };
}

/**
 * AC-011-2's core check: is every expected AC already covered by a
 * confirmed test, a manual marker, or an ac-gap marker — with nothing left
 * pending? When true, the calling orchestrator must make NO changes (no new
 * file writes, no new ADO calls) and instead report the story as already
 * complete (see session-summary.js's `alreadyComplete` support).
 *
 * @param {string[]} expectedAcIds - all AC ids the story expects to cover
 * @param {string|string[]} specTexts - one spec file's text, or an array of them
 * @returns {boolean} true only when `pending` would be empty
 */
function isStoryFullyCovered(expectedAcIds, specTexts) {
  return scanAcCoverage(specTexts, expectedAcIds).pending.length === 0;
}

/**
 * File-reading wrapper: scan actual *.spec.ts files on disk (e.g. a glob
 * over the consuming application's E2E test project) rather than in-memory text.
 *
 * @param {string[]} specFilePaths - paths to .spec.ts files
 * @param {string[]} expectedAcIds - all AC ids the session expects to cover
 * @param {object} [opts]
 * @param {(p: string) => string} [opts.readFileSync] - injectable file reader, for tests
 * @returns {{confirmed: string[], pending: string[]}}
 */
function scanConfirmedAcsInFiles(specFilePaths, expectedAcIds, opts = {}) {
  const readFileSync = opts.readFileSync || ((p) => fs.readFileSync(p, 'utf8'));
  const texts = (specFilePaths || []).map((p) => readFileSync(p));
  return scanConfirmedAcs(texts, expectedAcIds);
}

module.exports = {
  findTaggedAcIds,
  findManualAcIds,
  findAcGapAcIds,
  scanConfirmedAcs,
  scanAcCoverage,
  scanConfirmedAcsInFiles,
  isStoryFullyCovered,
};
