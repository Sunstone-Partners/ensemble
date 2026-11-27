'use strict';

/**
 * TRD-033: scoped TRD task extraction for /ensemble:author-playwright-tests'
 * implementation-grounding.js.
 *
 * A slimmed-down sibling of packages/development/lib/trd-parser.js,
 * deliberately scoped to e2e-testing's own lib/ rather than imported
 * cross-package — the exact precedent packages/e2e-testing/lib/prd-ac-parser.js
 * already established for the sibling PRD-parsing problem (see that file's
 * own header comment).
 *
 * Why this exists instead of shelling out to trd-cli.js: implementation-
 * grounding.js used to resolve `../../development/lib/trd-cli.js` via a
 * hardcoded relative path from its own __dirname. That only works in the
 * monorepo checkout, where packages/e2e-testing and packages/development are
 * sibling directories under a shared packages/ root. Once installed as real,
 * independently-published Claude Code plugins, they land in separate,
 * sibling top-level plugin-cache directories — the relative path resolves to
 * a location that never exists, and grounding fails outright, unconditionally,
 * for every REQ, the moment the plugin is actually installed (confirmed live
 * against a real, open PR in the consuming application: ENOENT resolving trd-cli.js). No Claude Code
 * plugin-dependency mechanism guarantees a stable, version-independent
 * filesystem path between two separately-versioned plugin installs, so no
 * hardcoded cross-package path — however it's spelled — can be made to work
 * reliably post-install.
 *
 * groundImplementation() only ever needs one thing out of a fully-parsed
 * TRD: `tasksById`, and only two fields per task (`satisfies`, `targetFiles`)
 * — none of trd-parser.js's PR/Phase/Sprint boundary detection, acceptance
 * criteria, cross-cutting requirements, synthetic validation tasks,
 * dependsOn, actions, or hourEstimate. Porting the full parser would just
 * recreate the exact vendored-copy drift problem this TRD independently
 * found and fixed in packages/full/lib/trd-parser.js days earlier — so this
 * module intentionally extracts only the task-line/satisfies/target-files
 * logic, kept in sync with trd-parser.js's own regexes by inspection, not by
 * any copy/sync mechanism (there is far less surface area here to drift).
 *
 * Pure function: no shell-out, no disk I/O — accepts TRD text as a string,
 * matching prd-ac-parser.js's/resume-scan.js's convention in this package.
 */

/** Normalize CRLF/CR to LF so every downstream regex can assume '\n'. */
function normalizeLineEndings(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// Top-level task line: "- [ ] **TRD-001**: Description" / "- [x] **TRD-001-TEST**: ..."
// Identical shape to trd-parser.js's TASK_LINE_RE.
const TASK_LINE_RE = /^(\s*)- \[[ xX]\]\s+\*\*(TRD-[A-Za-z0-9-]+)\*\*\s*:?\s*(.*)$/;

// Master Task List scope boundary (matches trd-parser.js's findMasterTaskListScope).
const MASTER_TASK_LIST_RE = /^##\s+Master Task List\s*$/i;
const NEXT_H2_RE = /^##\s+/;
const H3_H4_RE = /^###\s|^##\s/;

/** Strip a markdown link wrapper / backticks / surrounding punctuation from a captured file path. */
function cleanFilePath(raw) {
  return raw
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .replace(/[.,;]+$/, '')
    .trim();
}

/**
 * Extract [satisfies ...] annotation values (REQ/INFRA/ARCH tokens) from a
 * task's full text. A single bracket may list several comma-separated REQs
 * (e.g. "[satisfies REQ-005, REQ-012]" — a real, common convention in this
 * repo's own TRDs) — every one must be captured, not just the first.
 */
function extractSatisfies(text) {
  const out = [];
  const bracketRe = /\[satisfies\s+([^\]]+)\]/gi;
  let bracket;
  while ((bracket = bracketRe.exec(text)) !== null) {
    const content = bracket[1];
    const reqMatches = content.match(/REQ-\d+/gi);
    if (reqMatches) {
      reqMatches.forEach((req) => out.push(req.toUpperCase()));
      continue;
    }
    const token = content.trim();
    if (/^(INFRA|ARCH)$/i.test(token)) {
      out.push(token.toUpperCase());
    } else {
      out.push(token);
    }
  }
  return out;
}

/** Extract Target File(s) from a task's body lines: "Target File: `path`" / "Target Files: a, b" / "File: path". */
function extractTargetFiles(bodyLines) {
  const files = [];
  for (const line of bodyLines) {
    const m = line.match(/^\s*-?\s*(?:Target Files?|File)\s*:\s*(.+)$/i);
    if (m) {
      const parts = m[1].split(',');
      for (const p of parts) {
        const cleaned = cleanFilePath(p);
        if (cleaned) files.push(cleaned);
      }
    }
  }
  return files;
}

/** Slice `lines` down to the "## Master Task List" section, if present (else the whole document). */
function findMasterTaskListScope(lines) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (MASTER_TASK_LIST_RE.test(lines[i].trim())) {
      start = i;
      break;
    }
  }
  if (start === -1) return lines;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (NEXT_H2_RE.test(lines[i]) && !/^###/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

/**
 * Parse just enough of a TRD to ground implementation: every top-level
 * `**TRD-NNN**` task's `satisfies` and `targetFiles`.
 *
 * @param {string} markdownString
 * @returns {{tasksById: Object.<string, {id: string, satisfies: string[], targetFiles: string[]}>}}
 */
function parseTrdTasks(markdownString) {
  const md = normalizeLineEndings(typeof markdownString === 'string' ? markdownString : '');
  const allLines = md.split('\n');
  const scopeLines = findMasterTaskListScope(allLines);

  const tasksById = {};

  const taskLineIndices = [];
  for (let i = 0; i < scopeLines.length; i++) {
    if (TASK_LINE_RE.test(scopeLines[i])) taskLineIndices.push(i);
  }

  for (const startIdx of taskLineIndices) {
    const taskLine = scopeLines[startIdx];
    const m = taskLine.match(TASK_LINE_RE);
    const id = m[2];

    let bodyEnd = scopeLines.length;
    for (let j = startIdx + 1; j < scopeLines.length; j++) {
      const line = scopeLines[j];
      if (TASK_LINE_RE.test(line) || H3_H4_RE.test(line)) {
        bodyEnd = j;
        break;
      }
    }
    const bodyLines = scopeLines.slice(startIdx + 1, bodyEnd);
    const fullText = [taskLine, ...bodyLines].join('\n');

    if (Object.prototype.hasOwnProperty.call(tasksById, id)) continue; // keep first occurrence

    tasksById[id] = {
      id,
      satisfies: extractSatisfies(fullText),
      targetFiles: extractTargetFiles(bodyLines),
    };
  }

  return { tasksById };
}

module.exports = { parseTrdTasks, normalizeLineEndings };
