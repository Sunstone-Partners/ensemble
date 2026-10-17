/**
 * Blazor Framework Plugin
 * @sunstone-partners/ensemble-blazor
 *
 * Blazor framework skills for web development
 */

const path = require('path');

const skill = {
  name: 'Blazor Framework',
  version: '1.0.0',
  description: 'Blazor WebAssembly and Server components with .NET backend integration',
  language: 'csharp',
  framework: 'blazor',

  capabilities: [
    'blazor-webassembly',
    'blazor-server',
    'razor-components',
    'dependency-injection',
    'state-management',
    'javascript-interop',
    'authentication',
    'dotnet-backend'
  ],

  detection: {
    patterns: [
      { file: '*.csproj', contains: 'Microsoft.AspNetCore.Components' },
      { file: '*.csproj', contains: 'Blazor' },
      { glob: '**/*.razor' },
      { glob: '**/wwwroot/index.html', contains: 'blazor' }
    ],
    confidence: 0.8
  },

  skills: ['blazor']
};

/**
 * Load skill documentation
 * @param {string} type - 'quick' for SKILL.md, 'comprehensive' for REFERENCE.md
 * @returns {string} Path to documentation file
 */
function loadSkill(type = 'quick') {
  const skillsDir = path.join(__dirname, '..', 'skills');

  return type === 'comprehensive'
    ? path.join(skillsDir, 'REFERENCE.md')
    : path.join(skillsDir, 'SKILL.md');
}

/**
 * Get template path
 * @param {string} templateName - Name of the template
 * @returns {string} Path to template file
 */
function getTemplate(templateName) {
  return path.join(__dirname, '..', 'skills', 'templates', templateName);
}

/**
 * Get example path
 * @param {string} exampleName - Name of the example
 * @returns {string} Path to example file
 */
function getExample(exampleName) {
  return path.join(__dirname, '..', 'skills', 'examples', exampleName);
}

/**
 * Check if .NET SDK is available
 * @returns {Promise<boolean>}
 */
async function isDotNetAvailable() {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec('dotnet --version', (error) => {
      resolve(!error);
    });
  });
}

module.exports = {
  skill,
  loadSkill,
  getTemplate,
  getExample,
  isDotNetAvailable
};
