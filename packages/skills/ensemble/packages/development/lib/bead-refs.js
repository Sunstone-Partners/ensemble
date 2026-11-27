'use strict';

/**
 * Pure helpers for the `## References` block carried by every scaffolded bead.
 *
 * The block links a bead back to the TRD, the TRD task, the PRD and the PRD
 * requirement(s)/ACs it implements, so an executor can (and MUST) read them
 * before touching the bead. NO fs / shell here — see `bead-context` in trd-cli.js
 * for the live re-read.
 *
 * Block shape (one `Key: value` per line, terminated by a blank line or heading):
 *
 *   ## References
 *   TRD: docs/TRD/foo.md
 *   TRD Task: docs/TRD/foo.md#trd-001
 *   PRD: docs/PRD/foo.md
 *   PRD Requirement: docs/PRD/foo.md#req-001
 *   PRD ACs: AC-001-1, AC-001-2
 *   Verifies Task: docs/TRD/foo.md#trd-001
 *   Parent Epic: [trd:foo]
 *   Read-first: ...
 */

const UNRESOLVED_SUFFIX = ' (UNRESOLVED)';
const READ_FIRST_TEXT =
  'read the TRD, TRD Task section, PRD and PRD Requirement above before any work on this bead.';

const BLOCK_KEYS = [
  'TRD',
  'TRD Task',
  'PRD',
  'PRD Requirement',
  'PRD ACs',
  'Verifies Task',
  'Parent Epic',
  'Read-first',
];

/** Normalise to a repo-style forward-slash path. */
function toPosix(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/');
}

/**
 * Build the `## References` block text (no trailing newline).
 *
 * @param {Object} a
 * @param {string} a.trdPath            repo-relative TRD path
 * @param {string} [a.trdTaskId]        TRD task id (any case); omit for epic/story
 * @param {string} [a.prdPath]          repo-relative PRD path, or the raw reference when unresolved
 * @param {boolean} [a.prdUnresolved]   PRD named by the TRD but not found on disk
 * @param {string[]} [a.reqIds]         satisfied PRD requirement ids (INFRA/ARCH already excluded)
 * @param {string[]} [a.acIds]
 * @param {string} [a.verifiesTaskId]   test beads only
 * @param {string} [a.parentEpicPrefix] e.g. "[trd:foo]"; omit for the epic
 * @returns {string}
 */
function buildReferencesBlock(a) {
  const o = a || {};
  const trd = toPosix(o.trdPath);
  const lines = ['## References', `TRD: ${trd}`];
  if (o.trdTaskId) lines.push(`TRD Task: ${trd}#${String(o.trdTaskId).toLowerCase()}`);
  const prd = toPosix(o.prdPath);
  if (prd) {
    lines.push(`PRD: ${prd}${o.prdUnresolved ? UNRESOLVED_SUFFIX : ''}`);
    if (!o.prdUnresolved) {
      for (const r of o.reqIds || []) {
        if (r) lines.push(`PRD Requirement: ${prd}#${String(r).toLowerCase()}`);
      }
    }
  }
  const acs = (o.acIds || []).filter(Boolean);
  if (acs.length) lines.push(`PRD ACs: ${acs.join(', ')}`);
  if (o.verifiesTaskId) lines.push(`Verifies Task: ${trd}#${String(o.verifiesTaskId).toLowerCase()}`);
  if (o.parentEpicPrefix) lines.push(`Parent Epic: ${o.parentEpicPrefix}`);
  lines.push(`Read-first: ${READ_FIRST_TEXT}`);
  return lines.join('\n');
}

/** Split "path#anchor" at the LAST '#'. */
function splitAnchor(ref) {
  const s = String(ref || '');
  const i = s.lastIndexOf('#');
  return i < 0 ? { path: s, id: '' } : { path: s.slice(0, i), id: s.slice(i + 1) };
}

