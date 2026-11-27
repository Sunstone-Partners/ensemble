'use strict';

/**
 * TRD-015: traceability tagging for /ensemble:author-playwright-tests (REQ-014).
 *
 * spec-writer.js (TRD-014) leaves a plain `// {acId}` comment above each
 * generated `[Test]` method as an anchor -- explicitly NOT the full
 * traceability tag (see spec-writer.js's own header comment). This module
 * turns that anchor into the real tag once an AC is confirmed: `@hash:<hash>`
 * (the drift-detection fingerprint), the PRD's `@<documentId>` tag, and the
 * owning `@REQ-NNN`, all landing on that same anchor line so later tooling
 * can match test to requirement (AC-014-1).
 *
 * Compatibility contract with resume-scan.js (TRD-005, already shipped):
 * resume-scan.js's findTaggedAcIds() considers an AC id "confirmed" if a
 * `@hash:[0-9a-f]+` tag appears on the SAME line as the AC id, or on a line
 * immediately before/after it (case-insensitive). This module always keeps
 * the AC id and its `@hash:` tag on one line, so it satisfies that contract
 * unconditionally, not just in the common case.
 *
 * Hashing convention: reuses the exact approach packages/product/lib/
 * feature-gen.js's hashAc() established (sha256 of normalized AC text,
 * truncated to 12 hex chars) -- replicated locally rather than imported
 * cross-package, matching TRD-002's prd-ac-parser.js precedent (see that
 * file's header for the same reasoning).
 *
 * Scope (Implementation AC for TRD-015):
 *   - AC-014-1: a saved test file carries a comment/attribute tagging the
 *     REQ-NNN, AC-NNN-M, and the PRD's Document ID.
 *   - AC-014-2: tagging a new AC's anchor line never disturbs the tags
 *     already present for other ACs in the same file -- every other line,
 *     byte for byte, is untouched.
 *   - AC-007-2 (TRD-018's share of it): the `@ado-testcase:<id>` tag rides on
 *     that same line, is idempotent on a re-sync with the same id, and
 *     refuses to silently overwrite a different one already there.
 *
 * TRD-018 (AC-007-2) extends this module with the ADO half of the tag line:
 * addAdoTestCaseTag appends an `@ado-testcase:<id>` tag to an already-tagged
 * line once a test syncs to Azure DevOps, and findAdoTestCaseTag reads that
 * tag back before a re-sync. Together they let ado-test-case-sync.js's
 * planTestCaseSync (TRD-017) be handed the SAME id on a later sync, so it
 * updates that Test Case in place rather than creating a duplicate or
 * attempting a title-match lookup.
 *
 * Convention: plain functions over plain strings (no C# AST), matching this
 * package's existing modules (spec-writer.js, resume-scan.js). No disk I/O --
 * this module operates on file content already read into memory.
 */

const crypto = require('crypto');

/** Throw a clear error if `value` isn't a non-empty string. */
function assertNonEmptyString(label, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string (got: ${JSON.stringify(value)})`);
  }
}

/**
 * Normalize AC text the same way feature-gen.js's normalizeAcText does for
 * free-form text: lowercased, whitespace-collapsed, trimmed -- so cosmetic
 * edits don't register as drift.
 */
function normalizeAcText(acText) {
  return String(acText || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 12-hex-char sha256 prefix of the normalized AC text (feature-gen.js's hashAc convention). */
function hashAcText(acText) {
  return crypto.createHash('sha256').update(normalizeAcText(acText)).digest('hex').slice(0, 12);
}

/** `@<documentId>` tag: lowercase, non-alphanumeric runs replaced with hyphens (feature-gen.js's docIdTag convention). */
function docIdTag(documentId) {
  return '@' + String(documentId || 'prd').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find spec-writer.js's plain `// {acId}` anchor line for one specific AC id
 * and replace it with the full traceability tag line, leaving every other
 * byte in `fileContent` untouched (AC-014-2).
 *
 * @param {string} fileContent - the spec file's full text (as produced/appended
 *   by spec-writer.js, containing a `// {acId}` anchor comment)
 * @param {object} details
 * @param {string} details.acId - e.g. "AC-006-1" -- must match the anchor
 *   spec-writer.js left verbatim (matched case-insensitively)
 * @param {string} details.acText - the AC's raw text, hashed for drift detection
 * @param {string} details.reqId - e.g. "REQ-006"
 * @param {string} details.documentId - the PRD's Document ID (prd-ac-parser.js's parsePrdAcs() output)
 * @returns {string} full updated file content, with only the one anchor line changed
 * @throws {Error} if any required field is missing, fileContent is empty, the
 *   anchor for `acId` can't be found, or more than one anchor for `acId` exists
 *   (this module never guesses which line to tag)
 */
