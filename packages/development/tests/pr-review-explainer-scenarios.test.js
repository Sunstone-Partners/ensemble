'use strict';

/**
 * TRD-036-TEST: Explainers on request (PRD scenarios).
 *
 * Validates PRD ACs: AC-022-1, AC-022-2 (REQ-022).
 *
 * The structural contract of the skill file is TRD-036's own test
 * (pr-review-explainer-skill.test.js). These are the PRD-LEVEL scenarios,
 * read the way a maintainer experiences them:
 *
 *   - AC-022-1: a maintainer asks for an explainer for a named module; what
 *     comes back reflects the code AS IT IS NOW and arrives in minutes.
 *   - AC-022-2: the explainer names the files it was derived from.
 *
 * A skill is prose, so the parts a test can execute are executed: the Step 1
 * resolution rules are replayed over a REAL temp repository (current file,
 * renamed file, generated mirror, escaping path, missing module) by a
 * resolver written here straight from the skill text, and the Step 4
 * `Derived from:` contract is checked against a produced explainer that uses
 * the skill's own template. The cases that MUST be refused -- a stale
 * explainer, an explainer derived from a mirror, one with a file it never
 * read, and a module with no readable source -- are each exercised, so no
 * scenario passes only in the direction that says yes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILL_PATH = path.join(__dirname, '..', 'skills', 'pr-review-explainer', 'SKILL.md');
const SKILL = fs.readFileSync(SKILL_PATH, 'utf8');
const FLAT = SKILL.replace(/\s+/g, ' ');

/** Paths the skill refuses as a source: generated or vendored copies. */
const MIRROR_PATTERNS = [/(^|\/)packages\/pi\/skills\//, /(^|\/)packages\/full\//, /(^|\/)dist\//, /(^|\/)node_modules\//];

const isMirror = (rel) => MIRROR_PATTERNS.some((pattern) => pattern.test(rel));

/**
 * Step 1 of the skill, replayed: resolve `module` to readable files inside
 * `root` only. Returns repo-relative paths, or [] when nothing resolves --
 * which is Step 2's EXPLAINER_UNAVAILABLE case.
 */
function resolveModule(root, module) {
  if (typeof module !== 'string' || module.trim() === '') return [];
  const walk = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else out.push(path.relative(root, full));
    }
    return out;
  };
  const all = walk(root).filter((rel) => !isMirror(rel));

  // Rule: a path that escapes REPO_ROOT resolves to nothing.
  const asPath = path.resolve(root, module);
  if (!asPath.startsWith(path.resolve(root) + path.sep) && asPath !== path.resolve(root)) return [];

  // 1. an existing file.
  const rel = path.relative(root, asPath);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) return isMirror(rel) ? mirrorOrigin(all, rel) : [rel];

  // 2. an existing directory: the source files directly in it.
  if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) {
    const direct = fs
      .readdirSync(asPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(rel, entry.name))
      .filter((candidate) => !isMirror(candidate));
    return direct;
  }

  // 3. basename match.
  const byBase = all.filter((candidate) => path.basename(candidate, path.extname(candidate)) === module);
  if (byBase.length > 0) return byBase;

  // 4. word match on file names.
  const words = module.toLowerCase().split(/\s+/);
  return all.filter((candidate) => words.every((word) => candidate.toLowerCase().includes(word)));
}

/** "If only a mirror matched, resolve to the file it mirrors." */
function mirrorOrigin(all, mirrorRel) {
  const base = path.basename(mirrorRel);
  return all.filter((candidate) => path.basename(candidate) === base);
}

/** Step 4's template, filled from files actually read: the only way to get a truthful Derived from list. */
function writeExplainer(root, files, revision) {
  const read = files.map((rel) => ({ rel, text: fs.readFileSync(path.join(root, rel), 'utf8') }));
  const entryPoints = read
    .flatMap(({ text }) => [...text.matchAll(/^function (\w+)/gm)].map((match) => match[1]))
    .sort();
  return [
    `# ${path.basename(files[0])}`,
    '',
    `**What it is for** — ${entryPoints.length} exported entry point(s) read from source.`,
    '',
    `**Entry points** — ${entryPoints.join(', ') || 'none found'}`,
    '',
    'Derived from:',
    ...read.map(({ rel }) => `- ${rel} (${revision})`),
  ].join('\n');
}

