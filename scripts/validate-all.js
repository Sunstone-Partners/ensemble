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
    const entryPath = path.join(fullSkillsDir, entry.name);
    // A checkout without symlink support writes these as plain files holding
    // the target path. Read the target either way, otherwise every package
    // covered by a whole-dir mirror falls through to the per-skill check and
    // reports skills missing that are committed and correct.
    const target = entry.isSymbolicLink()
      ? fs.readlinkSync(entryPath)
      : deSymlinkedMirrorTarget(entryPath);
    if (!target) continue;
    const pkg = wholeDirMirrorTarget(target);
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
/**
 * True when a file's entire content looks like a relative symlink target
 * (`../../core/skills`) rather than real file content.
 *
 * Git for Windows leaves core.symlinks=false unless the installer's symlink
 * option was ticked, and such a checkout materializes every committed symlink
 * as a small regular file holding the target path. packages/full/ is assembled
 * out of 97 of them, so on those machines the bundled full plugin is a tree of
 * path strings where its skills and library code should be.
 *
 * @param {string} text Full file content
 * @returns {boolean}
 */
function looksLikeLinkTarget(text) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 255) return false;
  if (/[\r\n]/.test(trimmed)) return false;
  // Relative, and pointing upward or at a sibling -- how every mirror here is written.
  return /^\.\.?[/\\]/.test(trimmed);
}

/**
 * The link target a packages/full/ mirror entry stands for when git wrote it
 * as a plain file instead of a symlink, or null if the entry is a real symlink,
 * real content, or a stand-in whose target does not resolve.
 *
 * Presence checks cannot see this: lstat reports a perfectly good regular file.
 *
 * @param {string} p Absolute path to the mirror entry
 * @returns {string|null}
 */
function deSymlinkedMirrorTarget(p) {
  try {
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 255) return null;
    const text = fs.readFileSync(p, 'utf8');
    if (!looksLikeLinkTarget(text)) return null;
    const target = text.trim();
    return fs.existsSync(path.resolve(path.dirname(p), target)) ? target : null;
  } catch {
    return null;
  }
}

/**
 * Every packages/full/ mirror entry that this checkout turned into a path
 * string. Walks only the mirror roots, not the whole tree.
 *
 * @returns {string[]} Repo-relative paths, sorted
 */
function findDeSymlinkedMirrors() {
  const fullDir = path.join(PACKAGES_DIR, 'full');
  const found = [];
  const walk = dir => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && deSymlinkedMirrorTarget(child)) {
        found.push(path.relative(path.join(__dirname, '..'), child).split(path.sep).join('/'));
      }
    }
  };
  for (const sub of ['agents', 'commands', 'hooks', 'lib', 'skills']) {
    walk(path.join(fullDir, sub));
  }
  return found.sort();
}

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
  // marketplace.json checked above -- and nothing verified the two agreed, so
  // the loaded copy sat stale from 2026-08-07 until it was caught: five
  // installable packages (ai, router, permitter, dotnet, reqnroll) missing, two
  // deleted ones (pane-viewer, task-progress-pane) still listed, and every
  // version pinned at 5.0.0.
  //
  // This path must be a REGULAR FILE, never a symlink to ../marketplace.json.
  // A symlink is the tempting fix -- one file on disk makes drift structurally
  // impossible rather than merely detected -- but Git for Windows leaves
  // core.symlinks=false unless the installer's symlink option was ticked, and
  // such a checkout materializes the link as a 19-byte text file containing
  // "../marketplace.json". Claude Code reads that instead of JSON and the
  // marketplace fails to load entirely. CI runs on Linux, where the link
  // resolves and the byte comparison below passes, so only the explicit lstat
  // catches it.
  console.log('Validating .claude-plugin/marketplace.json matches marketplace.json...');
  const rootManifest = path.join(__dirname, '..', 'marketplace.json');
  const loadedManifest = path.join(__dirname, '..', '.claude-plugin', 'marketplace.json');
  const FIX_HINT = '  Fix: cp marketplace.json .claude-plugin/marketplace.json';
  if (!fs.existsSync(loadedManifest)) {
    console.error('✗ .claude-plugin/marketplace.json is missing - Claude Code cannot load the marketplace without it');
    console.error(FIX_HINT);
    errors++;
  } else if (fs.lstatSync(loadedManifest).isSymbolicLink()) {
    console.error('✗ .claude-plugin/marketplace.json is a symlink - it must be a regular file');
    console.error('  A Windows checkout without core.symlinks writes the link target as plain');
    console.error('  text, so Claude Code reads "../marketplace.json" instead of JSON and the');
    console.error('  marketplace does not load at all. See the comment above this check.');
    console.error('  Fix: rm .claude-plugin/marketplace.json && cp marketplace.json .claude-plugin/marketplace.json');
    errors++;
  } else {
    // Compare with line endings normalized so a CRLF checkout is not a failure.
    const readNormalized = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    if (readNormalized(rootManifest) !== readNormalized(loadedManifest)) {
      console.error('✗ .claude-plugin/marketplace.json differs from marketplace.json');
      console.error('  Claude Code loads .claude-plugin/marketplace.json; this script and');
      console.error('  validate-version-sync.js check marketplace.json. They must agree.');
      console.error(FIX_HINT);
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

  // packages/full/ is assembled entirely out of symlinks. A checkout without
  // symlink support turns every one into a small file holding the target path,
  // which every presence check above accepts as a healthy mirror. Report it
  // plainly instead: the repo is fine, this checkout is not, so it is a warning
  // rather than an error and CI stays green.
  console.log('');
  console.log('Checking packages/full/ mirrors resolved on this checkout...');
  const deSymlinked = findDeSymlinkedMirrors();
  if (deSymlinked.length > 0) {
    console.warn(`⚠ ${deSymlinked.length} packages/full/ mirror(s) are path text, not the content they stand for`);
    console.warn('  This checkout has core.symlinks disabled, so the ensemble-full bundle');
    console.warn('  ships path strings where its skills and library code should be. Every');
    console.warn('  other check passes because the files do exist -- they are just wrong.');
    console.warn('  Fix: git config --global core.symlinks true, then re-clone.');
    console.warn('  (Requires Developer Mode or an elevated shell to create symlinks.)');
    const sample = deSymlinked.slice(0, 5);
    sample.forEach(f => console.warn(`    ${f}`));
    if (deSymlinked.length > sample.length) {
      console.warn(`    ... and ${deSymlinked.length - sample.length} more`);
    }
  } else {
    console.log('  ✓ packages/full/ mirrors resolve to real content');
  }

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

module.exports = {
  wholeDirMirrorTarget,
  looksLikeLinkTarget,
  deSymlinkedMirrorTarget,
  findDeSymlinkedMirrors,
  validateFullSkillsMirror,
  validateFullLibMirror,
};