function tagTestMethod(fileContent, details = {}) {
  const { acId, acText, reqId, documentId } = details;
  assertNonEmptyString('acId', acId);
  assertNonEmptyString('acText', acText);
  assertNonEmptyString('reqId', reqId);
  assertNonEmptyString('documentId', documentId);
  if (typeof fileContent !== 'string' || fileContent === '') {
    throw new Error('tagTestMethod requires non-empty fileContent to search for an existing anchor comment.');
  }

  // spec-writer.js's anchor line is exactly `{indent}// {acId}` -- nothing
  // else on the line. Matching to end-of-line (allowing an optional trailing
  // \r for CRLF files) also guards against a prefix collision, e.g. this
  // regex for "AC-006-1" will NOT match a "// AC-006-10" line, since the "0"
  // following "AC-006-1" isn't trailing whitespace/EOL.
  const anchorRe = new RegExp(`^([ \\t]*)//[ \\t]*${escapeRegExp(acId)}[ \\t]*\\r?$`, 'gmi');

  const matches = [...fileContent.matchAll(anchorRe)];
  if (matches.length === 0) {
    throw new Error(
      `tagTestMethod: could not find an existing "// ${acId}" anchor comment in fileContent -- ` +
        'spec-writer.js must write the plain anchor before this module can tag it.'
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `tagTestMethod: found ${matches.length} "// ${acId}" anchor comments in fileContent -- ` +
        'expected exactly one; refusing to guess which one to tag.'
    );
  }

  const match = matches[0];
  const indent = match[1];
  const hash = hashAcText(acText);
  const tagLine = `${indent}// ${acId} @hash:${hash} ${docIdTag(documentId)} @${reqId}`;

  const start = match.index;
  const end = start + match[0].length;
  return fileContent.slice(0, start) + tagLine + fileContent.slice(end);
}

/**
 * `@ado-testcase:<id>` tag: written once an AC's Test Case is synced to
 * Azure DevOps (TRD-017's planTestCaseSync/recordSyncedTestCase), so a later
 * re-sync of the SAME test updates that SAME Test Case in place rather than
 * creating a duplicate or attempting a title-match lookup (AC-007-2). It
 * rides on the exact line tagTestMethod already wrote -- one more
 * space-separated token appended after the existing `@hash:`/doc-id/REQ
 * tokens -- so resume-scan.js's `@hash:` line-adjacency contract is
 * completely unaffected by its presence.
 */
const ADO_TESTCASE_TAG_RE = /@ado-testcase:(\S+)/i;
// Azure DevOps work item ids are always numeric -- this doubles as the
// "invalid id format" guard (e.g. rejects '' and non-numeric strings).
const ADO_TESTCASE_ID_FORMAT_RE = /^\d+$/;

/** Validate + normalize an ADO Test Case id to its canonical trimmed-string form. */
function normalizeAdoTestCaseId(adoTestCaseId) {
  if (
    (typeof adoTestCaseId !== 'string' && typeof adoTestCaseId !== 'number') ||
    String(adoTestCaseId).trim() === ''
  ) {
    throw new Error(
      `adoTestCaseId must be a non-empty string or number (got: ${JSON.stringify(adoTestCaseId)})`
    );
  }
  const idStr = String(adoTestCaseId).trim();
  if (!ADO_TESTCASE_ID_FORMAT_RE.test(idStr)) {
    throw new Error(
      `adoTestCaseId must be a numeric Azure DevOps work item id (got: ${JSON.stringify(adoTestCaseId)})`
    );
  }
  return idStr;
}

