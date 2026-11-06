'use strict';

/**
 * Agent briefs for the pr-review-cycle skill (plan section 3G: "generate each agent's
 * brief from a template -- a claim plus file paths and nothing the orchestrator
 * concluded").
 *
 * Why this exists: on #234 the first three verifiers of one candidate were handed a
 * hand-written brief that carried the orchestrator's own reading, voted 3/3 real, and
 * were wrong; three fresh verifiers that recomputed the spans voted 0/3. A brief that
 * is pasted by an LLM can say anything. A brief rendered from a closed set of inputs
 * can only say what those inputs are.
 *
 * The policy prose of each brief stays maintainer-editable plain markdown in
 * `packages/development/skills/pr-review-cycle/templates/<role>-brief.md`; this module
 * owns only the part a maintainer must not be able to widen by accident or an
 * orchestrator on purpose: which inputs exist, of what shape, and that the template and
 * the inputs agree.
 *
 * The module is PURE: no file reads, no shell, no network. The template text is a
 * parameter; `pr-review-brief-files.js` is the module that finds and reads the files.
 *
 * Guarantees, each of them refusing (throwing) rather than degrading:
 *   - an unknown role is refused;
 *   - an input the role does not declare is refused, by name. That is the guard that
 *     keeps another verifier's vote, a verdict, the reviewer that raised a finding or
 *     the orchestrator's conclusion out of a verifier brief: there is no field they
 *     can arrive in;
 *   - a declared input that is absent, or of the wrong shape, is refused;
 *   - a template whose placeholders are not exactly the role's declared inputs is
 *     refused (an undeclared placeholder would render as nothing, and a declared one
 *     the template forgot would silently drop an input, for a verifier the claim it
 *     was asked to settle);
 *   - a value that contains placeholder syntax is refused, and substitution is a
 *     single pass, so an input is never itself read as a template;
 *   - the verifier's free-text `claim` is refused when it reads as a vote, a verdict
 *     or the orchestrator's conclusion. That screen is a backstop for the obvious
 *     leak, not a proof: no program can prove a sentence carries no opinion. The
 *     structural guarantee above is the one that holds.
 *
 * TRD/plan reference: docs/plans/pr-review-speedup-plan.md section 3G.
 */

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** `{{name}}`; a name is a camelCase identifier. */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const PLACEHOLDER_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

// Control characters other than the newline and tab a prose input may carry.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;
// eslint-disable-next-line no-control-regex
const CONTROL_OR_NEWLINE = /[\u0000-\u001F\u007F]/;

const MAX_LINE = 1024;
const MAX_PROSE = 4000;
const MAX_MINUTES = 24 * 60;

/**
 * What a verifier's claim must not read as. Each pattern names a way an orchestrator or
 * a sibling verifier's reading leaks into the text a fresh verifier is meant to judge
 * for itself.
 */
const VERIFIER_LEAKS = Object.freeze([
  [/\bverdicts?\b/i, 'a verdict'],
  [/\bvot(?:e|es|ed|ing)\b/i, 'a vote'],
  [/\bnot-real\b/i, 'a verdict'],
  [/\babstain(?:s|ed)?\b/i, 'a verdict'],
  [/\borchestrat(?:or|ors|ed|ion)\b/i, 'the orchestrator'],
  [/\bconclu(?:de|des|ded|sion|sions)\b/i, 'a conclusion'],
  [/\b(?:other|another|previous|earlier|prior|first|second|third) verifiers?\b/i, 'another verifier'],
  [/\bverifiers? (?:said|found|confirmed|agreed|disagreed|judged)\b/i, 'another verifier'],
  [/\b(?:confirmed|judged|ruled|deemed|found|established|verified) (?:to be |as )?real\b/i, 'a conclusion'],
  [/\b(?:is|are) (?:a |an )?(?:real|confirmed) (?:bug|issue|finding|defect|problem)\b/i, 'a conclusion'],
]);

