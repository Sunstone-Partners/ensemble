#!/usr/bin/env node
'use strict';

/*
Tests for the behavior-phrase compiler (Step 2 of the Ensemble-as-Behaviors
plan): frontmatter extraction, description sync (idempotent), registry
build, and byte-stable deterministic output.
*/

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const gb = require('../generate-behaviors.js');
const {
  extractFrontmatter,
  parseFrontmatter,
  inspectDescription,
  syncDescription,
  buildRegistry,
  stableStringify,
  MARKER,
  REGISTRY_OUT,
  run,
} = gb;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(REPO_ROOT, REGISTRY_OUT);

describe('frontmatter extraction', () => {
  test('extracts text block and parses YAML', () => {
    const content = '---\nname: demo\nphrases:\n  - do the thing\n---\n# Body\n';
    const fm = extractFrontmatter(content);
    expect(fm).not.toBeNull();
    expect(fm.text).toContain('name: demo');
    const parsed = parseFrontmatter(fm.text);
    expect(parsed.name).toBe('demo');
    expect(parsed.phrases).toEqual(['do the thing']);
  });

  test('null without frontmatter; null on unparseable YAML', () => {
    expect(extractFrontmatter('# no fm\n')).toBeNull();
    expect(parseFrontmatter('key: [unclosed')).toBeNull();
  });
});

describe('description inspection', () => {
  test('plain single-line scalar is accepted (line kind)', () => {
    const fmText = '---\nname: demo\ndescription: Do the demo thing.\nphrases: []\n---\n';
    const inspected = inspectDescription(fmText);
    expect(inspected.ok).toBe(true);
    expect(inspected.kind).toBe('line');
    expect(inspected.rawLine).toContain('Do the demo thing.');
  });

  test('block scalar is rejected', () => {
    const fmText = '---\ndescription: |\n  folded text\n---\n';
    const inspected = inspectDescription(fmText);
    expect(inspected.ok).toBe(false);
    expect(inspected.kind).toBe('block');
  });

  test('multiline folded scalar is rejected', () => {
    const fmText = '---\ndescription:\n  more text here\n---\n';
    const inspected = inspectDescription(fmText);
    expect(inspected.ok).toBe(false);
    expect(inspected.kind).toBe('multiline');
  });

  test('absent description is reported', () => {
    const inspected = inspectDescription('---\nname: x\n---\n');
    expect(inspected.ok).toBe(false);
    expect(inspected.kind).toBe('absent');
  });

  test('compiler quoting round-trips apostrophes without multiplication', () => {
    // quoteYamlSingle doubles ' — parse must give back exactly one.
    const gb2 = require('../generate-behaviors.js');
    const src = '---\nname: s\ndescription: Plain lead.\nphrases:\n  - "it\'s tricky"\n---\n';
    const { content } = gb2.syncDescription(src, ["it's tricky"]);
    const parsed = parseFrontmatter(extractFrontmatter(content).text);
    expect(parsed.description).toContain("it's tricky");
    expect(parsed.description).not.toContain("''");
  });
});

describe('syncDescription', () => {
  test('adds activation sentence naming the phrases', () => {
    const content = '---\nname: s\ndescription: A demo skill.\nphrases:\n  - alpha\n  - beta\n---\n# Body\n';
    const { content: out, changed } = syncDescription(content, ['alpha', 'beta']);
    expect(changed).toBe(true);
    const fm = parseFrontmatter(extractFrontmatter(out).text);
    expect(fm.description).toContain('Use when the user says');
    expect(fm.description).toContain('"alpha", "beta"');
    expect(fm.description.startsWith('A demo skill.')).toBe(true);
  });

  test('idempotent second pass', () => {
    const content = '---\nname: s\ndescription: A demo skill.\nphrases:\n  - alpha\n---\n# Body\n';
    const once = syncDescription(content, ['alpha']);
    const twice = syncDescription(once.content, ['alpha']);
    expect(once.changed).toBe(true);
    expect(twice.changed).toBe(false);
    expect(twice.content).toBe(once.content);
  });

  test('replaces stale phrase list, keeps authored prefix, marker once', () => {
    const content =
      '---\nname: s\ndescription: Lead. Use when the user says: "old phrase."\nphrases:\n  - new phrase\n---\n';
    const { content: out, changed } = syncDescription(content, ['new phrase']);
    expect(changed).toBe(true);
    const fm = parseFrontmatter(extractFrontmatter(out).text);
    expect(fm.description).toContain('"new phrase"');
    expect(fm.description).not.toContain('old phrase');
    expect(fm.description.startsWith('Lead.')).toBe(true);
    expect(fm.description.split('Use when the user says').length - 1).toBe(1);
  });

  test('body untouched; only description line changes', () => {
    const content = '---\nname: s\ndescription: Lead.\nphrases:\n  - alpha\n---\n# Body\nsome text\n';
    const { content: out } = syncDescription(content, ['alpha']);
    expect(out.endsWith('---\n# Body\nsome text\n')).toBe(true);
  });

  test('content without description line returned unchanged', () => {
    const content = '---\nname: s\n---\n';
    const { content: out, changed } = syncDescription(content, ['alpha']);
    expect(changed).toBe(false);
    expect(out).toBe(content);
  });
});

