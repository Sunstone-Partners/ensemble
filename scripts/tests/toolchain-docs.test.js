'use strict';
/**
 * TRD-2026-8d825f54 TRD-050-TEST: the contract specs, the adapter authoring guide and the
 * migration guide exist and cover what the lint and the contract generator actually ship.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const generator = require('../generate-contract-docs');

const ROOT = path.join(__dirname, '..', '..');
const CATEGORIES_DIR = path.join(ROOT, 'packages', 'development', 'toolchain', 'categories');
const CONTRACTS_DIR = path.join(ROOT, 'docs', 'toolchain', 'contracts');
const AUTHORING_GUIDE = path.join(ROOT, 'docs', 'guides', 'adapter-authoring.md');
const MIGRATION_GUIDE = path.join(ROOT, 'docs', 'guides', 'toolchain-migration.md');

const categoryNames = () =>
  fs
    .readdirSync(CATEGORIES_DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => name.replace(/\.ya?ml$/, ''))
    .sort();

/**
 * Every lint failure class: read from the two class-owning modules' source (every
 * `class: 'CODE'` they emit, plus the three `BINARY_IN_<KIND>` classes the lint derives) and
 * from any class list those modules export, so adding a class without documenting it fails.
 * The TRD's six named classes are always required.
 */
function lintClasses() {
  const classes = new Set([
    'BINARY_IN_COMMAND',
    'BINARY_IN_AGENT',
    'BINARY_IN_SKILL',
    'MISSING_PREFLIGHT',
    'MISSING_BASH_GRANT',
    'UNMAPPED_TOOL'
  ]);
  const files = ['scripts/lint-provider-refs.js', 'scripts/lib/taxonomy-coverage.js'];
  for (const rel of files) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const match of source.matchAll(/\bclass:\s*'([A-Z][A-Z_]+)'/g)) {
      if (match[1] !== 'BINARY') classes.add(match[1]);
    }
    const exported = require(path.join(ROOT, rel));
    for (const key of ['VIOLATION_CLASSES', 'CLASSES', 'LINT_CLASSES', 'ERROR_CLASSES']) {
      if (Array.isArray(exported[key])) exported[key].forEach((c) => classes.add(c));
    }
  }
  return [...classes].sort();
}

/** The body of the `## <heading>` section containing `heading`, up to the next `## `. */
function sectionFor(markdown, code) {
  const lines = markdown.split('\n');
  const isHeading = (line, inFence) => !inFence && /^#{2,4}\s/.test(line);
  let inFence = false;
  let start = -1;
  let level = 0;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) inFence = !inFence;
    if (start === -1) {
      if (isHeading(line, inFence) && line.includes(code)) {
        start = i;
        level = line.match(/^#+/)[0].length;
      }
    } else if (!inFence) {
      const m = line.match(/^(#+)\s/);
      if (m && m[1].length <= level) {
        end = i;
        break;
      }
    }
  }
  return start === -1 ? null : lines.slice(start + 1, end).join('\n');
}

const ASCII_PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

/** The text a Markdown renderer shows for `raw`: a backslash before ASCII punctuation is an escape. */
function unescapeMarkdown(raw) {
  let text = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && i + 1 < raw.length && ASCII_PUNCTUATION.includes(raw[i + 1])) i++;
    text += raw[i];
  }
  return text;
}

/**
 * The cell texts of a rendered Markdown table row. A pipe ends a cell unless a backslash escapes
 * it, and a doubled backslash is one literal backslash that escapes nothing.
 */
function tableCells(row) {
  const cells = [];
  let raw = '';
  for (let i = 1; i < row.length; i++) {
    if (row[i] === '\\' && i + 1 < row.length) {
      raw += row[i] + row[i + 1];
      i++;
    } else if (row[i] === '|') {
      cells.push(raw);
      raw = '';
    } else {
      raw += row[i];
    }
  }
  return cells.map((cell) => unescapeMarkdown(cell.trim()));
}