// ---------------------------------------------------------------------------
// Input kinds
// ---------------------------------------------------------------------------

/** A single line of text: a path, an id, a range, a directory. */
function checkLine(value, name) {
  if (typeof value !== 'string' || value.trim() === '') return `'${name}' must be a non-empty string`;
  if (CONTROL_OR_NEWLINE.test(value)) return `'${name}' must be a single line without control characters`;
  if (value.length > MAX_LINE) return `'${name}' is longer than ${MAX_LINE} characters`;
  return null;
}

const LINE = Object.freeze({
  check: checkLine,
  render: (value) => value,
});

/** `path:line` or `path:start-end`. */
const LOCATION = Object.freeze({
  check(value, name) {
    const problem = checkLine(value, name);
    if (problem) return problem;
    if (!/^\S+:\d+(?:-\d+)?$/.test(value)) return `'${name}' must be 'file:line' or 'file:start-end'`;
    return null;
  },
  render: (value) => value,
});

/** A non-empty list of single lines, rendered as a markdown list. */
function listKind({ allowEmpty }) {
  return Object.freeze({
    check(value, name) {
      if (!Array.isArray(value)) return `'${name}' must be an array of strings`;
      if (value.length === 0 && !allowEmpty) return `'${name}' must not be empty`;
      for (let i = 0; i < value.length; i += 1) {
        const problem = checkLine(value[i], `${name}[${i}]`);
        if (problem) return problem;
      }
      return null;
    },
    render: (value) => (value.length === 0 ? '- (none)' : value.map((entry) => `- ${entry}`).join('\n')),
  });
}

/** A positive whole number of minutes. */
const MINUTES = Object.freeze({
  check(value, name) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_MINUTES) {
      return `'${name}' must be a whole number of minutes between 1 and ${MAX_MINUTES}`;
    }
    return null;
  },
  render: (value) => String(value),
});

/** Free text the author of the claim wrote: multi-line allowed, bounded, and screened. */
function proseKind(leaks) {
  return Object.freeze({
    check(value, name) {
      if (typeof value !== 'string' || value.trim() === '') return `'${name}' must be a non-empty string`;
      if (CONTROL.test(value)) return `'${name}' must not contain control characters`;
      if (value.length > MAX_PROSE) return `'${name}' is longer than ${MAX_PROSE} characters`;
      for (const [pattern, what] of leaks) {
        const hit = pattern.exec(value);
        if (hit) return `'${name}' reads as ${what} ("${hit[0]}"); a brief carries the claim and nothing anyone concluded about it`;
      }
      return null;
    },
    render: (value) => value,
  });
}

const PATHS = listKind({ allowEmpty: false });
const MAYBE_PATHS = listKind({ allowEmpty: true });

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * Every brief role: the template file that holds its policy text, and the COMPLETE set
 * of inputs it accepts. This table is the allowlist; nothing outside it can reach a
 * rendered brief. Add an input here and in the template together, or rendering refuses.
 */
const ROLES = Object.freeze({
  reviewer: Object.freeze({
    template: 'reviewer-brief.md',
    inputs: Object.freeze({
      slice: LINE,
      timeboxMinutes: MINUTES,
      paths: PATHS,
      diffPath: LINE,
      snapshotDir: LINE,
    }),
  }),
  verifier: Object.freeze({
    template: 'verifier-brief.md',
    inputs: Object.freeze({
      claim: proseKind(VERIFIER_LEAKS),
      location: LOCATION,
      paths: PATHS,
      snapshotDir: LINE,
    }),
  }),
  classifier: Object.freeze({
    template: 'classifier-brief.md',
    inputs: Object.freeze({
      range: LINE,
      diffPath: LINE,
    }),
  }),
  'second-assessor': Object.freeze({
    template: 'second-assessor-brief.md',
    inputs: Object.freeze({
      range: LINE,
      diffPath: LINE,
      ruleFiles: MAYBE_PATHS,
      sensitivePaths: MAYBE_PATHS,
    }),
  }),
  'security-lane': Object.freeze({
    template: 'security-lane-brief.md',
    inputs: Object.freeze({
      range: LINE,
      diffPath: LINE,
      snapshotDir: LINE,
      sensitivePaths: MAYBE_PATHS,
    }),
  }),
});

