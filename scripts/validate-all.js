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

/**
 * Ensure every packages/development/lib/*.js file has a corresponding
 * entry (symlink or real file) in packages/full/lib/. packages/full is
 * meant to mirror the underlying packages via symlinks; a silently
 * missing entry here means the bundled full plugin is missing code that
 * command YAML in packages/development relies on.
 *
 * @returns {string[]} One message per missing file
 */
function validateFullLibMirror() {
  const failures = [];
  const devLibDir = path.join(PACKAGES_DIR, 'development', 'lib');
  const fullLibDir = path.join(PACKAGES_DIR, 'full', 'lib');

  if (!fs.existsSync(devLibDir) || !fs.existsSync(fullLibDir)) {
    return failures;
  }

  const devFiles = fs.readdirSync(devLibDir).filter(f => f.endsWith('.js'));
  let checked = 0;
  devFiles.forEach(file => {
    const fullPath = path.join(fullLibDir, file);
    // lstatSync so this correctly reports presence of symlinks even if
    // their target is missing (a broken symlink is still "present").
    if (!safeLstatExists(fullPath)) {
      failures.push(
        `packages/full/lib/${file} is missing (present in packages/development/lib/) - add a symlink: ` +
        `ln -sf ../../development/lib/${file} packages/full/lib/${file}`
      );
    } else {
      checked++;
    }
  });

  console.log(`  ✓ ${checked}/${devFiles.length} packages/development/lib/*.js file(s) mirrored in packages/full/lib/`);
  return failures;
}

/**
 * Parse a packages/full/skills/<entry> symlink target into the source package
 * it mirrors wholesale (`../../git/skills` -> `git`), or null for a per-skill
 * link like `../../development/skills/developing-with-flutter`.
 *
 * Separators are normalized because fs.readlinkSync returns the target in the
 * platform's own form: `../../git/skills` on POSIX but `..\..\git\skills` on
 * Windows. Matching a forward-slash-only pattern meant no whole-directory
 * mirror was ever recognized on Windows, so every package covered by one got
 * per-skill checked and `npm run validate` reported four missing symlinks that
 * exist and are correct — a false failure Linux CI could never reproduce.
 *
 * Splitting on path.sep rather than replacing backslashes keeps this a
 * deliberate no-op on POSIX, where a backslash is a legal filename character
 * (same reasoning as toGlobPattern in scripts/lib/file-discovery.js).
 *
 * @param {string} target Raw fs.readlinkSync output
 * @returns {string|null} Source package name, or null
 */
function wholeDirMirrorTarget(target) {
  const match = target.split(path.sep).join('/').match(/^\.\.\/\.\.\/([^/]+)\/skills$/);
  return match ? match[1] : null;
}

/**
 * Ensure every skill under packages/<pkg>/skills/<skill>/ (excluding pi and
 * full themselves) is reachable from packages/full/skills/. packages/full
 * mirrors source packages either per-skill (e.g. `developing-with-flutter ->
 * ../../development/skills/developing-with-flutter`) or via a whole-package
 * symlink (e.g. `git -> ../../git/skills`, which implicitly covers every
 * skill underneath it, like `git/git-town`). A skill reachable through
 * neither shape means packages/full silently lacks something a command
 * relies on via ${CLAUDE_PLUGIN_ROOT}/skills/... path resolution.
 *
 * @returns {string[]} One message per unreachable skill
 */
function validateFullSkillsMirror() {
  const failures = [];
  const fullSkillsDir = path.join(PACKAGES_DIR, 'full', 'skills');

  if (!fs.existsSync(fullSkillsDir)) {
    return failures;
  }

  // Directories that are already symlinked wholesale into packages/full/skills/
  // (e.g. `git -> ../../git/skills`) — any skill under those source packages'
  // skills/ dir is implicitly covered without needing its own entry.
  const wholeDirMirroredPackages = new Set();
  for (const entry of fs.readdirSync(fullSkillsDir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const pkg = wholeDirMirrorTarget(fs.readlinkSync(path.join(fullSkillsDir, entry.name)));
    if (pkg) wholeDirMirroredPackages.add(pkg);
  }

  let checked = 0;
  let total = 0;
  const packageDirs = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== 'pi' && e.name !== 'full');

  for (const pkgEntry of packageDirs) {
    const pkgName = pkgEntry.name;
    const skillsDir = path.join(PACKAGES_DIR, pkgName, 'skills');
    if (!fs.existsSync(skillsDir)) continue;
    if (wholeDirMirroredPackages.has(pkgName)) continue; // whole dir already covers it

    for (const skillEntry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!skillEntry.isDirectory() && !skillEntry.isSymbolicLink()) continue;
      // Only real skills (a SKILL.md of their own) count — excludes asset
      // subdirectories like a top-level-layout skill's examples/ or templates/.
      if (!fs.existsSync(path.join(skillsDir, skillEntry.name, 'SKILL.md'))) continue;
      total++;
      const skillName = skillEntry.name;
      if (safeLstatExists(path.join(fullSkillsDir, skillName))) {
        checked++;
      } else {
        failures.push(
          `packages/full/skills/${skillName} is missing (present in packages/${pkgName}/skills/) - add a symlink: ` +
          `ln -sf ../../${pkgName}/skills/${skillName} packages/full/skills/${skillName}`
        );
      }
    }
  }

  console.log(`  ✓ ${checked}/${total} skill(s) reachable from packages/full/skills/`);
  return failures;
}

