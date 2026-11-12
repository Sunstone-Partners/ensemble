'use strict';

/**
 * PR description checker (TRD-004, REQ-002).
 *
 * Pure: NO shell, NO network, NO file reads. The caller supplies the PR body
 * text; this module only grades it.
 *
 * Every PR must record how it was tested, how risky it is and how to undo it,
 * and an agent-authored PR must name the person accountable for those answers.
 * This module is the one place that decides whether a body does that, so
 * `pr-review-cycle`, `pr-merge` and the PR-building commands cannot each keep
 * a private idea of "has a Testing section".
 *
 * Three rules it exists to make non-negotiable:
 *
 *   1. **A heading is not content.** A section whose body is blank, an HTML
 *      comment, a bare list marker or nothing but the next heading counts as
 *      MISSING. A template committed unfilled is not a description.
 *
 *   2. **PR text is data (REQ-024).** Fenced code blocks are skipped, so a
 *      quoted diff or a pasted log that happens to contain `## How to revert`
 *      or `Directed by: @someone` never satisfies a requirement.
 *
 *   3. **Accountability is never guessed.** `directedBy` is returned only when
 *      a `Directed by:` line names exactly one value shaped like a GitHub
 *      login. "the product team" is reported as unreadable, not parsed into a
 *      login, and an agent-authored PR without a readable one is not ready.
 *      Only an explicit `agentAuthored: false` says a person wrote the PR; a
 *      claim nobody made (the key absent) is read as agent-authored.
 *
 * `ready` is true only when `missing` is empty -- there is no second way for a
 * caller to conclude a description is acceptable.
 */

/** The section ids reported in `missing[]`, in report order. */
const REQUIRED_SECTIONS = Object.freeze(['testing', 'risk', 'how-to-revert']);

/**
 * Accepted headings per section, normalized (lowercased, non-alphanumerics
 * removed). Spelling variants of the SAME section only: a bare `revert` or
 * `rollback` is deliberately not accepted, because a one-word heading is as
 * likely to be prose as a section, and accepting it would let a PR pass
 * without ever saying how to undo the change.
 */
const SECTION_LABELS = Object.freeze({
  testing: Object.freeze(['testing', 'tests', 'testplan', 'howtested']),
  risk: Object.freeze(['risk', 'risks', 'risklevel', 'riskassessment']),
  'how-to-revert': Object.freeze(['howtorevert', 'howtorollback', 'revertplan', 'rollbackplan', 'howtoundo']),
});

/** A GitHub login: alphanumerics and single inner hyphens, at most 39 characters. */
const LOGIN = /^@?([A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38})$/;

/** `Directed by:` / `Directed-by -` at the start of a line, with the rest of the line captured. */
const DIRECTED_BY = /^directed[\s-]*by\s*[:\-]?\s*(.*)$/i;