const derivedFrom = (explainer) =>
  explainer
    .slice(explainer.indexOf('Derived from:'))
    .split('\n')
    .slice(1)
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).replace(/\s+\(.*\)$/, ''));

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-explainer-scenarios-'));
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'pi', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'vote-tally.js'), 'function tallyVotes() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'lib', 'helper.js'), 'function helperFn() { return 2; }\n');
  // A generated mirror of the same module: never the source of an explainer.
  fs.writeFileSync(path.join(root, 'packages', 'pi', 'skills', 'vote-tally.js'), 'function tallyVotesSTALE() {}\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Scenario AC-022-1: a maintainer asks for an explainer for a named module and gets one from the code as it is now', () => {
  test('the named module resolves to its current source, and the explainer repeats what that source says today', () => {
    const files = resolveModule(root, 'vote-tally');
    expect(files).toEqual(['lib/vote-tally.js']);

    const explainer = writeExplainer(root, files, 'abc1234');
    expect(explainer).toContain('tallyVotes');
    expect(explainer).not.toContain('tallyVotesSTALE');
  });

  test('the case that must be refused: an explainer written before the code changed no longer matches the code now', () => {
    const before = writeExplainer(root, resolveModule(root, 'vote-tally'), 'abc1234');
    expect(before).toContain('tallyVotes');

    // The maintainer renames the entry point. An explainer "reflecting the
    // code as it is now" must change with it; the stale one does not.
    fs.writeFileSync(path.join(root, 'lib', 'vote-tally.js'), 'function countBallots() { return 1; }\n');
    const after = writeExplainer(root, resolveModule(root, 'vote-tally'), 'def5678');

    expect(after).toContain('countBallots');
    expect(after).not.toEqual(before);
    // And the stale text would be wrong about today's code, which is exactly
    // why the skill forbids a cached summary.
    expect(before).not.toContain('countBallots');
  });

  test('the second case that must be refused: a generated mirror is never the source; it resolves to the file it mirrors', () => {
    const viaMirror = resolveModule(root, 'packages/pi/skills/vote-tally.js');
    expect(viaMirror).toEqual(['lib/vote-tally.js']);

    const explainer = writeExplainer(root, viaMirror, 'abc1234');
    expect(derivedFrom(explainer)).toEqual(['lib/vote-tally.js']);
    expect(derivedFrom(explainer).some(isMirror)).toBe(false);
  });

  test('a module with no readable source produces no explainer at all', () => {
    expect(resolveModule(root, 'no-such-module')).toEqual([]);
    // Escaping the repository root resolves to nothing too: untrusted text
    // names the module, it never selects the file.
    expect(resolveModule(root, '../../etc/passwd')).toEqual([]);

    const stop = SKILL.slice(SKILL.indexOf('## Step 2 --'), SKILL.indexOf('## Step 3 --'));
    expect(stop).toContain('EXPLAINER_UNAVAILABLE');
    expect(stop).toContain('No explainer was produced.');
  });

  test('delivered within minutes: the answer is a fixed short structure over only the resolved files, and the offer costs nothing until accepted', () => {
    // Bounded work: one small template, and reads limited to what resolved.
    const explainer = writeExplainer(root, resolveModule(root, 'vote-tally'), 'abc1234');
    expect(explainer.split('\n').length).toBeLessThan(40);
    expect(FLAT).toContain('Keep it short enough to be produced and read in minutes');
    expect(FLAT).toContain('With `REQUESTED = false` this skill produces nothing');
    expect(FLAT).toContain('no file reads');
  });
});

describe('Scenario AC-022-2: the explainer names the files it was derived from', () => {
  test('every file read is listed, with the revision that makes "as it is now" checkable', () => {
    const files = resolveModule(root, 'lib');
    expect(files.sort()).toEqual(['lib/helper.js', 'lib/vote-tally.js']);

    const explainer = writeExplainer(root, files.sort(), 'abc1234-dirty');
    expect(derivedFrom(explainer).sort()).toEqual(['lib/helper.js', 'lib/vote-tally.js']);
    expect(explainer).toMatch(/- lib\/helper\.js \(abc1234-dirty\)/);
  });

  test('the case that must be refused: a Derived from list naming a file that was not read is wrong, even when the prose is right', () => {
    const files = resolveModule(root, 'vote-tally');
    const honest = writeExplainer(root, files, 'abc1234');
    const padded = honest.replace('Derived from:\n', 'Derived from:\n- lib/helper.js (abc1234)\n');

    const listed = derivedFrom(padded);
    const read = files;
    expect(listed).not.toEqual(read);
    expect(listed.filter((file) => !read.includes(file))).toEqual(['lib/helper.js']);

    // The skill states exactly this rule, so the refusal is policy, not taste.
    expect(FLAT).toContain('`Derived from:` lists every file read and nothing else');
    expect(FLAT).toContain('A file listed but not read, or read but not listed, makes the explainer wrong');
  });

  test('the unavailable outcome carries no explainer text, so an empty Derived from list can never ship', () => {
    const outputs = SKILL.slice(SKILL.indexOf('## Outputs'), SKILL.indexOf('## Step 1'));
    expect(outputs).toContain('**no explainer text**');
    expect(outputs.replace(/\s+/g, ' ')).toContain('Never both');
    expect(FLAT).toContain('never an explainer with an empty or guessed `Derived from:` list');
  });
});