/**
 * Find every tagTestMethod-tagged line for `acId`, whatever else (`@hash:`,
 * doc-id, `@REQ`, an already-present `@ado-testcase:`) it carries.
 *
 * Same prefix-collision guard as tagTestMethod's anchorRe -- `(?![\w-])`
 * immediately after `acId` -- so searching for "AC-006-1" never matches a
 * line tagged for "AC-006-10" or "AC-006-1a". Unlike anchorRe, this does NOT
 * require end-of-line right after `acId`, since the line it must match here
 * already has trailing `@hash:`/doc-id/`@REQ` tokens (and possibly an
 * `@ado-testcase:` one too).
 *
 * Group 1: leading indent. Group 2: everything after `acId` up to (not
 * including) any trailing `\r`. Group 3: that trailing `\r`, if present --
 * kept separate so callers can insert new content immediately before it
 * instead of rebuilding the line (and risking eating a CRLF's `\r`).
 *
 * @returns {RegExpMatchArray[]} every match (callers decide how to react to
 *   zero/more-than-one -- this never silently picks one)
 */
function findTaggedLineMatches(fileContent, acId) {
  const re = new RegExp(`^([ \\t]*)//[ \\t]*${escapeRegExp(acId)}(?![\\w-])([^\\r\\n]*)(\\r)?$`, 'gmi');
  return [...fileContent.matchAll(re)];
}

/**
 * Read the `@ado-testcase:<id>` tag already recorded for `acId`, if any --
 * mirrors resume-scan.js's findTaggedAcIds() read-only approach, but for
 * this tag. This is what a caller runs BEFORE planTestCaseSync (ado-test-
 * case-sync.js, TRD-017) to decide whether to pass `existingAdoTestCaseId`.
 *
 * @param {string} fileContent - the spec file's full text
 * @param {string} acId - e.g. "AC-007-2"
 * @returns {string|null} the tagged ADO Test Case id, or null if `acId`
 *   isn't tagged with one yet (whether because it isn't traceability-tagged
 *   at all, or is tagged but never synced to ADO)
 * @throws {Error} if `acId` is missing/empty, `fileContent` isn't a string,
 *   or more than one line is tagged for `acId` (never guesses which)
 */
function findAdoTestCaseTag(fileContent, acId) {
  assertNonEmptyString('acId', acId);
  if (typeof fileContent !== 'string') {
    throw new Error(`findAdoTestCaseTag requires fileContent to be a string (got: ${JSON.stringify(fileContent)})`);
  }
  if (fileContent === '') return null;

  const matches = findTaggedLineMatches(fileContent, acId);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `findAdoTestCaseTag: found ${matches.length} "// ${acId}" lines in fileContent -- ` +
        'expected at most one; refusing to guess which one to read.'
    );
  }

  const tagMatch = (matches[0][2] || '').match(ADO_TESTCASE_TAG_RE);
  return tagMatch ? tagMatch[1] : null;
}

/**
 * Append an `@ado-testcase:<id>` tag to the ALREADY-tagged line for `acId`
 * (i.e. a line tagTestMethod has already written), so a later re-sync
 * updates that same Azure DevOps Test Case in place (AC-007-2) instead of
 * creating a duplicate. Only that one line is ever touched, and only by
 * inserting the new token -- every other byte on the line, and every other
 * line in the file, is untouched.
 *
 * Idempotent by design: calling this again with the SAME id is a no-op
 * (returns `fileContent` completely unchanged) -- exactly the "re-sync
 * updates the same Test Case" case AC-007-2 describes. Calling it with a
 * DIFFERENT id than what's already tagged is treated as an error rather
 * than a silent overwrite: a legitimate re-sync always re-reads the
 * existing id first (via findAdoTestCaseTag) and passes that SAME id
 * straight through to planTestCaseSync/here, so it would never actually
 * reach this branch in normal operation. Seeing a genuinely different id
 * means the spec file was hand-edited/corrupted, or two ADO Test Cases got
 * created for one AC somewhere upstream -- overwriting silently would orphan
 * the original Test Case, which is exactly what AC-007-2 rules out. Fail
 * loudly instead of guessing which id is "right".
 *
 * @param {string} fileContent - the spec file's full text, already carrying
 *   a tagTestMethod-produced `// {acId} @hash:... ...` line
 * @param {string} acId - e.g. "AC-007-2" -- must match the tagged line's AC
 *   id verbatim (matched case-insensitively)
 * @param {string|number} adoTestCaseId - the Azure DevOps Test Case work
 *   item id (numeric)
 * @returns {string} full updated file content, with only the one tagged
 *   line changed (or byte-identical to `fileContent` if already tagged with
 *   this exact id)
 * @throws {Error} if any argument is invalid, the tagged line for `acId`
 *   can't be found unambiguously, the line found isn't yet traceability-
 *   tagged (no `@hash:`), or the line is already tagged with a DIFFERENT
 *   ADO Test Case id
 */
