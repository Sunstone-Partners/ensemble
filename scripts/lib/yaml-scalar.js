/**
 * YAML Scalar Module
 * Emits frontmatter values as YAML-safe, single-line, double-quoted scalars.
 */

'use strict';

/**
 * Collapse a value to a single line.
 *
 * Frontmatter keys are single-line by convention, but a source YAML may supply
 * a block scalar (`description: |`), which arrives here carrying newlines. Left
 * alone those emit as column-0 continuation lines and break the whole block.
 *
 * @param {*} value - Value to fold
 * @returns {string} Whitespace-collapsed, trimmed string
 */
function foldScalar(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * Emit a value as a quoted YAML scalar.
 *
 * Quoting is unconditional. There is deliberately no "does this need quoting?"
 * predicate — getting that predicate wrong is the defect this module exists to
 * fix, and a wrong answer is silent (the consumer drops the whole document).
 *
 * JSON.stringify does the escaping: a JSON string literal is a valid YAML 1.2
 * double-quoted scalar, so the escaping rules are the standard library's rather
 * than ours.
 *
 * @param {*} value - Value to emit
 * @returns {string} Double-quoted YAML scalar
 */
function yamlScalar(value) {
  return JSON.stringify(foldScalar(value));
}

module.exports = {
  foldScalar,
  yamlScalar
};
