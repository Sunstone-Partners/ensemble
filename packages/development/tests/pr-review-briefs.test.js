'use strict';

/**
 * Agent briefs rendered from templates (plan section 3G, kata 9pg5).
 *
 * The golden fixtures under tests/fixtures/pr-review-briefs/ are the policy text of each
 * brief exactly as the reference docs carried it before it moved into a template
 * (blockquote markers removed, line wraps kept). They are the independent side of the
 * byte-equality check: a template edit that changes policy fails here until the fixture
 * is deliberately updated with it.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { ROLES, renderBrief, checkTemplate, placeholdersOf } = require('../lib/pr-review-briefs');
const { loadTemplate, renderBriefFromFiles, defaultTemplateDirs } = require('../lib/pr-review-brief-files');

const DEV_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DEV_ROOT, '..', '..');
const TEMPLATE_DIR = path.join(DEV_ROOT, 'skills', 'pr-review-cycle', 'templates');
const REFERENCE_DIR = path.join(DEV_ROOT, 'skills', 'pr-review-cycle', 'reference');
const CLI = path.join(DEV_ROOT, 'lib', 'pr-review-cli.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'pr-review-briefs');

const policy = (role) => fs.readFileSync(path.join(FIXTURES, `${role}.policy.txt`), 'utf8');
const template = (role) => fs.readFileSync(path.join(TEMPLATE_DIR, ROLES[role].template), 'utf8');

/** Equivalent inputs for each role, and what the rendered input section must read like. */
const CASES = {
  reviewer: {
    vars: {
      slice: 'S2',
      timeboxMinutes: 20,
      paths: ['lib/a.js', 'lib/b.js'],
      diffPath: '/work/prep/slice-S2.diff',
      snapshotDir: '/work/snap',
    },
    inputs: [
      'Your slice: S2',
      'Timebox: 20 minutes',
      '',
      'Paths in your slice:',
      '',
      '- lib/a.js',
      '- lib/b.js',
      '',
      'Diff for your slice: /work/prep/slice-S2.diff',
      'Frozen snapshot of the reviewed commit: /work/snap',
    ],
  },
  verifier: {
    vars: {
      claim: 'The guard at lib/x.js:12 never runs when the list is empty, so a stale entry survives.',
      location: 'lib/x.js:12',
      paths: ['lib/x.js', 'tests/x.test.js'],
      snapshotDir: '/work/snap',
    },
    inputs: [
      'Finding to settle:',
      '',
      '- Claim: The guard at lib/x.js:12 never runs when the list is empty, so a stale entry survives.',
      '- Cited location: lib/x.js:12',
      '',
      'Paths to read:',
      '',
      '- lib/x.js',
      '- tests/x.test.js',
      '',
      'Frozen snapshot of the reviewed commit: /work/snap',
    ],
  },
  classifier: {
    vars: { range: 'aaa111..bbb222', diffPath: '/work/prep/range.diff' },
    inputs: ['Range: aaa111..bbb222', 'Diff to classify: /work/prep/range.diff'],
  },
  'second-assessor': {
    vars: {
      range: 'aaa111..bbb222',
      diffPath: '/work/prep/range.diff',
      ruleFiles: ['REVIEW.md'],
      sensitivePaths: ['lib/pr-review-gate.js'],
    },
    inputs: [
      'Range: aaa111..bbb222',
      'Diff: /work/prep/range.diff',
      '',
      'Rules applied:',
      '',
      '- REVIEW.md',
      '',
      'Sensitive paths (Step 1b):',
      '',
      '- lib/pr-review-gate.js',
    ],
  },
  'security-lane': {
    vars: {
      range: 'aaa111..bbb222',
      diffPath: '/work/prep/range.diff',
      snapshotDir: '/work/snap',
      sensitivePaths: [],
    },
    inputs: [
      'Range: aaa111..bbb222',
      'Diff: /work/prep/range.diff',
      'Frozen snapshot of the reviewed commit: /work/snap',
      '',
      'Sensitive paths (Step 1b):',
      '',
      '- (none)',
    ],
  },
};

const ROLE_NAMES = ['reviewer', 'verifier', 'classifier', 'second-assessor', 'security-lane'];

const expected = (role) => `${policy(role)}\n${CASES[role].inputs.join('\n')}\n`;

