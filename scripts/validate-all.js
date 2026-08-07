#!/usr/bin/env node
/**
 * Validate all plugins in the monorepo
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { checkFrontmatter } = require('./lib/frontmatter-check');

const PACKAGES_DIR = path.join(__dirname, '..', 'packages');

/**
 * Walk packages/ for every .md artifact and assert its frontmatter parses.
 *
 * Deliberately repo-wide rather than scoped to what scripts/lib emits: the pi
 * and codex pipelines produce frontmatter too, and scoping the walk would need
 * an exclusion list to leave them unguarded. A file with no frontmatter passes.
 *
 * @returns {string[]} One message per unparseable artifact
 */
function validateFrontmatter() {
  const failures = [];
  let checked = 0;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (entry.name.endsWith('.md')) {
        const relative = path.relative(path.join(__dirname, '..'), full);
        try {
          checkFrontmatter(fs.readFileSync(full, 'utf8'), relative);
          checked++;
        } catch (error) {
          failures.push(error.message);
        }
      }
    }
  };

  walk(PACKAGES_DIR);
  console.log(`  ✓ ${checked} Markdown artifact(s) have parseable frontmatter`);
  return failures;
}

function validatePlugin(pluginDir) {
  const pluginName = path.basename(pluginDir);
  console.log(`\nValidating plugin: ${pluginName}`);

  // Check plugin.json exists
  const pluginJsonPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(pluginJsonPath)) {
    throw new Error(`Missing plugin.json for ${pluginName}`);
  }

  // Validate plugin.json against schema
  try {
    execSync(
      `npx ajv validate -c ajv-formats -s schemas/plugin-schema.json -d "${pluginJsonPath}"`,
      { cwd: path.join(__dirname, '..'), stdio: 'inherit' }
    );
  } catch (error) {
    throw new Error(`Invalid plugin.json for ${pluginName}`);
  }

  // Check package.json exists
  const packageJsonPath = path.join(pluginDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Missing package.json for ${pluginName}`);
  }

  // Validate package.json structure
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (!packageJson.name.startsWith('@sunstone-partners/ensemble-')) {
    throw new Error(`Invalid package name for ${pluginName}: ${packageJson.name}`);
  }

  // Validate YAML files if agents directory exists
  const agentsDir = path.join(pluginDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    const yamlFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.yaml'));
    yamlFiles.forEach(yamlFile => {
      const yamlPath = path.join(agentsDir, yamlFile);
      try {
        execSync(`npx js-yaml "${yamlPath}"`, {
          cwd: path.join(__dirname, '..'),
          stdio: 'pipe'
        });
        console.log(`  ✓ Valid YAML: ${yamlFile}`);
      } catch (error) {
        throw new Error(`Invalid YAML: ${yamlPath}`);
      }
    });
  }

  console.log(`✓ ${pluginName} validated successfully`);
}

function main() {
  console.log('Ensemble Plugin Validation');
  console.log('========================\n');

  // Validate marketplace.json
  console.log('Validating marketplace.json...');
  try {
    execSync('npx ajv validate -c ajv-formats -s schemas/marketplace-schema.json -d marketplace.json', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });
    console.log('✓ marketplace.json valid\n');
  } catch (error) {
    console.error('✗ marketplace.json invalid');
    process.exit(1);
  }

  // Get all packages
  const packages = fs.readdirSync(PACKAGES_DIR).filter(name => {
    const stat = fs.statSync(path.join(PACKAGES_DIR, name));
    return stat.isDirectory();
  });

  // Validate each package
  let errors = 0;
  packages.forEach(pkg => {
    try {
      validatePlugin(path.join(PACKAGES_DIR, pkg));
    } catch (error) {
      console.error(`✗ ${error.message}`);
      errors++;
    }
  });

  // Frontmatter parseability across every generated artifact
  console.log('\nValidating Markdown frontmatter...');
  const frontmatterFailures = validateFrontmatter();
  frontmatterFailures.forEach(message => {
    console.error(`✗ ${message}`);
    errors++;
  });

  if (errors > 0) {
    console.error(`\n✗ Validation failed with ${errors} error(s)`);
    process.exit(1);
  }

  console.log('\n✓ All plugins validated successfully');
}

main();