/**
 * fs.existsSync follows symlinks and returns false for broken symlinks.
 * Use lstatSync to detect the symlink/file entry itself regardless of
 * whether its target currently resolves.
 *
 * @param {string} p
 * @returns {boolean}
 */
function safeLstatExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
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

  let errors = 0;

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

  // Claude Code loads .claude-plugin/marketplace.json, not the root
  // marketplace.json checked above. .claude-plugin/marketplace.json is now a
  // relative symlink to ../marketplace.json (same convention as the
  // packages/full/lib and packages/full/skills mirrors below), which makes
  // drift structurally impossible instead of merely detected: there is only
  // ever one file on disk. Before this, the loaded copy sat stale from
  // 2026-08-07 until it was caught: five installable packages (ai, router,
  // permitter, dotnet, reqnroll) missing, two deleted ones (pane-viewer,
  // task-progress-pane) still listed, and every version pinned at 5.0.0. This
  // check remains as a defensive sanity check for a broken symlink or a tool
  // that replaces the symlink with a real file (e.g. some editors/zip
  // extractors do this) -- reading through a correct symlink returns
  // byte-identical content, so the comparison below still passes in the
  // common case and only fires if something has gone wrong.
  console.log('Validating .claude-plugin/marketplace.json matches marketplace.json...');
  const rootManifest = path.join(__dirname, '..', 'marketplace.json');
  const loadedManifest = path.join(__dirname, '..', '.claude-plugin', 'marketplace.json');
  if (!fs.existsSync(loadedManifest)) {
    console.error('✗ .claude-plugin/marketplace.json is missing - Claude Code cannot load the marketplace without it');
    console.error('  Fix: ln -sf ../marketplace.json .claude-plugin/marketplace.json');
    errors++;
  } else {
    // Compare with line endings normalized so a CRLF checkout is not a failure.
    const readNormalized = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    if (readNormalized(rootManifest) !== readNormalized(loadedManifest)) {
      console.error('✗ .claude-plugin/marketplace.json differs from marketplace.json');
      console.error('  Claude Code loads .claude-plugin/marketplace.json; this script and');
      console.error('  validate-version-sync.js check marketplace.json. They must agree.');
      console.error('  .claude-plugin/marketplace.json should be a symlink to ../marketplace.json --');
      console.error('  it has been replaced with a real file. Fix: rm .claude-plugin/marketplace.json');
      console.error('  && ln -sf ../marketplace.json .claude-plugin/marketplace.json');
      errors++;
    } else {
      console.log('✓ .claude-plugin/marketplace.json in sync\n');
    }
  }

  // Get all packages
  const packages = fs.readdirSync(PACKAGES_DIR).filter(name => {
    const stat = fs.statSync(path.join(PACKAGES_DIR, name));
    return stat.isDirectory();
  });

  // Validate each package
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

  // packages/full/lib/ must mirror packages/development/lib/ (symlink drift check)
  console.log('\nValidating packages/full/lib/ mirrors packages/development/lib/...');
  const fullLibFailures = validateFullLibMirror();
  fullLibFailures.forEach(message => {
    console.error(`✗ ${message}`);
    errors++;
  });

  // packages/full/skills/ must reach every source package's skills (symlink drift check)
  console.log('\nValidating packages/full/skills/ mirrors source packages...');
  const fullSkillsFailures = validateFullSkillsMirror();
  fullSkillsFailures.forEach(message => {
    console.error(`✗ ${message}`);
    errors++;
  });

  if (errors > 0) {
    console.error(`\n✗ Validation failed with ${errors} error(s)`);
    process.exit(1);
  }

  console.log('\n✓ All plugins validated successfully');
}

// Guarded so scripts/tests can require this module without running validation.
if (require.main === module) {
  main();
}

module.exports = { wholeDirMirrorTarget };