describe('buildRegistry', () => {
  test('bindings carry skill/command/source; phrase keys sorted lowercase', () => {
    const bindings = [
      { skill: 'b-skill', command: '/x:z', phrases: ['Zulu Thing'], source: 'p/b/SKILL.md' },
      { skill: 'a-skill', phrases: ['alpha thing'], source: 'p/a/SKILL.md' },
      { skill: 'z-skill', command: '/y:a', phrases: ['alpha thing'], source: 'p/z/SKILL.md' },
    ];
    const reg = buildRegistry(bindings);
    expect(Object.keys(reg.phrases)).toEqual(['alpha thing', 'zulu thing']);
    expect(reg.phrases['alpha thing'].map((b) => b.skill)).toEqual(['a-skill', 'z-skill']);
    expect(reg.phrases['zulu thing'][0]).toEqual({
      skill: 'b-skill',
      command: '/x:z',
      source: 'p/b/SKILL.md',
    });
  });

  test('command omitted when absent', () => {
    const reg = buildRegistry([{ skill: 's', phrases: ['p'], source: 'x' }]);
    expect(reg.phrases.p[0]).toEqual({ skill: 's', source: 'x' });
  });

  test('registry carries fixed metadata', () => {
    const reg = buildRegistry([]);
    expect(reg.version).toBe('1.0.0');
    expect(reg.description).toContain('Generated file');
  });
});

describe('stableStringify', () => {
  test('is JSON with trailing newline (arrays order-sensitive)', () => {
    const data = { phrases: { b: [1, 2], a: [] }, version: '1.0.0' };
    const text = stableStringify(data);
    expect(text).toBe(JSON.stringify(data, null, 2) + '\n');
    expect(text).not.toBe(stableStringify({ phrases: { b: [2, 1], a: [] }, version: '1.0.0' }));
  });
});

describe('compiled registry artifact', () => {
  const data = () => JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));

  test('exists at canonical path with expected metadata', () => {
    const reg = data();
    expect(typeof reg.description).toBe('string');
    expect(reg.version).toBe('1.0.0');
    expect(Object.keys(reg.phrases).length).toBeGreaterThanOrEqual(43);
  });

  test('every binding source file exists and every command is a real command', () => {
    // Command names come from source command YAML metadata.name.
    const yamlNames = new Set();
    const srcRoot = path.join(REPO_ROOT, 'packages');
    for (const pkg of fs.readdirSync(srcRoot, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      if (pkg.name === 'full' || pkg.name === 'pi' || pkg.name === 'opencode') continue;
      const cmds = path.join(srcRoot, pkg.name, 'commands');
      if (!fs.existsSync(cmds)) continue;
      for (const f of fs.readdirSync(cmds)) {
        if (!f.endsWith('.yaml')) continue;
        try {
          const doc = yaml.load(fs.readFileSync(path.join(cmds, f), 'utf8'));
          if (doc && doc.metadata && typeof doc.metadata.name === 'string') {
            yamlNames.add('/' + doc.metadata.name);
          }
        } catch {
          /* ignore non-parsable sources */
        }
      }
    }
    expect(yamlNames.size).toBeGreaterThan(0);
    for (const bindings of Object.values(data().phrases)) {
      for (const b of bindings) {
        expect(fs.existsSync(path.join(REPO_ROOT, b.source))).toBe(true);
        if (!b.command) continue;
        expect(yamlNames.has(b.command)).toBe(true);
      }
    }
  });

  test('dry-run compile changes nothing', async () => {
    const before = fs.readFileSync(REGISTRY_PATH, 'utf8');
    const result = await run({ root: REPO_ROOT, dryRun: true, silent: true });
    expect(result).toBeDefined();
    expect(fs.readFileSync(REGISTRY_PATH, 'utf8')).toBe(before);
  });

  test('SKILL.md descriptions stay in sync with their phrases', () => {
    // For every registry phrase, the binding skill's description must carry
    // the activation sentence naming that phrase (compiler invariant).
    for (const [phrase, bindings] of Object.entries(data().phrases)) {
      for (const b of bindings) {
        const content = fs.readFileSync(path.join(REPO_ROOT, b.source), 'utf8');
        const fm = parseFrontmatter(extractFrontmatter(content).text);
        expect(typeof fm.description).toBe('string');
        expect(fm.description).toContain('Use when the user says');
        expect(fm.description.toLowerCase()).toContain(phrase);
      }
    }
  });
});