/** ```/~~~ fence open or close. */
const FENCE = /^\s{0,3}(?:`{3,}|~{3,})/;

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Lowercase, alphanumerics only: `How-to-revert:` and `HOW TO REVERT` both become `howtorevert`. */
const normalizeLabel = (text) => String(text).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Which required section this label names, or null. */
function sectionFor(label) {
  const normalized = normalizeLabel(label);
  if (normalized === '') return null;
  for (const id of REQUIRED_SECTIONS) {
    if (SECTION_LABELS[id].includes(normalized)) return id;
  }
  return null;
}

/** Leading/trailing markdown emphasis, quote markers and list bullets. */
const stripDecoration = (text) => text.replace(/^[\s>*_~#-]+/, '').replace(/[\s*_~]+$/, '');

/**
 * Reads one line as a possible section heading.
 *
 * Three shapes are recognized, each with the content that may follow the label
 * on the SAME line (`Risk: low`):
 *   - an ATX heading (`## Testing`, `### tESTING:`),
 *   - a bold label (`**How to revert:**`),
 *   - a plain label line (`Risk: low`).
 *
 * @returns {{id:string, inline:string}|null} null unless the label names a
 *   required section -- an unrecognized label is ordinary content, never a
 *   section boundary, so prose like `Ran: all good` cannot truncate the
 *   section it sits in.
 */
function readHeading(line) {
  const candidates = [];

  const atx = /^\s{0,3}#{1,6}\s*(.*)$/.exec(line);
  if (atx) candidates.push(atx[1]);

  const bold = /^\s*\*\*([^*]+)\*\*\s*:?\s*(.*)$/.exec(line);
  if (bold) candidates.push(`${bold[1]}: ${bold[2]}`);

  if (candidates.length === 0) candidates.push(line.trim());

  for (const candidate of candidates) {
    const colon = candidate.indexOf(':');
    const label = colon === -1 ? candidate : candidate.slice(0, colon);
    const inline = colon === -1 ? '' : candidate.slice(colon + 1);
    const id = sectionFor(label);
    if (id !== null) return { id, inline };
  }
  return null;
}

/**
 * Does `lines` hold anything a reader would call an answer?
 *
 * HTML comments (the template's own prompts), markdown bullets, checkbox
 * markers, horizontal rules and punctuation are stripped first, so an unfilled
 * template section is empty.
 */
function hasContent(lines) {
  const text = lines
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^\s*[-*+]\s*(?:\[[ xX]\])?/gm, ' ')
    .replace(/[\s_*~`>|.,;:!?()[\]{}/\\#=+-]/g, '');
  return text !== '';
}

/** The fail-closed answer: a body this module cannot read is never ready and nothing is assumed present. */
function blocked(reason) {
  return {
    ok: false,
    reason,
    missing: [...REQUIRED_SECTIONS, 'directed-by'],
    present: [],
    empty: [],
    directedBy: null,
    agentAuthored: true,
    ready: false,
    warnings: [reason],
  };
}

/**
 * Checks a PR description for the Testing, Risk and How-to-revert sections and
 * for the accountable human.
 *
 * @param {string|{body:string, agentAuthored?:boolean}} input The PR body, or the
 *   CLI payload carrying it.
 * @param {{agentAuthored?:boolean}} [options] Used with the string form. Only an
 *   explicit `false` says a person wrote the PR: an absent, null or non-boolean
 *   `agentAuthored` is read as TRUE, because a claim about who wrote the PR that
 *   nobody made, or that cannot be read, never relaxes the accountability check.
 * @returns {{ok:boolean, missing:string[], present:string[], empty:string[], directedBy:string|null,
 *   agentAuthored:boolean, ready:boolean, warnings:string[], reason?:string}}
 *   `missing` names each absent section (and `directed-by` when it is required
 *   and unreadable); `empty` names the sections that had a heading but no
 *   content; `ready` is true only when `missing` is empty.
 */
function checkDescription(input, options) {
  const payloadForm = isObject(input) && hasOwn(input, 'body');
  const body = payloadForm ? input.body : input;
  if (typeof body !== 'string') return blocked('invalid-body');

  const rawAgentAuthored = payloadForm
    ? input.agentAuthored
    : (isObject(options) ? options.agentAuthored : undefined);
  // Only an explicit `false` is human-authored; absent, null and anything unreadable fail closed.
  const agentAuthored = rawAgentAuthored !== false;

  const warnings = [];

  // --- Read the body outside fenced code blocks (REQ-024) -----------------
  // An HTML comment renders as nothing on the PR page, so a heading, answer or
  // `Directed by:` line inside one is never seen by a reader and must not count
  // (an unterminated `<!--` hides the rest of the body, as GitHub renders it).
  const visible = body.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
  const lines = visible.split(/\r?\n/);
  const headings = [];
  const directedCandidates = [];
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = readHeading(line);
    if (heading) {
      headings.push({ ...heading, index });
      continue;
    }

    const directed = DIRECTED_BY.exec(stripDecoration(line));
    if (directed) directedCandidates.push(directed[1]);
  }

  // --- Sections -----------------------------------------------------------
  const present = [];
  const empty = [];
  const seen = new Set();

  for (let position = 0; position < headings.length; position += 1) {
    const heading = headings[position];
    if (seen.has(heading.id)) continue;

    const next = headings[position + 1];
    const until = next === undefined ? lines.length : next.index;
    const content = [heading.inline, ...lines.slice(heading.index + 1, until)];
    // A section inside a fence was never recorded as a heading, so content
    // lines here can only be real body text.
    if (hasContent(content)) {
      present.push(heading.id);
      seen.add(heading.id);
    } else if (!empty.includes(heading.id)) {
      empty.push(heading.id);
    }
  }

  const missing = REQUIRED_SECTIONS.filter((id) => !present.includes(id));

  // --- Accountable human --------------------------------------------------
  let directedBy = null;
  for (const candidate of directedCandidates) {
    const match = LOGIN.exec(stripDecoration(candidate));
    if (match) {
      directedBy = match[1];
      break;
    }
  }
  if (directedBy === null && directedCandidates.length > 0) warnings.push('directed-by-unreadable');
  if (directedBy === null && agentAuthored) missing.push('directed-by');

  return {
    ok: true,
    missing,
    present: REQUIRED_SECTIONS.filter((id) => present.includes(id)),
    empty: empty.filter((id) => !present.includes(id)),
    directedBy,
    agentAuthored,
    ready: missing.length === 0,
    warnings,
  };
}

module.exports = { checkDescription, REQUIRED_SECTIONS, SECTION_LABELS };