describe('contract docs', () => {
  test('docs/toolchain/contracts holds one non-empty file per category plus a README', () => {
    const names = categoryNames();
    expect(names).toHaveLength(14);
    const expected = [...names.map((n) => `${n}.md`), 'README.md'].sort();
    expect(fs.readdirSync(CONTRACTS_DIR).sort()).toEqual(expected);
    for (const file of expected) {
      const text = fs.readFileSync(path.join(CONTRACTS_DIR, file), 'utf8');
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  test('each category file lists every capability with its contract version', () => {
    const yaml = require('js-yaml');
    for (const name of categoryNames()) {
      const contract = yaml.load(fs.readFileSync(path.join(CATEGORIES_DIR, `${name}.yaml`), 'utf8'));
      const doc = fs.readFileSync(path.join(CONTRACTS_DIR, `${name}.md`), 'utf8');
      expect(doc).toContain(`Contract version: \`${contract.version}\``);
      for (const [id, cap] of Object.entries(contract.capabilities)) {
        expect(doc).toContain(`\`${id}\``);
        const row = doc.split('\n').find((l) => l.startsWith(`| \`${id}\` |`));
        expect(row).toBeDefined();
        expect(row).toContain(cap.required === true ? '| required |' : '| optional |');
        for (const field of [...cap.inputs, ...cap.outputs]) expect(row).toContain(`\`${field}\``);
        if (cap.fallback) expect(row).toContain(`\`${cap.fallback}\``);
      }
    }
  });

  test('renderContract renders required, optional, sideEffect and fallback', () => {
    const out = generator.renderContract({
      category: 'lint',
      version: '2.3',
      capabilities: {
        'lint.a': { description: 'A | pipe', inputs: ['x'], outputs: ['y'], required: true, sideEffect: false },
        'lint.b': { inputs: ['x'], outputs: ['y'], required: false, sideEffect: true, fallback: 'fb' }
      }
    });
    expect(out).toContain('Contract version: `2.3`');
    expect(out).toContain('| `lint.a` | required | no |');
    expect(out).toContain('| `lint.b` | optional | yes |');
    expect(out).toContain('`fb`');
    expect(out).toContain('A \\| pipe');
    expect(out.endsWith('\n')).toBe(true);
  });

  describe('description escaping', () => {
    // A backslash before a pipe, before a letter and before punctuation, plus a bare pipe.
    const description = 'Matches C:\\tmp\\|out, a\\*b or a|b';
    const renderedLines = () =>
      generator
        .renderContract({
          category: 'lint',
          version: '1.0',
          capabilities: { 'lint.a': { description, inputs: ['x'], outputs: ['y'], required: true, sideEffect: false } }
        })
        .split('\n');

    test('a description keeps its backslashes and pipes in the table row without adding cells', () => {
      const lines = renderedLines();
      const header = tableCells(lines.find((l) => l.startsWith('| Capability |')));
      const row = tableCells(lines.find((l) => l.startsWith('| `lint.a` |')));
      expect(row).toHaveLength(header.length);
      expect(row[row.length - 1]).toBe(description);
    });

    test('a description keeps its backslashes and pipes in the details paragraph', () => {
      const lines = renderedLines();
      expect(unescapeMarkdown(lines[lines.indexOf('### lint.a') + 2])).toBe(description);
    });
  });

  test('--check exits 0 on the committed docs', () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'generate-contract-docs.js'), '--check'], {
      encoding: 'utf8'
    });
    expect(result.status).toBe(0);
  });

  describe('--check on a scratch tree', () => {
    let tmp;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-docs-'));
      fs.mkdirSync(path.join(tmp, 'packages', 'development', 'toolchain'), { recursive: true });
      fs.cpSync(CATEGORIES_DIR, path.join(tmp, 'packages', 'development', 'toolchain', 'categories'), {
        recursive: true
      });
      jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      jest.restoreAllMocks();
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('exits 1 naming a missing file before generation, 0 after', () => {
      expect(generator.main(['--check'], tmp)).toBe(1);
      const named = console.error.mock.calls.map((c) => c[0]).join('\n');
      expect(named).toContain(path.join('docs', 'toolchain', 'contracts', 'tracker.md'));

      expect(generator.main([], tmp)).toBe(0);
      console.error.mockClear();
      expect(generator.main(['--check'], tmp)).toBe(0);
      expect(console.error).not.toHaveBeenCalled();
    });

    test('exits 1 naming exactly the stale file after one is edited', () => {
      generator.main([], tmp);
      const stale = path.join(tmp, 'docs', 'toolchain', 'contracts', 'workflow.md');
      fs.appendFileSync(stale, '\nhand edit\n');
      console.error.mockClear();

      expect(generator.main(['--check'], tmp)).toBe(1);
      const named = console.error.mock.calls.map((c) => c[0]);
      expect(named).toContain(`stale or missing: ${path.join('docs', 'toolchain', 'contracts', 'workflow.md')}`);
      expect(named.filter((m) => m.startsWith('stale or missing:'))).toHaveLength(1);
    });

    test('exits 1 when a category contract changes without regeneration', () => {
      generator.main([], tmp);
      const yamlPath = path.join(tmp, 'packages', 'development', 'toolchain', 'categories', 'lint.yaml');
      fs.writeFileSync(yamlPath, fs.readFileSync(yamlPath, 'utf8').replace(/version: "[^"]+"/, 'version: "9.9"'));
      console.error.mockClear();

      expect(generator.main(['--check'], tmp)).toBe(1);
      expect(console.error.mock.calls.map((c) => c[0]).join('\n')).toContain('lint.md');
    });
  });
});

