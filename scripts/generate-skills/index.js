#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { createRequire } = require('module');
const { MIRROR_PACKAGES } = require('../lib/mirror-packages');
const { isSkillBacked, isValidSkillName, resolveSkillFile } = require('../lib/skill-backed-command');
const { renderSkillBody } = require('../migrate-command-to-skill');
const { transformAgentToMarkdown } = require('../lib/agent-transformer');
const { VENDORED, fileList } = require('../vendor-bundle-deps');
const { hash, filesBelow, safePath, writeFiles } = require('../lib/skill-bundle');

const ROOT = path.resolve(__dirname, '../..');
const EXCLUDED = new Set([...MIRROR_PACKAGES, 'codex', 'opencode', 'skills', 'lifecycle-claude', 'pi-extension', 'permitter']);
const marker = '<!-- DO NOT EDIT - Generated from authoritative package sources by npm run generate:skills -->\n';

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return match ? { data: yaml.load(match[1]) || {}, body: text.slice(match[0].length) } : { data: {}, body: text };
}

function skillText(name, description, body) {
  if (!isValidSkillName(name)) throw new Error(`Invalid skill identity: ${name}`);
  return `---\n${yaml.dump({ name, description: String(description || name).trim() }, { lineWidth: -1 })}---\n\n${marker}\n${body.trim()}\n`;
}

const CONTRACT = `${marker}
# Ensemble execution contract

Read this before executing any Ensemble skill. This bundle needs no model-provider API.

- Resolve ENSEMBLE_ROOT to the absolute directory containing this file. In shell examples,
  set and export ENSEMBLE_ROOT to that path; always quote it. Resolve relative resource paths
  against the instruction file that names them, not the project working directory.
- Work on the user's target project. Tools live under ENSEMBLE_ROOT/packages; tool inputs
  and output paths belong to the project, unless a workflow explicitly says otherwise.
- Use manifest.json to map command aliases, skills, tools and role names to installed files.
  A slash command or Skill invocation means read that mapped skill and pass the stated
  arguments as ARGUMENTS. It does not require a provider command registry. Unknown aliases halt.
- Read/Write/Edit mean equivalent file operations; Bash means a shell; Glob/Grep mean file
  discovery/text search. AskUserQuestion means ask the user and wait for the answer.
  Tool names are operation descriptions, not a requirement for vendor APIs.
- Before starting, check the skill's declared required and optional capabilities and every
  concrete external CLI/service it invokes. Required unavailable operations HALT with their
  names and setup needed. Optional operations use ONLY the fallback explicitly authored in
  the workflow. Missing network, credentials, Python packages or project toolchains are not
  bundled capabilities. Never claim they were exercised merely because files were installed.
- Task/delegation requires an available agent execution mechanism and the specified role
  instructions. Independent review requires a distinct evaluator: serial self-review cannot
  replace it. If the needed mechanism or evaluator is unavailable, HALT that workflow.
- MCP/browser/service integrations require their stated service or an explicitly authored
  fallback. Claude hooks, lifecycle enforcement, permitter and runtime configuration are
  outside this portable bundle; installation does not provide them. Runtime setup commands
  appearing in source material are optional integration instructions, not portable operations.
- Never execute unresolved vendor paths or plugin-root searches. Installed tool/resource
  paths in this bundle take precedence. If no manifest entry supplies the requested artifact,
  HALT and name it instead of guessing a path or silently skipping a gate.

These mappings preserve authored approval, independence and failure requirements.
`;