const roleNames = () => Object.keys(ROLES).join(', ');

function roleSpec(role) {
  if (typeof role !== 'string' || !hasOwn(ROLES, role)) {
    throw new Error(`unknown brief role ${JSON.stringify(role)} (expected one of ${roleNames()})`);
  }
  return ROLES[role];
}

/**
 * The placeholder names a template uses, in first-seen order. Throws on anything that
 * looks like placeholder syntax but is not a well-formed `{{name}}`: a typo in a
 * template must not render as literal braces.
 */
function placeholdersOf(templateText) {
  const names = [];
  if (/\{\{\{|\}\}\}/.test(templateText)) throw new Error('template has a malformed placeholder: three braces in a row');
  for (const match of templateText.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (!PLACEHOLDER_NAME.test(name)) throw new Error(`template has a malformed placeholder ${JSON.stringify(match[0])}`);
    if (!names.includes(name)) names.push(name);
  }
  if (/\{\{|\}\}/.test(templateText.replace(PLACEHOLDER, ''))) {
    throw new Error('template has an unbalanced "{{" or "}}"');
  }
  return names;
}

/** Throws unless the template's placeholders are exactly the role's declared inputs. */
function checkTemplate(role, templateText) {
  const spec = roleSpec(role);
  if (typeof templateText !== 'string' || templateText === '') {
    throw new Error(`the ${role} brief template is missing or empty`);
  }
  const declared = Object.keys(spec.inputs);
  const used = placeholdersOf(templateText);
  const undeclared = used.filter((name) => !declared.includes(name));
  if (undeclared.length > 0) {
    throw new Error(`the ${role} brief template uses placeholder(s) no input provides: ${undeclared.join(', ')}`);
  }
  const unused = declared.filter((name) => !used.includes(name));
  if (unused.length > 0) {
    throw new Error(`the ${role} brief template never shows declared input(s): ${unused.join(', ')}`);
  }
}

/**
 * Render one brief.
 *
 * @param {string} role          one of `ROLES`
 * @param {object} vars          exactly the inputs the role declares
 * @param {string} templateText  the text of the role's template file
 * @returns {string}
 * @throws when the role, the template or any input is unacceptable (see the file comment)
 */
function renderBrief(role, vars, templateText) {
  const spec = roleSpec(role);
  if (!isObject(vars)) throw new Error(`the ${role} brief needs its inputs as an object`);
  checkTemplate(role, templateText);

  const declared = Object.keys(spec.inputs);
  const unknown = Object.keys(vars).filter((name) => !declared.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `the ${role} brief does not accept ${unknown.map((name) => `'${name}'`).join(', ')} (accepted: ${declared.join(', ')})`
    );
  }
  for (const name of declared) {
    if (!hasOwn(vars, name)) throw new Error(`the ${role} brief requires input '${name}'`);
  }

  const rendered = {};
  for (const name of declared) {
    const kind = spec.inputs[name];
    const problem = kind.check(vars[name], name);
    if (problem) throw new Error(`the ${role} brief refuses its input: ${problem}`);
    const text = kind.render(vars[name]);
    if (/\{\{|\}\}/.test(text)) throw new Error(`the ${role} brief refuses input '${name}': it contains "{{" or "}}"`);
    rendered[name] = text;
  }

  // One pass over the template: a substituted value is never scanned again.
  return templateText.replace(PLACEHOLDER, (_match, name) => rendered[name]);
}

module.exports = {
  ROLES,
  renderBrief,
  checkTemplate,
  placeholdersOf,
};