describe('adapter authoring guide', () => {
  const guide = () => fs.readFileSync(AUTHORING_GUIDE, 'utf8');

  test('exists and is non-empty', () => {
    expect(fs.existsSync(AUTHORING_GUIDE)).toBe(true);
    expect(guide().trim().length).toBeGreaterThan(0);
  });

  test.each(['Layout', 'Manifest fields', 'Allowlist', 'Health checks', 'Validate'])('has a "%s" heading', (title) => {
    expect(guide()).toMatch(new RegExp(`^#{2,3}\\s+${title}\\s*$`, 'm'));
  });

  test('names the validate command and both adapter locations', () => {
    const text = guide();
    expect(text).toContain('toolchain-cli validate');
    expect(text).toContain('.ensemble/adapters/');
    expect(text).toContain('$XDG_CONFIG_HOME/ensemble/adapters/');
  });

  test('documents every required manifest field of the real schema', () => {
    const schema = require(path.join(ROOT, 'packages', 'development', 'toolchain', 'schemas', 'adapter-manifest-schema.json'));
    const text = guide();
    for (const field of schema.required) expect(text).toContain(`\`${field}\``);
  });
});

describe('toolchain migration guide', () => {
  const guide = () => fs.readFileSync(MIGRATION_GUIDE, 'utf8');

  test('exists and is non-empty', () => {
    expect(guide().trim().length).toBeGreaterThan(0);
  });

  test('the discovered class list includes the six classes the TRD names', () => {
    expect(lintClasses()).toEqual(
      expect.arrayContaining([
        'BINARY_IN_COMMAND',
        'BINARY_IN_AGENT',
        'BINARY_IN_SKILL',
        'MISSING_PREFLIGHT',
        'MISSING_BASH_GRANT',
        'UNMAPPED_TOOL'
      ])
    );
  });

  test.each(lintClasses())('%s has a heading followed by a before and an after example', (code) => {
    const body = sectionFor(guide(), code);
    expect(body).not.toBeNull();
    const headingLine = guide().split('\n').find((l) => /^#{2,4}\s/.test(l) && l.includes(code));
    expect(headingLine.replace(/^#+\s+/, '').trim()).toBe(code);
    expect(body).toMatch(/^Before:?\s*$/m);
    expect(body).toMatch(/^After:?\s*$/m);
    expect(body.indexOf('Before')).toBeLessThan(body.indexOf('After'));
    expect((body.match(/^```/gm) || []).length).toBeGreaterThanOrEqual(4);
  });

  test('documents exemptions, the baseline ratchet and the taxonomy check', () => {
    const text = guide();
    for (const needle of [
      '_CLI',
      'ignoredCommands',
      'scripts/lint-provider-refs.baseline.json',
      '--update-baseline',
      'baseline can shrink',
      'scripts/check-taxonomy-coverage.js'
    ]) {
      expect(text).toContain(needle);
    }
  });
});