function plan({ root = ROOT, vendor = true } = {}) {
  const files = new Map();
  const catalog = { schema: 1, skills: {}, commands: {}, roles: {}, tools: {}, capabilities: {}, excludedIntegrations: ['Claude hooks', 'lifecycle-claude', 'permitter', 'runtime configuration'] };
  const packagesDir = path.join(root, 'packages');
  const packages = fs.readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !EXCLUDED.has(e.name)).map((e) => e.name).sort();
  const put = (rel, bytes, fileMode = 0o644) => {
    if (files.has(rel)) throw new Error(`Bundle collision: ${rel}`);
    const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    content.fileMode = fileMode;
    files.set(rel, content);
  };
  const load = (file) => yaml.load(fs.readFileSync(file, 'utf8'));
  const commands = [];
  const skillSources = new Map();
  const addCapabilities = (name, capabilities = {}) => {
    const previous = catalog.capabilities[name] || { required: [], optional: [] };
    const required = [...new Set([...previous.required, ...(capabilities.required || [])])].sort();
    const optional = [...new Set([...previous.optional, ...(capabilities.optional || [])])].filter((id) => !required.includes(id)).sort();
    catalog.capabilities[name] = { required, optional };
  };
  for (const pkg of packages) {
    const pkgRoot = path.join(packagesDir, pkg);
    for (const rel of filesBelow(path.join(pkgRoot, 'lib'))) {
      const key = path.basename(rel);
      const value = `packages/${pkg}/lib/${rel}`;
      if (!catalog.tools[key]) catalog.tools[key] = [];
      catalog.tools[key].push(value);
    }
    for (const rel of filesBelow(path.join(pkgRoot, 'skills')).filter((rel) => path.basename(rel) === 'SKILL.md')) {
      const source = path.join(pkgRoot, 'skills', rel);
      const meta = frontmatter(fs.readFileSync(source, 'utf8')).data;
      const name = meta.name || path.basename(path.dirname(source));
      if (!isValidSkillName(name)) throw new Error(`Invalid skill name in ${source}: ${name}`);
      if (skillSources.has(name)) throw new Error(`Duplicate source skill: ${name}`);
      skillSources.set(name, { source, pkg, meta, relative: `packages/${pkg}/skills/${rel}` });
      addCapabilities(name, meta.capabilities || meta.metadata?.capabilities);
    }
    for (const rel of filesBelow(path.join(pkgRoot, 'commands')).filter((rel) => rel.endsWith('.yaml'))) {
      const source = path.join(pkgRoot, 'commands', rel);
      const data = load(source);
      const alias = path.basename(rel, '.yaml');
      const name = isSkillBacked(data) ? data.skill : `ensemble-${alias}`;
      if (catalog.commands[alias]) throw new Error(`Duplicate command alias: ${alias}`);
      if (isSkillBacked(data)) resolveSkillFile(source, name);
      for (const key of [alias, data.metadata.name]) {
        if (catalog.commands[key] && catalog.commands[key] !== name) throw new Error(`Conflicting command identity: ${key}`);
        catalog.commands[key] = name;
      }
      addCapabilities(name, data.metadata.capabilities);
      commands.push({ source, data, name, pkg });
    }
  }

  const normalize = (text, pkg) => {
    let result = text.replace(/\$\{CLAUDE_PLUGIN_ROOT\}\/lib\/([\w.-]+)/g, (whole, name) => {
      const candidates = catalog.tools[name] || [];
      const local = candidates.find((candidate) => candidate.startsWith(`packages/${pkg}/`));
      if (!local && candidates.length !== 1) return whole;
      return `\${ENSEMBLE_ROOT}/${local || candidates[0]}`;
    });
    // Plugin-layout skill paths (`${CLAUDE_PLUGIN_ROOT}/skills/<group>/<skill>/...`) are a Claude
    // plugin-root fiction (a symlink farm); point them at the real package location.
    result = result.replace(/\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/([\w./-]+)/g, (whole, rest) => {
      const segments = rest.split('/');
      for (const tail of [rest, segments.slice(1).join('/')]) {
        if (!tail) continue;
        const hits = packages.filter((p) => fs.existsSync(path.join(packagesDir, p, 'skills', tail)));
        const hit = hits.includes(pkg) ? pkg : hits.length === 1 ? hits[0] : null;
        if (hit) return `\${ENSEMBLE_ROOT}/packages/${hit}/skills/${tail}`;
      }
      return whole;
    });
    result = result.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, `\${ENSEMBLE_ROOT}/packages/${pkg}`);
    return result;
  };

  for (const pkg of packages) {
    const pkgRoot = path.join(packagesDir, pkg);
    // Preserve package-relative require/data/adapter discovery paths, without runtime hooks.
    for (const tree of ['lib', 'toolchain', 'skills', 'data', 'templates']) {
      for (const rel of filesBelow(path.join(pkgRoot, tree))) {
        const source = path.join(pkgRoot, tree, rel);
        const bytes = fs.readFileSync(source);
        put(`ensemble/packages/${pkg}/${tree}/${rel}`, /\.md$/.test(rel) ? normalize(bytes.toString('utf8'), pkg) : bytes,
          fs.statSync(source).mode & 0o111 ? 0o755 : 0o644);
      }
    }
    for (const kind of ['commands', 'agents']) {
      for (const rel of filesBelow(path.join(pkgRoot, kind)).filter((rel) => rel.endsWith('.yaml'))) {
        put(`ensemble/packages/${pkg}/${kind}/${rel}`, fs.readFileSync(path.join(pkgRoot, kind, rel)));
      }
    }
    if (fs.existsSync(path.join(pkgRoot, 'package.json'))) put(`ensemble/packages/${pkg}/package.json`, fs.readFileSync(path.join(pkgRoot, 'package.json')));
    for (const rel of filesBelow(path.join(pkgRoot, 'agents')).filter((rel) => rel.endsWith('.yaml'))) {
      const source = path.join(pkgRoot, 'agents', rel);
      const data = load(source);
      const name = data.metadata.name;
      if (catalog.roles[name]) throw new Error(`Duplicate role: ${name}`);
      catalog.roles[name] = `roles/${name}.md`;
      const body = frontmatter(transformAgentToMarkdown(data, source)).body.replace(/<!-- (?:DO NOT EDIT|To modify this file)[^]*?-->/g, '');
      put(`ensemble/roles/${name}.md`, `${marker}\n${normalize(body, pkg)}`);
    }
  }

  for (const [name, entry] of skillSources) {
    catalog.skills[name] = `skills/${name}/SKILL.md`;
    put(catalog.skills[name], skillText(name, entry.meta.description,
      `First read [the execution contract](../../ensemble/CONTRACT.md).\n\nRead and follow [the full skill](../../ensemble/${entry.relative}); its relative resources resolve against that file. Pass the user's input as ARGUMENTS.\n\nRequired/optional capabilities: see ../../ensemble/manifest.json for this skill and check the concrete operations before execution.`));
  }
  for (const { source, data, name, pkg } of commands) {
    if (isSkillBacked(data)) {
      if (!skillSources.has(name)) throw new Error(`Missing skill-backed source ${name}`);
      continue;
    }
    let body = renderSkillBody({ ...data, dispatch: undefined });
    if (data.dispatch?.subcommands) {
      body += '\n## Subcommands\n\n';
      for (const sub of data.dispatch.subcommands) {
        const target = catalog.commands[sub.ref];
        if (!target) throw new Error(`Unknown dispatcher reference: ${sub.ref}`);
        body += `- ${sub.keyword}: read [${target}](../${target}/SKILL.md), pass the remaining ARGUMENTS. ${sub.description || ''}\n`;
      }
    }
    // The migration renderer preserves the union of existing runtime sections, including constraints and carried keys.
    body = normalize(body, pkg);
    catalog.skills[name] = `skills/${name}/SKILL.md`;
    const capabilities = JSON.stringify(catalog.capabilities[name]);
    put(catalog.skills[name], skillText(name, data.metadata.description,
      `First read [the execution contract](../../ensemble/CONTRACT.md).\n\nCapabilities: ${capabilities}\n\n${body}`));
  }
  put('ensemble/CONTRACT.md', CONTRACT);
  put('ensemble/manifest.json', `${JSON.stringify(catalog, null, 2)}\n`);
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  put('package.json', `${JSON.stringify({ name: '@sunstone-partners/ensemble-skills', version, private: true, description: 'Generated runtime-neutral Ensemble skills and supporting tools' }, null, 2)}\n`);
  if (vendor) {
    const versions = new Map();
    const identities = new Map();
    const copied = new Set();
    const copyDependency = (name, from, parent = 'ensemble') => {
      let depRoot;
      try {
        const request = createRequire(path.join(from, 'package.json'));
        depRoot = path.dirname(request.resolve(name));
        while (!fs.existsSync(path.join(depRoot, 'package.json')) ||
               !JSON.parse(fs.readFileSync(path.join(depRoot, 'package.json'), 'utf8')).name) {
          const parent = path.dirname(depRoot);
          if (parent === depRoot) throw new Error(`Cannot find package root for ${name}`);
          depRoot = parent;
        }
      } catch (error) { throw new Error(`Missing dependency ${name}; run npm ci: ${error.message}`); }
      const meta = JSON.parse(fs.readFileSync(path.join(depRoot, 'package.json'), 'utf8'));
      let destination = `ensemble/node_modules/${name}`;
      if (versions.has(name) && versions.get(name) !== meta.version) destination = `${parent}/node_modules/${name}`;
      else {
        versions.set(name, meta.version);
        identities.set(name, meta.name);
      }
      if (copied.has(destination)) return;
      copied.add(destination);
      for (const rel of fileList(depRoot)) {
        const source = path.join(depRoot, rel);
        put(`${destination}/${rel}`, fs.readFileSync(source), fs.statSync(source).mode & 0o111 ? 0o755 : 0o644);
      }
      for (const dep of Object.keys(meta.dependencies || {}).sort()) copyDependency(dep, depRoot, destination);
    };
    // Explicit runtime entry dependencies; follow declared npm dependencies, not arbitrary requires.
    for (const name of [...VENDORED, 'glob']) copyDependency(name, root);
    const dependencies = Object.fromEntries([...versions].map(([name, version]) => [name,
      identities.get(name) === name ? version : `npm:${identities.get(name)}@${version}`]));
    put('ensemble/package.json', `${JSON.stringify({ name: 'ensemble-installed-support', private: true, dependencies }, null, 2)}\n`);
  }
  const owned = Object.fromEntries([...files].filter(([rel]) => rel !== 'package.json').map(([rel, bytes]) => [rel, hash(bytes)]));
  const modes = Object.fromEntries([...files].filter(([rel]) => rel !== 'package.json').map(([rel, bytes]) => [rel, bytes.fileMode]));
  put('manifest.json', `${JSON.stringify({ schema: 1, files: owned, modes }, null, 2)}\n`);
  return files;
}