function addAdoTestCaseTag(fileContent, acId, adoTestCaseId) {
  assertNonEmptyString('acId', acId);
  if (typeof fileContent !== 'string' || fileContent === '') {
    throw new Error('addAdoTestCaseTag requires non-empty fileContent to search for an existing tagged line.');
  }
  const idStr = normalizeAdoTestCaseId(adoTestCaseId);

  const matches = findTaggedLineMatches(fileContent, acId);
  if (matches.length === 0) {
    throw new Error(
      `addAdoTestCaseTag: could not find a "// ${acId}" line in fileContent -- ` +
        'the AC must be traceability-tagged (tagTestMethod) before an ADO Test Case id can be attached.'
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `addAdoTestCaseTag: found ${matches.length} "// ${acId}" lines in fileContent -- ` +
        'expected exactly one; refusing to guess which one to tag.'
    );
  }

  const match = matches[0];
  const restOfLine = match[2] || '';
  if (!/@hash:[0-9a-f]+/i.test(restOfLine)) {
    throw new Error(
      `addAdoTestCaseTag: "// ${acId}" line has no "@hash:" traceability tag -- ` +
        'run tagTestMethod on this AC before attaching an ADO Test Case id.'
    );
  }

  const existingTagMatch = restOfLine.match(ADO_TESTCASE_TAG_RE);
  if (existingTagMatch) {
    const existingId = existingTagMatch[1];
    if (existingId === idStr) {
      return fileContent; // already tagged with this exact id -- idempotent no-op
    }
    throw new Error(
      `addAdoTestCaseTag: "// ${acId}" is already tagged with @ado-testcase:${existingId}, ` +
        `which differs from the requested id ${idStr} -- refusing to silently overwrite ` +
        "(see this function's doc comment for why)."
    );
  }

  // Insert right before any trailing \r (group 3), never rebuilding the rest
  // of the line, so every other byte on it -- and every other line -- survives.
  const cr = match[3] || '';
  const insertPos = match.index + match[0].length - cr.length;
  return fileContent.slice(0, insertPos) + ` @ado-testcase:${idStr}` + fileContent.slice(insertPos);
}

module.exports = {
  tagTestMethod,
  hashAcText,
  normalizeAcText,
  docIdTag,
  addAdoTestCaseTag,
  findAdoTestCaseTag,
};