/**
 * Parse the `## References` block out of a bead description.
 * Returns null when there is no block. Otherwise:
 *   { trd, trdTask:{path,id}|null, prd, prdUnresolved, prdRequirements:[{path,id}],
 *     prdAcs:[], verifiesTask:{path,id}|null, parentEpic }
 * Ids are returned as written (lower-case anchors); callers normalise.
 *
 * @param {string} description
 */
function parseReferencesBlock(description) {
  const lines = String(description == null ? '' : description).replace(/\r\n?/g, '\n').split('\n');
  let i = lines.findIndex((l) => /^##\s+References\s*$/.test(l));
  if (i < 0) return null;
  const refs = {
    trd: '',
    trdTask: null,
    prd: '',
    prdUnresolved: false,
    prdRequirements: [],
    prdAcs: [],
    verifiesTask: null,
    parentEpic: '',
  };
  for (i += 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^#{1,6}\s/.test(line)) break;
    const m = line.match(/^([A-Za-z][A-Za-z -]*?):\s*(.*)$/);
    if (!m || !BLOCK_KEYS.includes(m[1])) break;
    const value = m[2].trim();
    switch (m[1]) {
      case 'TRD': refs.trd = value; break;
      case 'TRD Task': {
        refs.trdTask = splitAnchor(value);
        break;
      }
      case 'PRD':
        if (value.endsWith(UNRESOLVED_SUFFIX)) {
          refs.prdUnresolved = true;
          refs.prd = value.slice(0, -UNRESOLVED_SUFFIX.length).trim();
        } else {
          refs.prd = value;
        }
        break;
      case 'PRD Requirement': refs.prdRequirements.push(splitAnchor(value)); break;
      case 'PRD ACs':
        refs.prdAcs = value.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case 'Verifies Task': {
        refs.verifiesTask = splitAnchor(value);
        break;
      }
      case 'Parent Epic': refs.parentEpic = value; break;
      default: break;
    }
  }
  return refs;
}

const TITLE_RE = /^\s*\[trd:([^:\]]+)(?::(?:(pr|phase):(\d+)|task:([^\]]+)))?\]/;

/**
 * Parse a bead title prefix.
 *   [trd:<slug>]                -> { kind:'epic', slug }
 *   [trd:<slug>:pr|phase:<N>]   -> { kind:'story', slug, phaseN }
 *   [trd:<slug>:task:<ID>]      -> { kind:'task'|'test'|'synth', slug, taskId }
 * `test` = id ends in -TEST; `synth` = id ends in -TEST-S<k>. Returns null if the
 * title carries no recognised prefix.
 *
 * @param {string} title
 */
function parseTitlePrefix(title) {
  const m = TITLE_RE.exec(String(title || ''));
  if (!m) return null;
  const slug = m[1];
  if (m[2]) return { kind: 'story', slug, phaseN: Number(m[3]) };
  if (m[4]) {
    const taskId = m[4];
    let kind = 'task';
    if (/-TEST-S\d+$/i.test(taskId)) kind = 'synth';
    else if (/-TEST$/i.test(taskId)) kind = 'test';
    return { kind, slug, taskId };
  }
  return { kind: 'epic', slug };
}

/** Bead kind from its title, or null when unrecognised. */
function kindFromTitle(title) {
  const p = parseTitlePrefix(title);
  return p ? p.kind : null;
}

/**
 * Best-effort kind from a parsed References block (used when the title has no prefix).
 * @param {ReturnType<typeof parseReferencesBlock>} refs
 */
function kindFromRefs(refs) {
  if (!refs) return null;
  if (refs.verifiesTask) return 'test';
  if (refs.trdTask) return 'task';
  return refs.parentEpic ? 'story' : 'epic';
}

module.exports = {
  buildReferencesBlock,
  parseReferencesBlock,
  parseTitlePrefix,
  kindFromTitle,
  kindFromRefs,
  splitAnchor,
  UNRESOLVED_SUFFIX,
};
