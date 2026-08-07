/**
 * Frontmatter Check Module
 * Verifies that an emitted or committed Markdown artifact has parseable YAML frontmatter.
 *
 * A frontmatter parse failure is not partial: consumers drop the entire command
 * or agent rather than degrading, and do so silently. This check is what turns
 * that silence into a build failure.
 */

'use strict';

const yaml = require('js-yaml');
const { GenerationError } = require('./error-handler');

// Leading `---` line, body, closing `---` line. Tolerates CRLF.
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Extract the raw frontmatter block from Markdown content.
 * @param {string} content - Full Markdown file content
 * @returns {string|null} Raw frontmatter body, or null if there is no block
 */
function extractFrontmatter(content) {
  const match = FRONTMATTER_PATTERN.exec(content);
  return match ? match[1] : null;
}

/**
 * Assert that content's frontmatter parses as YAML.
 *
 * Content with no frontmatter block passes — absence is not a defect, only
 * an unparseable block is.
 *
 * @param {string} content - Full Markdown file content
 * @param {string} sourcePath - Path reported in the error message
 * @throws {GenerationError} If the frontmatter block is present but unparseable
 */
function checkFrontmatter(content, sourcePath) {
  const frontmatter = extractFrontmatter(content);
  if (frontmatter === null) {
    return;
  }

  try {
    yaml.load(frontmatter);
  } catch (error) {
    const reason = error.reason || error.message;
    throw new GenerationError(
      sourcePath,
      `Unparseable YAML frontmatter: ${reason}. The whole command/agent would be dropped at load.`
    );
  }
}

module.exports = {
  extractFrontmatter,
  checkFrontmatter
};