// ponytail self-check: `node packages/e2e-testing/lib/traceability-tagger.js`
// exercises the tag/preserve/error paths, plus the resume-scan.js
// compatibility contract directly -- no separate test file yet (TRD-015-TEST
// is a separate later task that will formalize this into Jest).
if (require.main === module) {
  const assert = require('assert');
  const { scaffoldNewSpecFile, appendTestMethod } = require('./spec-writer');
  const { findTaggedAcIds } = require('./resume-scan');

  const scaffolded = scaffoldNewSpecFile({
    className: 'LoginTests',
    baseClass: 'AuthenticatedPageTest',
    acId: 'AC-006-1',
    testName: 'Should_Redirect_To_Login_When_Unauthenticated',
  });
  const withSecondAc = appendTestMethod(scaffolded, {
    acId: 'AC-006-2',
    testName: 'Should_Show_Error_On_Bad_Password',
    testBody: 'await Page.FillAsync("#password", "wrong");',
  });

  // --- AC-014-1: tagging carries AC id, hash, doc id, and REQ id ---
  const tagged = tagTestMethod(withSecondAc, {
    acId: 'AC-006-1',
    acText: 'Given an unauthenticated user, when they load a protected page, then they are redirected to login.',
    reqId: 'REQ-006',
    documentId: 'PRD-2026-abc123',
  });
  assert.ok(tagged.includes('// AC-006-1 @hash:'));
  assert.ok(tagged.includes('@prd-2026-abc123'));
  assert.ok(tagged.includes('@REQ-006'));
  // untagged AC-006-2's plain anchor is still there, untouched
  assert.ok(tagged.includes('// AC-006-2\n') || tagged.includes('// AC-006-2\r\n'));

  // resume-scan.js must recognize the tagged AC as confirmed, and the
  // untagged one as still pending -- the actual reader contract, not just a
  // string-shape assumption.
  const afterFirstTag = findTaggedAcIds(tagged);
  assert.ok(afterFirstTag.has('AC-006-1'));
  assert.ok(!afterFirstTag.has('AC-006-2'));

  // --- AC-014-2: tagging a second AC preserves the first AC's tag verbatim ---
  const taggedBoth = tagTestMethod(tagged, {
    acId: 'AC-006-2',
    acText: 'Given a bad password, when the user submits login, then an error is shown.',
    reqId: 'REQ-006',
    documentId: 'PRD-2026-abc123',
  });
  assert.ok(taggedBoth.includes('// AC-006-1 @hash:')); // first tag untouched
  assert.ok(taggedBoth.includes('// AC-006-2 @hash:')); // second tag added
  const afterBothTags = findTaggedAcIds(taggedBoth);
  assert.ok(afterBothTags.has('AC-006-1'));
  assert.ok(afterBothTags.has('AC-006-2'));
  // every line outside the two anchor lines is byte-for-byte identical
  const stripAnchorLines = (s) =>
    s
      .split(/\r\n|\r|\n/)
      .filter((line) => !/\/\/\s*AC-006-[12]\b/i.test(line))
      .join('\n');
  assert.strictEqual(stripAnchorLines(taggedBoth), stripAnchorLines(withSecondAc));

  // hashing is whitespace/case-insensitive (normalizeAcText), so cosmetic AC
  // text edits produce the same hash -- same convention as feature-gen.js
  assert.strictEqual(
    hashAcText('Given an unauthenticated user, when they load a protected page.'),
    hashAcText('given an unauthenticated user,   when they load a protected page.  ')
  );

  // --- error paths ---
  assert.throws(
    () => tagTestMethod(withSecondAc, { acId: 'AC-999-1', acText: 'x', reqId: 'REQ-006', documentId: 'PRD-1' }),
    /could not find an existing "\/\/ AC-999-1" anchor/
  );
  assert.throws(
    () => tagTestMethod(withSecondAc, { acText: 'x', reqId: 'REQ-006', documentId: 'PRD-1' }),
    /acId must be a non-empty string/
  );
  assert.throws(
    () => tagTestMethod('', { acId: 'AC-006-1', acText: 'x', reqId: 'REQ-006', documentId: 'PRD-1' }),
    /requires non-empty fileContent/
  );
  // duplicate anchors for the same acId (e.g. hand-edited/corrupted file) -- refuse to guess
  assert.throws(
    () =>
      tagTestMethod(withSecondAc + '\n// AC-006-1\n', {
        acId: 'AC-006-1',
        acText: 'x',
        reqId: 'REQ-006',
        documentId: 'PRD-1',
      }),
    /found 2 "\/\/ AC-006-1" anchor comments/
  );

  // --- hashAcText: matches feature-gen.js's hashAc convention (sha256, 12 hex chars) ---
  assert.strictEqual(hashAcText('  Some Text  ').length, 12);
  assert.strictEqual(hashAcText('Some Text'), hashAcText('some   text')); // normalized before hashing
  assert.match(hashAcText('Some Text'), /^[0-9a-f]{12}$/);

  // --- AC-007-2 (TRD-018): addAdoTestCaseTag / findAdoTestCaseTag ---

  // not yet synced -- findAdoTestCaseTag reports null, doesn't invent one
  assert.strictEqual(findAdoTestCaseTag(taggedBoth, 'AC-006-1'), null);

  // first sync: appends the tag to AC-006-1's line only
  const syncedOnce = addAdoTestCaseTag(taggedBoth, 'AC-006-1', 12345);
  assert.ok(syncedOnce.includes('// AC-006-1 @hash:'));
  assert.ok(syncedOnce.includes('@ado-testcase:12345'));
  assert.strictEqual(findAdoTestCaseTag(syncedOnce, 'AC-006-1'), '12345');
  assert.strictEqual(findAdoTestCaseTag(syncedOnce, 'AC-006-2'), null); // untouched
  // every line outside AC-006-1's is byte-for-byte identical to before syncing
  const stripAdoLine = (s) =>
    s
      .split(/\r\n|\r|\n/)
      .filter((line) => !/\/\/\s*AC-006-1\b/i.test(line))
      .join('\n');
  assert.strictEqual(stripAdoLine(syncedOnce), stripAdoLine(taggedBoth));

  // re-sync with the SAME id (number or string) is idempotent: byte-identical
  // result, never a duplicate token -- the AC-007-2 "update in place" case
  assert.strictEqual(addAdoTestCaseTag(syncedOnce, 'AC-006-1', 12345), syncedOnce);
  assert.strictEqual(addAdoTestCaseTag(syncedOnce, 'AC-006-1', '12345'), syncedOnce);
  assert.strictEqual((syncedOnce.match(/@ado-testcase:/g) || []).length, 1);

  // re-sync with a DIFFERENT id is a loud error, never a silent overwrite
  assert.throws(
    () => addAdoTestCaseTag(syncedOnce, 'AC-006-1', 99999),
    /already tagged with @ado-testcase:12345.*differs from the requested id 99999/
  );

  // --- error paths ---
  // no anchor for this AC at all
  assert.throws(
    () => addAdoTestCaseTag(taggedBoth, 'AC-999-1', 1),
    /could not find a "\/\/ AC-999-1" line/
  );
  assert.strictEqual(findAdoTestCaseTag(taggedBoth, 'AC-999-1'), null);

  // anchor present but not yet traceability-tagged (no @hash:) -- addAdoTestCaseTag refuses;
  // findAdoTestCaseTag is a pure reader and just reports null instead
  assert.throws(
    () => addAdoTestCaseTag(withSecondAc, 'AC-006-2', 1),
    /has no "@hash:" traceability tag/
  );
  assert.strictEqual(findAdoTestCaseTag(withSecondAc, 'AC-006-2'), null);

  // prefix collision safety: syncing "AC-006-1" never touches a tagged line for "AC-006-10"
  const withTenthAc = tagTestMethod(
    appendTestMethod(taggedBoth, {
      acId: 'AC-006-10',
      testName: 'Should_Handle_A_Tenth_Case',
      testBody: 'await Page.ClickAsync("#tenth");',
    }),
    { acId: 'AC-006-10', acText: 'A tenth case.', reqId: 'REQ-006', documentId: 'PRD-2026-abc123' }
  );
  const collisionSynced = addAdoTestCaseTag(withTenthAc, 'AC-006-1', 777);
  assert.strictEqual(findAdoTestCaseTag(collisionSynced, 'AC-006-10'), null); // untouched by the AC-006-1 sync
  assert.strictEqual(findAdoTestCaseTag(collisionSynced, 'AC-006-1'), '777');

  // invalid id formats
  assert.throws(
    () => addAdoTestCaseTag(taggedBoth, 'AC-006-1', ''),
    /adoTestCaseId must be a non-empty string or number/
  );
  assert.throws(
    () => addAdoTestCaseTag(taggedBoth, 'AC-006-1', null),
    /adoTestCaseId must be a non-empty string or number/
  );
  assert.throws(
    () => addAdoTestCaseTag(taggedBoth, 'AC-006-1', 'TC-abc'),
    /adoTestCaseId must be a numeric Azure DevOps work item id/
  );

  // missing/invalid required args
  assert.throws(() => addAdoTestCaseTag(taggedBoth, '', 1), /acId must be a non-empty string/);
  assert.throws(() => addAdoTestCaseTag('', 'AC-006-1', 1), /requires non-empty fileContent/);
  assert.throws(() => findAdoTestCaseTag(taggedBoth, ''), /acId must be a non-empty string/);
  assert.throws(() => findAdoTestCaseTag(123, 'AC-006-1'), /requires fileContent to be a string/);

  // duplicate tagged lines for the same acId (hand-edited/corrupted file) -- refuse to guess, for both functions
  const duplicateTagged = taggedBoth + '\n// AC-006-1 @hash:aaaaaaaaaaaa @prd-x @REQ-006\n';
  assert.throws(() => addAdoTestCaseTag(duplicateTagged, 'AC-006-1', 1), /found 2 "\/\/ AC-006-1" lines/);
  assert.throws(() => findAdoTestCaseTag(duplicateTagged, 'AC-006-1'), /found 2 "\/\/ AC-006-1" lines/);

  console.log('traceability-tagger.js self-check passed');
}