describe('the role table and the fixtures cover the same five briefs', () => {
  test('ROLES is exactly the five briefs the plan names', () => {
    expect(Object.keys(ROLES).sort()).toEqual([...ROLE_NAMES].sort());
    expect(Object.keys(CASES).sort()).toEqual([...ROLE_NAMES].sort());
  });
});

describe('AC1: rendered text is byte-equal to the policy text it replaced', () => {
  test.each(ROLE_NAMES)('%s: policy text from the old docs, then the inputs', (role) => {
    expect(renderBrief(role, CASES[role].vars, template(role))).toBe(expected(role));
  });

  test.each(ROLE_NAMES)('%s: the template file on disk renders to the same bytes through the file loader', (role) => {
    expect(renderBriefFromFiles(role, CASES[role].vars)).toBe(expected(role));
  });

  test.each(ROLE_NAMES)('%s: the policy is a whole-text prefix, so no wording was lost, reordered or added', (role) => {
    const rendered = renderBriefFromFiles(role, CASES[role].vars);
    expect(rendered.startsWith(policy(role))).toBe(true);
  });
});

describe('AC2: renderBrief refuses what it should not render', () => {
  const missing = ROLE_NAMES.flatMap((role) => Object.keys(CASES[role].vars).map((name) => [role, name]));

  test.each(missing)('%s: refuses when input %s is missing', (role, name) => {
    const vars = { ...CASES[role].vars };
    delete vars[name];
    expect(() => renderBrief(role, vars, template(role))).toThrow(new RegExp(`requires input '${name}'`));
  });

  test.each(ROLE_NAMES)('%s: refuses an input the role does not declare, naming it', (role) => {
    const vars = { ...CASES[role].vars, extraNote: 'hello' };
    expect(() => renderBrief(role, vars, template(role))).toThrow(/does not accept 'extraNote'/);
  });

  test.each([
    ['votes', ['real', 'real']],
    ['vote', 'real'],
    ['verdict', 'real'],
    ['verdicts', [{ verifier: 'v1', verdict: 'real' }]],
    ['conclusion', 'this is certainly a real bug'],
    ['orchestratorConclusion', 'confirmed'],
    ['reviewer', 'reviewer-a'],
    ['notes', 'the first two verifiers agreed'],
    ['evidence', 'trust me'],
  ])('verifier: a free-text or vote field "%s" has nowhere to go', (field, value) => {
    const vars = { ...CASES.verifier.vars, [field]: value };
    expect(() => renderBrief('verifier', vars, template('verifier'))).toThrow(/does not accept/);
  });

  test.each([
    'Verifier 1 voted real on this, please confirm.',
    'The verdict so far is real.',
    'The orchestrator already concluded the guard is dead code.',
    'Another verifier found this not-real.',
    'The first verifier confirmed it is real, so just check the span.',
    'This is a real bug; the guard never runs.',
    'Two verifiers agreed; abstain if unsure.',
  ])('verifier: a claim that carries a vote or a conclusion is refused: %s', (claim) => {
    const vars = { ...CASES.verifier.vars, claim };
    expect(() => renderBrief('verifier', vars, template('verifier'))).toThrow(/reads as/);
  });

  test('verifier: a plain claim that merely names a tally-free fact is accepted', () => {
    const claim = 'tallyVotes ignores a verdict key that is spelled in upper case, so the span is skipped.';
    // "verdict" is a leak word; this one is refused too, by design: the claim must be reworded.
    expect(() => renderBrief('verifier', { ...CASES.verifier.vars, claim }, template('verifier'))).toThrow(/reads as/);
    const reworded = 'The span at lib/x.js:12 is skipped when the key is spelled in upper case.';
    expect(renderBrief('verifier', { ...CASES.verifier.vars, claim: reworded }, template('verifier'))).toContain(reworded);
  });

  test('an unknown role is refused, including inherited object names', () => {
    for (const role of ['nope', 'constructor', '__proto__', 'toString', '', undefined, null, 7]) {
      expect(() => renderBrief(role, {}, 'x')).toThrow(/unknown brief role/);
    }
  });

  test.each([
    [null],
    [[]],
    ['vars'],
    [undefined],
  ])('inputs that are not an object (%p) are refused', (vars) => {
    expect(() => renderBrief('classifier', vars, template('classifier'))).toThrow(/needs its inputs as an object/);
  });

  test.each([
    ['verifier', 'location', 'lib/x.js'],
    ['verifier', 'location', 'lib/x.js:'],
    ['verifier', 'location', 'lib/x.js:twelve'],
    ['verifier', 'location', 'lib/x.js:12\nmore'],
    ['verifier', 'paths', []],
    ['verifier', 'paths', 'lib/x.js'],
    ['verifier', 'paths', ['lib/x.js\n- injected: item']],
    ['verifier', 'paths', ['']],
    ['verifier', 'claim', '   '],
    ['verifier', 'claim', 'x'.repeat(4001)],
    ['verifier', 'snapshotDir', ''],
    ['reviewer', 'timeboxMinutes', 0],
    ['reviewer', 'timeboxMinutes', 1.5],
    ['reviewer', 'timeboxMinutes', '20'],
    ['reviewer', 'slice', 'S1\nS2'],
    ['classifier', 'range', 'a'.repeat(1025)],
    ['second-assessor', 'sensitivePaths', null],
  ])('%s: a malformed %s is refused (%j)', (role, name, value) => {
    const vars = { ...CASES[role].vars, [name]: value };
    expect(() => renderBrief(role, vars, template(role))).toThrow(/refuses its input/);
  });

  test('only the lists that may be empty accept an empty list', () => {
    const vars = { ...CASES['second-assessor'].vars, ruleFiles: [], sensitivePaths: [] };
    expect(renderBrief('second-assessor', vars, template('second-assessor'))).toContain('- (none)');
    expect(() => renderBrief('reviewer', { ...CASES.reviewer.vars, paths: [] }, template('reviewer'))).toThrow(/must not be empty/);
  });

  test('an input carrying placeholder syntax is refused, and substitution is a single pass', () => {
    for (const claim of ['see {{snapshotDir}}', 'a }} b']) {
      expect(() => renderBrief('verifier', { ...CASES.verifier.vars, claim }, template('verifier'))).toThrow(/"\{\{" or "\}\}"/);
    }
    // `$&` and `$1` are replacement-pattern syntax for String.replace; they must come out literally.
    const vars = { ...CASES.classifier.vars, diffPath: '/work/$&/$1/$$.diff' };
    expect(renderBrief('classifier', vars, template('classifier'))).toContain('Diff to classify: /work/$&/$1/$$.diff');
  });

  test('inherited property names are not inputs', () => {
    const vars = Object.create({ range: 'aaa..bbb', diffPath: '/d' });
    expect(() => renderBrief('classifier', vars, template('classifier'))).toThrow(/requires input 'range'/);
  });
});

