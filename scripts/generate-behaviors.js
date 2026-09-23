#!/usr/bin/env node
'use strict';

/**
 * Behavior Phrase Compiler
 *
 * Reads SKILL.md frontmatter across source packages, extracts `phrases`,
 * syncs a deterministic activation sentence into each skill's `description`,
 * and compiles an immutable phrase registry consumed by the router hook.
 *
 * This file is the single source of truth for the phrase -> skill -> command
 * mapping. It never writes to command YAML and never touches router-rules.json.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { glob } = require('glob');
const { discoverYamlFiles, toGlobPattern } = require('./lib/file-discovery');

const REPO_ROOT = path.resolve(__dirname, '..');
const MARKER = ' Use when the user says:';
const COMMAND_RE = /^\/[a-z0-9:-]+$/;
const REGISTRY_OUT = path.join('packages', 'router', 'lib', 'behavior-phrases.json');

// ---------------------------------------------------------------------------
// Skill discovery
// ---------------------------------------------------------------------------

/**
 * Return the source SKILL.md files, visiting each skill exactly once.
 * - packages/full/** is a symlink mirror -> excluded.
 * - packages/pi/** holds generated copies -> excluded.
 * - symlinked source dirs (blazor, phoenix, exunit, rspec, ...) are pruned
 *   when their real path is already covered by a canonical whole-package
 *   directory (packages/<name>/skills).
 * @param {string} root
 * @returns {Promise<string[]>} repo-relative POSIX paths, sorted
 */
async function discoverSkillFiles(root = REPO_ROOT) {
  const pattern = path.join(root, 'packages', '*', 'skills', '**', 'SKILL.md');
  const matches = await glob(toGlobPattern(pattern), { nodir: true });

  // Map canonical whole-package skill dirs -> absolute real path of the dir.
  const packagesDir = path.join(root, 'packages');
  const canonical = [];
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'full' || entry.name === 'pi') continue;
    const skillsDir = path.join(packagesDir, entry.name, 'skills');
    try {
      canonical.push(fs.realpathSync(skillsDir));
    } catch {
      // package has no skills dir; nothing to canonicalize
    }
  }

  const out = new Set();
  for (const match of matches) {
    const abs = path.resolve(root, match);
    const parts = path.relative(root, abs).split(path.sep);
    // Skip the symlink mirror and generated copies entirely.
    if (parts[0] === 'packages' && (parts[1] === 'full' || parts[1] === 'pi')) continue;

    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      continue;
    }
    // A symlinked alias whose real path lives under a canonical package skills
    // dir is a duplicate of a file already visited via its canonical path —
    // but only when the match itself was reached through a symlink.
    if (real !== abs) {
      const dup = canonical.some((dir) => real === path.join(dir, 'SKILL.md'));
      if (dup) continue;
    }

    out.add(realpathRel(root, real));
  }
  return [...out].sort();
}

