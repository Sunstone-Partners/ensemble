/**
 * @sunstone-partners/ensemble-ai
 *
 * The plugin ships Claude Code skills under skills/<name>/SKILL.md; this module only exposes their paths.
 */

const path = require('path');

const skillsDir = path.join(__dirname, '..', 'skills');
const skills = [
  'using-anthropic-platform',
  'using-openai-platform',
  'using-perplexity-platform',
  'using-weaviate',
  'building-langgraph-agents'
];

module.exports = {
  name: 'ensemble-ai',
  skillsDir,
  skills,
  skillPath: (name) => path.join(skillsDir, name, 'SKILL.md')
};