function generate({ root = ROOT, output = path.join(root, 'packages/skills'), check = false, vendor = true } = {}) {
  const files = plan({ root, vendor });
  const stale = [];
  const oldPath = path.join(output, 'manifest.json');
  if (fs.existsSync(oldPath)) {
    const old = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
    for (const rel of Object.keys(old.files)) if (!files.has(rel)) stale.push(safePath(output, rel));
  }
  const changed = [...files].filter(([rel, bytes]) => {
    const dest = safePath(output, rel);
    return !fs.existsSync(dest) || !fs.readFileSync(dest).equals(bytes) || (fs.statSync(dest).mode & 0o777) !== bytes.fileMode;
  });
  if (check && (changed.length || stale.length)) throw new Error(`Skills bundle is stale: ${changed.length} changed, ${stale.length} removed; run npm run generate:skills`);
  if (!check) {
    writeFiles(output, files);
    for (const dest of stale) if (fs.existsSync(dest)) fs.unlinkSync(dest);
  }
  return { files: files.size, changed: changed.length, removed: stale.length, check };
}

if (require.main === module) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--check')) throw new Error('Usage: node scripts/generate-skills/index.js [--check]');
    console.log(JSON.stringify(generate({ check: process.argv.includes('--check') })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { plan, generate, EXCLUDED };