function realpathRel(root, absReal) {
  return path.relative(root, absReal).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Extract the leading `---` fenced frontmatter block from a SKILL.md body.
 * @returns {{ text: string, startLine: number } | null}
 */
function extractFrontmatter(content) {
  const lines = content.split('\n');
  if ((lines[0] || '').trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return null;
  return { text: lines.slice(1, end).join('\n'), startLine: 1 };
}

function parseFrontmatter(fmText) {
  try {
    const data = yaml.load(fmText);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/**
 * Determine whether a description value is a plain single-line scalar in the
 * raw frontmatter source (rejects block scalars and folded/continuation lines).
 * Returns { ok: boolean, kind: 'line'|'block'|'absent'|'multiline' }
 */
function inspectDescription(fmText) {
  const lines = fmText.split('\n');
  const idx = lines.findIndex((l) => /^description:/.test(l));
  if (idx === -1) return { ok: false, kind: 'absent' };
  const raw = lines[idx];
  const value = raw.slice('description:'.length);
  // Block scalar indicator immediately after the key.
  if (/^\s*[|>][-+]?\s*$/.test(value)) return { ok: false, kind: 'block' };
  // If the rest of the line is empty but a more-indented continuation follows.
  if (value.trim() === '') return { ok: false, kind: 'multiline' };
  // A following more-indented line indicates a folded multiline scalar.
  const next = lines[idx + 1] || '';
  if (/^\s+\S/.test(next)) return { ok: false, kind: 'multiline' };
  return { ok: true, kind: 'line', rawLine: raw, lineIndex: idx };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a single skill's phrase contract. Collects all errors.
 * @returns {string[]} error messages (empty == valid)
 */
function validateSkill(fm, ctxLabel) {
  const errors = [];
  const phrases = fm.phrases;
  if (!Array.isArray(phrases)) {
    errors.push(`${ctxLabel}: 'phrases' must be a list of strings`);
    return errors;
  }
  const seen = new Set();
  for (const phrase of phrases) {
    if (typeof phrase !== 'string') {
      errors.push(`${ctxLabel}: every phrase must be a string (got ${JSON.stringify(phrase)})`);
      continue;
    }
    if (phrase.length < 3) {
      errors.push(`${ctxLabel}: phrase too short (<3 chars): ${JSON.stringify(phrase)}`);
    }
    if (phrase.includes('"')) {
      errors.push(`${ctxLabel}: phrase contains a double quote: ${JSON.stringify(phrase)}`);
    }
    const key = `${fm.name}::${phrase.toLowerCase()}`;
    if (seen.has(key)) {
      errors.push(`${ctxLabel}: duplicate phrase bound to same skill: ${JSON.stringify(phrase)}`);
    }
    seen.add(key);
  }
  if (phrases.length === 0) {
    errors.push(`${ctxLabel}: 'phrases' list is empty`);
  }
  if (typeof fm.command === 'string' && !COMMAND_RE.test(fm.command)) {
    errors.push(`${ctxLabel}: command must match ^/[a-z0-9:-]+$ (got ${JSON.stringify(fm.command)})`);
  }
  if ('command' in fm && fm.command !== undefined && typeof fm.command !== 'string') {
    errors.push(`${ctxLabel}: command must be a string if present`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Command resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the set of valid command references ("/ensemble:foo") from source
 * command YAMLs via discoverYamlFiles metadata.name.
 * @returns {Promise<Set<string>>}
 */
async function loadCommandSet(root = REPO_ROOT) {
  const discovered = await discoverYamlFiles(path.join(root, 'packages'), { types: ['commands'] });
  const names = new Set();
  for (const yamlPath of discovered.commands) {
    let text;
    try {
      text = fs.readFileSync(yamlPath, 'utf8');
    } catch {
      continue;
    }
    let doc;
    try {
      doc = yaml.load(text);
    } catch {
      continue;
    }
    const name = doc && doc.metadata && doc.metadata.name;
    if (typeof name === 'string') names.add('/' + name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Description sync
// ---------------------------------------------------------------------------

function quoteYamlSingle(text) {
  return "'" + text.replace(/'/g, "''") + "'";
}

function activationSentence(phrases) {
  const parts = phrases.map((p) => '"' + p + '"').join(', ');
  return `${MARKER} ${parts}.`;
}

/**
 * Rewrite the description line in place. Idempotent: only the `description:`
 * line is touched; authored prose before the marker is preserved verbatim.
 * @returns {{ content: string, changed: boolean }}
 */
function syncDescription(content, phrases) {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => /^description:/.test(l));
  if (idx === -1) return { content, changed: false };

  const raw = lines[idx];
  const value = raw.slice('description:'.length);
  // Parse the current scalar so we can recover its authored prefix.
  let current;
  try {
    // Parse only the VALUE as a standalone scalar; reconstructing it as a
    // mapping (description:...) would return an object, not a string.
    const parsed = yaml.load(value);
    current = typeof parsed === 'string' ? parsed : value.trim();
  } catch {
    current = value.trim();
  }
  const markerPos = current.indexOf(MARKER);
  const prefix = (markerPos === -1 ? current : current.slice(0, markerPos)).replace(/\s+$/, '');
  const newLine = `description: ${quoteYamlSingle(prefix + activationSentence(phrases))}`;
  if (newLine === raw) return { content, changed: false };
  lines[idx] = newLine;
  return { content: lines.join('\n'), changed: true };
}

// ---------------------------------------------------------------------------
// Registry compilation
// ---------------------------------------------------------------------------

function buildRegistry(bindings) {
  const phrases = {};
  for (const b of bindings) {
    for (const phrase of b.phrases) {
      const key = phrase.toLowerCase();
      (phrases[key] = phrases[key] || []).push({
        skill: b.skill,
        ...(b.command ? { command: b.command } : {}),
        source: b.source,
      });
    }
  }
  // Sort bindings within each phrase by skill name; sort phrase keys.
  const sortedPhrases = {};
  for (const key of Object.keys(phrases).sort()) {
    sortedPhrases[key] = phrases[key].slice().sort((x, y) => x.skill.localeCompare(y.skill));
  }
  // Insert top-level keys in sorted order.
  return {
    description:
      'Compiled from phrases in packages/*/skills/**/SKILL.md frontmatter. Generated file - do not edit by hand.',
    phrases: sortedPhrases,
    version: '1.0.0',
  };
}

function stableStringify(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

async function run({ root = REPO_ROOT, dryRun = false, silent = false } = {}) {
  const log = (...a) => {
    if (!silent) console.error(...a);
  };
  const skillFiles = await discoverSkillFiles(root);
  const commandSet = await loadCommandSet(root);

  const errors = [];
  const bindings = [];

  for (const rel of skillFiles) {
    const abs = path.join(root, rel);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const fmBlock = extractFrontmatter(content);
    if (!fmBlock) continue; // normal case for frontmatter-less skills
    let fm;
    let parseErr = null;
    try {
      fm = yaml.load(fmBlock.text);
    } catch (e) {
      parseErr = e;
    }
    const mentionsPhrases = /^phrases:/m.test(fmBlock.text);
    if (parseErr || !fm || typeof fm !== 'object') {
      if (mentionsPhrases) {
        errors.push(
          `${rel}: frontmatter declares 'phrases' but is not valid YAML single-line scalars — ${parseErr ? parseErr.message : 'parse returned null'}`,
        );
      }
      continue; // frontmatter-less / unparseable-but-phrase-less skills are skipped
    }
    if (!('phrases' in fm)) continue; // skills without a phrases key are skipped

    const label = rel;
    const desc = inspectDescription(fmBlock.text);
    if (!desc.ok) {
      if (desc.kind === 'absent') {
        errors.push(`${label}: 'description' is absent but 'phrases' present`);
      } else {
        errors.push(
          `${label}: 'description' must be a single-line scalar (found ${desc.kind}); inline it on one line`,
        );
      }
    }
    errors.push(...validateSkill(fm, label));

    // A valid skill entry requires a name.
    const name = typeof fm.name === 'string' ? fm.name : path.basename(path.dirname(abs));
    const phraseList = Array.isArray(fm.phrases)
      ? fm.phrases.filter((p) => typeof p === 'string')
      : [];

    if (typeof fm.command === 'string' && !commandSet.has(fm.command)) {
      errors.push(`${label}: command '${fm.command}' is not a known command in the source set`);
    }

    // Description sync (in place, idempotent).
    if (desc.ok && phraseList.length && !dryRun) {
      const { content: updated, changed } = syncDescription(content, phraseList);
      if (changed) {
        fs.writeFileSync(abs, updated);
        log(`synced description: ${rel}`);
      }
    }

    bindings.push({
      skill: name,
      command: typeof fm.command === 'string' ? fm.command : undefined,
      phrases: phraseList,
      source: rel,
    });
  }

  if (errors.length) {
    for (const e of errors) console.error(e);
    return { ok: false, errors, registry: null };
  }

  const registry = buildRegistry(bindings);
  const outAbs = path.join(root, REGISTRY_OUT);
  const serialized = stableStringify(registry);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, serialized);
  }

  return { ok: true, registry, serialized, skillFiles, bindings, outAbs };
}

if (require.main === module) {
  run()
    .then((res) => {
      if (!res.ok) {
        process.exit(1);
      }
      const count = Object.keys(res.registry.phrases).length;
      console.error(`generate-behaviors: ${res.skillFiles.length} skills scanned, ${count} phrases compiled`);
    })
    .catch((err) => {
      console.error('generate-behaviors failed:', err && err.message ? err.message : err);
      process.exit(1);
    });
}

module.exports = {
  discoverSkillFiles,
  extractFrontmatter,
  parseFrontmatter,
  inspectDescription,
  validateSkill,
  loadCommandSet,
  syncDescription,
  buildRegistry,
  stableStringify,
  run,
  MARKER,
  REGISTRY_OUT,
};