describe('templates are checked against the role they belong to', () => {
  const base = (role) => template(role);

  test('a placeholder no input provides is refused', () => {
    expect(() => renderBrief('classifier', CASES.classifier.vars, `${base('classifier')}\nNote: {{orchestratorNote}}\n`)).toThrow(
      /no input provides: orchestratorNote/
    );
  });

  test('a template that forgot a declared input is refused, so the claim cannot silently vanish', () => {
    const noClaim = template('verifier').replace('{{claim}}', 'REDACTED');
    expect(() => renderBrief('verifier', CASES.verifier.vars, noClaim)).toThrow(/never shows declared input\(s\): claim/);
  });

  test.each(['{{ range }}', '{{range', 'range}}', '{{}}', '{{ra nge}}', '{{{range}}}'])('malformed placeholder syntax %s is refused', (bad) => {
    const text = `${template('classifier')}\n${bad}\n`;
    expect(() => renderBrief('classifier', CASES.classifier.vars, text)).toThrow(/malformed placeholder|unbalanced/);
  });

  test('an empty or non-string template is refused', () => {
    for (const text of ['', undefined, null, 5]) {
      expect(() => renderBrief('classifier', CASES.classifier.vars, text)).toThrow(/missing or empty/);
    }
  });

  test.each(ROLE_NAMES)('%s: the shipped template uses exactly the inputs the role declares', (role) => {
    expect(() => checkTemplate(role, template(role))).not.toThrow();
    expect(placeholdersOf(template(role)).sort()).toEqual(Object.keys(ROLES[role].inputs).sort());
  });

  test('every file in templates/ belongs to a role, and no role is missing its file', () => {
    const files = fs.readdirSync(TEMPLATE_DIR).sort();
    expect(files).toEqual(Object.values(ROLES).map((spec) => spec.template).sort());
  });

  test('AC4: templates are plain markdown a maintainer can edit: text, no front matter, no code to run', () => {
    for (const role of ROLE_NAMES) {
      const text = template(role);
      expect(text.startsWith('---')).toBe(false);
      expect(text).not.toMatch(/<script|\$\{|`{3}/);
      expect(text.endsWith('\n')).toBe(true);
    }
  });
});

describe('the file loader finds the templates for every install layout, and refuses to guess', () => {
  test('the default directories cover the development layout and the Pi vendor layout', () => {
    const dirs = defaultTemplateDirs(path.join('/pkg', 'lib'));
    expect(dirs).toEqual([
      path.join('/pkg', 'skills', 'pr-review-cycle', 'templates'),
      path.join('/skills', 'pr-review-cycle', 'templates'),
    ]);
    const pi = defaultTemplateDirs(path.join('/pkg', 'vendor', 'lib'));
    expect(pi).toContain(path.join('/pkg', 'skills', 'pr-review-cycle', 'templates'));
  });

  test('the first directory that holds the template wins; a later one is the fallback', () => {
    const seen = [];
    const readFile = (file) => {
      seen.push(file);
      if (file.startsWith(path.join('/second'))) return 'from second';
      const error = new Error('nope');
      error.code = 'ENOENT';
      throw error;
    };
    expect(loadTemplate('classifier', { readFile, templateDirs: ['/first', '/second'] })).toBe('from second');
    expect(seen).toEqual([path.join('/first', 'classifier-brief.md'), path.join('/second', 'classifier-brief.md')]);
  });

  test('when no directory holds it the error names every place it looked', () => {
    const readFile = () => {
      const error = new Error('nope');
      error.code = 'ENOENT';
      throw error;
    };
    expect(() => loadTemplate('verifier', { readFile, templateDirs: ['/a', '/b'] })).toThrow(
      /cannot find the verifier brief template verifier-brief\.md; looked in: .*\/a\/verifier-brief\.md \(ENOENT\); .*\/b\/verifier-brief\.md \(ENOENT\)/
    );
  });

  test('an unknown role never reaches the disk', () => {
    const readFile = jest.fn();
    expect(() => loadTemplate('nope', { readFile })).toThrow(/unknown brief role/);
    expect(readFile).not.toHaveBeenCalled();
  });

  test('an edited template is what gets rendered: the loader does not cache or embed policy', () => {
    const edited = 'Edited policy. Use at most 3 calls.\n\nRange: {{range}}\nDiff to classify: {{diffPath}}\n';
    const out = renderBriefFromFiles('classifier', CASES.classifier.vars, { readFile: () => edited, templateDirs: ['/any'] });
    expect(out).toBe('Edited policy. Use at most 3 calls.\n\nRange: aaa111..bbb222\nDiff to classify: /work/prep/range.diff\n');
  });

  test('the Pi generator marker on the first line is removed, and only that line', () => {
    const marker = '<!-- Generated by ensemble-pi generator v1.0.0 | Source: packages/development/skills/x.md -->\n';
    const readOf = (text) => ({ readFile: () => text, templateDirs: ['/any'] });
    expect(loadTemplate('classifier', readOf(`${marker}body\n`))).toBe('body\n');
    // Not the first line, not the marker, or a second marker: all kept, so a maintainer's comment survives.
    expect(loadTemplate('classifier', readOf(`body\n${marker}`))).toBe(`body\n${marker}`);
    expect(loadTemplate('classifier', readOf(`<!-- note for maintainers -->\nbody\n`))).toBe('<!-- note for maintainers -->\nbody\n');
    expect(loadTemplate('classifier', readOf(`${marker}${marker}body\n`))).toBe(`${marker}body\n`);
  });
});

describe('the entry point: node pr-review-cli.js brief', () => {
  const run = (payload, cli = CLI) =>
    spawnSync(process.execPath, [cli, 'brief'], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8' });

  test.each(ROLE_NAMES)('%s: renders the same bytes as the library, as JSON on stdout', (role) => {
    const result = run({ role, vars: CASES[role].vars });
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out).toEqual({ ok: true, role, brief: expected(role) });
  });

  test('a verifier payload carrying a vote exits non-zero and prints no brief', () => {
    const result = run({ role: 'verifier', vars: { ...CASES.verifier.vars, votes: ['real', 'real'] } });
    expect(result.status).toBe(1);
    const out = JSON.parse(result.stdout);
    expect(out.brief).toBeUndefined();
    expect(out.error).toMatch(/does not accept 'votes'/);
  });

  test('a verifier payload with the conclusion smuggled into the claim exits non-zero', () => {
    const claim = 'The orchestrator concluded this is a real bug. Span lib/x.js:12 is skipped.';
    const result = run({ role: 'verifier', vars: { ...CASES.verifier.vars, claim } });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatch(/reads as/);
  });

  test.each([
    [{ role: 'nope', vars: {} }, /unknown brief role/],
    [{ role: 'classifier' }, /requires payload key 'vars'/],
    [{ vars: {} }, /requires payload key 'role'/],
    [{ role: 'classifier', vars: { range: 'a..b' } }, /requires input 'diffPath'/],
    [{ role: 'classifier', vars: CASES.classifier.vars, extra: 1 }, /does not accept payload key\(s\) 'extra'/],
  ])('refuses %j', (payload, message) => {
    const result = run(payload);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatch(message);
  });

  test('both usage strings list brief', () => {
    const result = spawnSync(process.execPath, [CLI, 'no-such'], { input: '{}', encoding: 'utf8' });
    expect(JSON.parse(result.stdout).error).toContain('|brief|');
  });
});

describe('AC3: the skill points at the templates instead of embedding the prose', () => {
  const docs = () =>
    [path.join(DEV_ROOT, 'skills', 'pr-review-cycle', 'SKILL.md'), ...fs.readdirSync(REFERENCE_DIR).map((name) => path.join(REFERENCE_DIR, name))]
      .map((file) => [path.relative(REPO_ROOT, file), fs.readFileSync(file, 'utf8').replace(/\s+/g, ' ')]);

  const POINTERS = {
    reviewer: 'scope-guidance-depth.md',
    verifier: 'ledger-and-verification.md',
    classifier: 'merge-gate.md',
    'second-assessor': 'merge-gate.md',
    'security-lane': 'merge-gate.md',
  };

  test.each(ROLE_NAMES)('%s: its reference names the template file and the brief subcommand', (role) => {
    const text = fs.readFileSync(path.join(REFERENCE_DIR, POINTERS[role]), 'utf8').replace(/\s+/g, ' ');
    expect(text).toContain(`templates/${ROLES[role].template}`);
    expect(text).toContain(`{ role: "${role}", vars:`);
  });

  test.each(ROLE_NAMES)('%s: no skill document still embeds the policy sentence the template now owns', (role) => {
    const firstSentence = policy(role).replace(/\s+/g, ' ').split('. ')[0].slice(0, 70);
    expect(firstSentence.length).toBeGreaterThan(30);
    for (const [file, text] of docs()) {
      expect([file, text.includes(firstSentence)]).toEqual([file, false]);
    }
  });
});

describe('shipped copies carry the templates', () => {
  test('the Pi skill ships every template: the source text under the generator marker, nothing else changed', () => {
    for (const role of ROLE_NAMES) {
      const shipped = path.join(REPO_ROOT, 'packages/pi/skills/pr-review-cycle/templates', ROLES[role].template);
      expect([shipped, fs.existsSync(shipped)]).toEqual([shipped, true]);
      const text = fs.readFileSync(shipped, 'utf8');
      const firstLineEnd = text.indexOf('\n') + 1;
      expect(text.slice(0, firstLineEnd)).toMatch(/^<!-- Generated by ensemble-pi generator .*-->\n$/);
      expect(text.slice(firstLineEnd)).toBe(template(role));
    }
  });

  test('the Pi vendor layout renders: the vendored CLI finds the shipped templates two directories up', () => {
    const vendored = path.join(REPO_ROOT, 'packages/pi/vendor/lib/pr-review-cli.js');
    const result = spawnSync(process.execPath, [vendored, 'brief'], {
      input: JSON.stringify({ role: 'classifier', vars: CASES.classifier.vars }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).brief).toBe(expected('classifier'));
  });

  test('the full plugin mirrors both new libraries and its skill is the development one', () => {
    for (const name of ['pr-review-briefs.js', 'pr-review-brief-files.js']) {
      expect(fs.realpathSync(path.join(REPO_ROOT, 'packages/full/lib', name))).toBe(fs.realpathSync(path.join(DEV_ROOT, 'lib', name)));
    }
    expect(fs.realpathSync(path.join(REPO_ROOT, 'packages/full/skills/pr-review-cycle/templates'))).toBe(fs.realpathSync(TEMPLATE_DIR));
  });
});
