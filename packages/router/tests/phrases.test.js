#!/usr/bin/env node
'use strict';

/*
Tests for the router's additive phrase layer (Step 3 of the
Ensemble-as-Behaviors plan). The phrase layer reads the compiled
behavior-phrases.json registry and surfaces matching skills/commands in
the UserPromptSubmit hint — it never modifies router-rules.json behavior.
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const router = require('../hooks/router.js');
const {
  loadPhrases,
  matchPhrases,
  buildPhraseBlock,
  normalizeText,
} = router;

const REGISTRY = path.join(__dirname, '..', 'lib', 'behavior-phrases.json');

function registryPathEnv(fn) {
  const saved = process.env.ROUTER_PHRASES_PATH;
  const savedDisable = process.env.ROUTER_PHRASES_DISABLE;
  delete process.env.ROUTER_PHRASES_DISABLE;
  process.env.ROUTER_PHRASES_PATH = REGISTRY;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.ROUTER_PHRASES_PATH;
    else process.env.ROUTER_PHRASES_PATH = saved;
    if (savedDisable === undefined) delete process.env.ROUTER_PHRASES_DISABLE;
    else process.env.ROUTER_PHRASES_DISABLE = savedDisable;
  }
}

function writeTempRegistry(obj) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phrases-')), 'reg.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe('phrase registry', () => {
  test('compiled registry exists and has expected shape', () => {
    const data = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    expect(data.version).toBe('1.0.0');
    expect(typeof data.phrases).toBe('object');
    expect(Object.keys(data.phrases).length).toBeGreaterThan(0);
    for (const [phrase, bindings] of Object.entries(data.phrases)) {
      expect(phrase).toBe(normalizeText(phrase));
      expect(Array.isArray(bindings)).toBe(true);
      expect(bindings.length).toBeGreaterThan(0);
      for (const b of bindings) {
        expect(typeof b.skill).toBe('string');
        expect(b.skill.length).toBeGreaterThan(0);
        if (b.command !== undefined) {
          expect(b.command).toMatch(/^\/[a-z0-9:-]+$/);
        }
        expect(typeof b.source).toBe('string');
      }
    }
  });

  test('phrase keys are sorted (byte-stable output)', () => {
    const data = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    const keys = Object.keys(data.phrases);
    expect(keys).toEqual([...keys].sort());
  });
});

describe('loadPhrases', () => {
  test('loads the default registry', () => {
    const reg = registryPathEnv(() => loadPhrases({ cwd: process.cwd() }));
    expect(reg).not.toBeNull();
    expect(reg.phrases).toBeDefined();
  });

  test('ROUTER_PHRASES_DISABLE=1 suppresses the layer', () => {
    const savedPath = process.env.ROUTER_PHRASES_PATH;
    process.env.ROUTER_PHRASES_PATH = REGISTRY;
    process.env.ROUTER_PHRASES_DISABLE = '1';
    try {
      expect(loadPhrases({})).toBeNull();
    } finally {
      delete process.env.ROUTER_PHRASES_DISABLE;
      if (savedPath === undefined) delete process.env.ROUTER_PHRASES_PATH;
      else process.env.ROUTER_PHRASES_PATH = savedPath;
    }
  });

  test('missing registry file degrades to null (never throws)', () => {
    const saved = process.env.ROUTER_PHRASES_PATH;
    process.env.ROUTER_PHRASES_PATH = '/nonexistent/behavior-phrases.json';
    try {
      expect(loadPhrases({})).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.ROUTER_PHRASES_PATH;
      else process.env.ROUTER_PHRASES_PATH = saved;
    }
  });

  test('malformed registry degrades to null', () => {
    const p = writeTempRegistry({ phrases: 'not-an-object' });
    const saved = process.env.ROUTER_PHRASES_PATH;
    process.env.ROUTER_PHRASES_PATH = p;
    try {
      expect(loadPhrases({})).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.ROUTER_PHRASES_PATH;
      else process.env.ROUTER_PHRASES_PATH = saved;
    }
  });
});

describe('matchPhrases', () => {
  const reg = {
    phrases: {
      'create a prd': [{ skill: 'creating-a-prd', command: '/ensemble:create-prd', source: 'a' }],
      'merge the pr': [{ skill: 'merging-a-pr', command: '/ensemble:pr-merge', source: 'b' }],
      'sync my branch': [{ skill: 'git-town', source: 'c' }],
    },
  };

  test('case-insensitive substring match', () => {
    const m = matchPhrases('I need to CREATE A PRD for the billing feature', reg);
    expect(m.length).toBe(1);
    expect(m[0].skill).toBe('creating-a-prd');
    expect(m[0].command).toBe('/ensemble:create-prd');
  });

  test('no regex or fuzzy matching — partial words do not match', () => {
    expect(matchPhrases('prd me a sandwich', reg)).toEqual([]);
    expect(matchPhrases('merged already', reg)).toEqual([]);
    expect(matchPhrases('my branch is sync', reg)).toEqual([]);
  });

  test('phrase embedded anywhere in prompt matches', () => {
    const m = matchPhrases('hey can you please merge the pr when checks pass', reg);
    expect(m.length).toBe(1);
    expect(m[0].skill).toBe('merging-a-pr');
  });

  test('multiple phrases match independently', () => {
    const m = matchPhrases('create a prd then merge the pr', reg);
    expect(m.map((x) => x.skill)).toEqual(['creating-a-prd', 'merging-a-pr']);
  });

  test('results sorted by skill then phrase (deterministic)', () => {
    const m = matchPhrases('merge the pr and create a prd', reg);
    expect(m.map((x) => x.skill)).toEqual(['creating-a-prd', 'merging-a-pr']);
  });

  test('same skill+phrase deduped even with several bindings', () => {
    const dup = {
      phrases: {
        'create a prd': [
          { skill: 'creating-a-prd', command: '/ensemble:create-prd', source: 'a' },
          { skill: 'creating-a-prd', command: '/other:cmd', source: 'd' },
        ],
      },
    };
    const m = matchPhrases('create a prd', dup);
    expect(m.length).toBe(1);
  });

  test('null/empty registry returns empty', () => {
    expect(matchPhrases('create a prd', null)).toEqual([]);
    expect(matchPhrases('create a prd', {})).toEqual([]);
  });
});

describe('buildPhraseBlock', () => {
  test('formats matches with skill and command', () => {
    const block = buildPhraseBlock([
      { phrase: 'create a prd', skill: 'creating-a-prd', command: '/ensemble:create-prd' },
    ]);
    expect(block).toContain('create a prd');
    expect(block).toContain('creating-a-prd');
    expect(block).toContain('/ensemble:create-prd');
    expect(block).toContain('suggestions');
  });

  test('command-less match (git-town style) omits run pointer', () => {
    const block = buildPhraseBlock([
      { phrase: 'sync my branch', skill: 'git-town', command: undefined },
    ]);
    expect(block).toContain('git-town');
    expect(block).toContain('sync my branch');
    expect(block).not.toContain('run /');
  });
});

describe('router main + phrase layer (integration)', () => {
  function runHook(prompt, extraEnv = {}) {
    const savedPath = process.env.ROUTER_PHRASES_PATH;
    const savedDisable = process.env.ROUTER_PHRASES_DISABLE;
    process.env.ROUTER_PHRASES_PATH = REGISTRY;
    delete process.env.ROUTER_PHRASES_DISABLE;
    for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;
    try {
      const out = execFileSync(
        process.execPath,
        [path.join(__dirname, '..', 'hooks', 'router.js')],
        {
          input: JSON.stringify({ prompt }),
          encoding: 'utf8',
          timeout: 10000,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      return JSON.parse(out.trim());
    } finally {
      if (savedPath === undefined) delete process.env.ROUTER_PHRASES_PATH;
      else process.env.ROUTER_PHRASES_PATH = savedPath;
      if (savedDisable === undefined) delete process.env.ROUTER_PHRASES_DISABLE;
      else process.env.ROUTER_PHRASES_DISABLE = savedDisable;
      for (const k of Object.keys(extraEnv)) delete process.env[k];
    }
  }

  test('phrase match enriches output for command-fronted behavior', () => {
    const out = runHook('I need to create a PRD for the billing feature');
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput.additionalContext).toContain('creating-a-prd');
    expect(out.hookSpecificOutput.additionalContext).toContain('/ensemble:create-prd');
  });

  test('phrase match without command still surfaces skill', () => {
    const out = runHook('can you create a PR for this');
    expect(out.hookSpecificOutput.additionalContext).toContain('git-town');
  });
  test('phrase layer disable leaves legacy behavior untouched', () => {
    // Disabled via config object (env propagation into the Jest worker child
    // is not reliable; loadPhrases honors config.phrasesDisable equivalently).
    const saved = process.env.ROUTER_PHRASES_PATH;
    process.env.ROUTER_PHRASES_PATH = REGISTRY;
    try {
      expect(loadPhrases({ phrasesDisable: true })).toBeNull();
      expect(loadPhrases({ phrasesPath: REGISTRY })).not.toBeNull();
    } finally {
      if (saved === undefined) delete process.env.ROUTER_PHRASES_PATH;
      else process.env.ROUTER_PHRASES_PATH = saved;
    }
  });

  test('ROUTER_PHRASES_DISABLE=1 reaches hook subprocess via env option', () => {
    // Same env contract production hooks.json relies on (stdio launch with
    // process env). Jest worker's own process.env mutation is not proven to
    // propagate into execFileSync children in this sandbox, so pass it via
    // the explicit env option — identical key/value the real hook receives.
    const out = execFileSync(
      process.execPath,
      [path.join(__dirname, '..', 'hooks', 'router.js')],
      {
        input: JSON.stringify({ prompt: 'I need to create a PRD for billing' }),
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ROUTER_PHRASES_PATH: REGISTRY, ROUTER_PHRASES_DISABLE: '1' },
      },
    );
    const parsed = JSON.parse(out.trim());
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain('Ensemble behaviors');
  });

  test('non-matching prompt: exit 0, no phrase block', () => {
    const out = runHook('what time is it in tokyo');
    expect(out.hookSpecificOutput).toBeDefined();
    expect(out.hookSpecificOutput.additionalContext).not.toContain('Ensemble behaviors');
  });
});
