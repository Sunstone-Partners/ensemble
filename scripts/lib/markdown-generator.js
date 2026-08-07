/**
 * Markdown Generator Module
 * Routes to appropriate transformer and handles file generation
 */

'use strict';

const { transformCommandToMarkdown } = require('./command-transformer');
const { transformAgentToMarkdown } = require('./agent-transformer');
const { checkFrontmatter } = require('./frontmatter-check');
const { GenerationError } = require('./error-handler');

/**
 * Generate Markdown from parsed and validated YAML
 * @param {object} yamlData - Parsed YAML data
 * @param {'command'|'agent'} type - Type of YAML
 * @param {string} sourceYamlPath - Path to source YAML file
 * @returns {string} Generated Markdown content
 * @throws {GenerationError} If generation fails
 */
function generateMarkdown(yamlData, type, sourceYamlPath) {
  try {
    let markdown;
    if (type === 'command') {
      markdown = transformCommandToMarkdown(yamlData, sourceYamlPath);
    } else if (type === 'agent') {
      markdown = transformAgentToMarkdown(yamlData, sourceYamlPath);
    } else {
      throw new GenerationError(sourceYamlPath, `Unknown YAML type: ${type}`);
    }

    // Both transformers converge here, so this one call covers every generated
    // artifact. Fails closed: nothing unparseable reaches writeFileAtomic.
    checkFrontmatter(markdown, sourceYamlPath);

    return markdown;
  } catch (error) {
    if (error instanceof GenerationError) {
      throw error;
    }
    throw new GenerationError(sourceYamlPath, `Generation failed: ${error.message}`);
  }
}

module.exports = {
  generateMarkdown
};
