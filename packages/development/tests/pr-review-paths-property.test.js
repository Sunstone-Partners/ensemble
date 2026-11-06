'use strict';

/**
 * Seeded property/fuzz harness for the approval-gate glob and path matcher
 * (`packages/development/lib/pr-review-paths.js`), kata g1r4, plan 3F.
 *
 * The example-based suites (`pr-review-paths*.test.js`) pin the cases someone
 * thought of. A matcher that decides "does this PR touch a sensitive path" is
 * exactly the code where the case nobody thought of is the finding, and three
 * LLM review rounds found them one at a time (Kelvin sign, long s, ligatures,
 * U+2028 in a name). This file generates the cases instead and compares the
 * production matcher with an INDEPENDENT oracle:
 *
 *   - The oracle shares no code with the production module: no regex is built
 *     from a pattern, it matches by dynamic programming over arrays of
 *     case-folded units, and its fold is an explicit alias table, not
 *     `toLowerCase` or the `i`/`u` regex flags the production code leans on.
 *   - The fold table is the ground truth of what a case-insensitive file system
 *     does, not of what a JS regex does: on APFS, `U+212A` names `k`, `U+017F`
 *     names `s`, and the FULL fold also maps `U+00DF`, `U+1E9E` to `ss` and
 *     `U+FB00`..`U+FB06` to `ff`, `fi`, `fl`, `ffi`, `ffl`, `st`. (Checked by
 *     creating `fl` and `ss` on APFS and opening them as `\uFB02` and `\u00DF`.)
 *     The `iu` regex flag folds only the one-to-one aliases, so `work\uFB02ows`
 *     would escape `.github/workflows/**` on such a checkout.
 *
 * Reproducibility: the cases are a pure function of the seed. The default seed
 * is fixed, so CI is deterministic; `PR_REVIEW_FUZZ_SEED=<int>` explores another
 * run, and every failure prints the seed and the case index to replay it.
 *
 * NOT modelled (so not claimed): Unicode normalization (APFS is also
 * normalization-insensitive), astral code points, and bracket classes -- the
 * matcher has none and the generator never emits a backslash escape.
 */

const {
  matchesPattern,
  classifyPaths,
  DEFAULT_SENSITIVE_PATHS,
  DEFAULT_DECLARATION_PATHS,
} = require('../lib/pr-review-paths');

const DEFAULT_SEED = 0x5eed1234;
const SEED = process.env.PR_REVIEW_FUZZ_SEED !== undefined
  ? Number.parseInt(process.env.PR_REVIEW_FUZZ_SEED, 10) >>> 0
  : DEFAULT_SEED;
const REPLAY = (seed) =>
  `PR_REVIEW_FUZZ_SEED=${seed} PR_REVIEW_FUZZ_CASES=${CASES} npx jest tests/pr-review-paths-property.test.js`;

const CASES = process.env.PR_REVIEW_FUZZ_CASES !== undefined ? Number.parseInt(process.env.PR_REVIEW_FUZZ_CASES, 10) : 60000;
const BASE = 'b'.repeat(40);

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32): the only source of randomness in this file.
// ---------------------------------------------------------------------------
function makeRng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  const pick = (list) => list[int(list.length)];
  const chance = (p) => next() < p;
  return { next, int, pick, chance };
}

// ---------------------------------------------------------------------------
// The oracle.
// ---------------------------------------------------------------------------

/** What a case-insensitive file system treats as another spelling of a letter. */
const FOLD = Object.freeze({
  '\u212A': 'k', // KELVIN SIGN
  '\u017F': 's', // LATIN SMALL LETTER LONG S
  '\u00DF': 'ss', // SHARP S
  '\u1E9E': 'ss', // CAPITAL SHARP S
  '\uFB00': 'ff',
  '\uFB01': 'fi',
  '\uFB02': 'fl',
  '\uFB03': 'ffi',
  '\uFB04': 'ffl',
  '\uFB05': 'st',
  '\uFB06': 'st',
  '\u2126': '\u03C9', // OHM SIGN
  '\u212B': '\u00E5', // ANGSTROM SIGN
  '\u00C5': '\u00E5',
  '\u00C9': '\u00E9',
  '\u00DC': '\u00FC',
  '\u00C4': '\u00E4',
  '\u03A9': '\u03C9',
  '\u03A3': '\u03C3',
  '\u03C2': '\u03C3',
});

/** A string as an array of comparable units; folded units when `fold` is set. */
function units(text, fold) {
  const out = [];
  for (const ch of text) {
    if (!fold) {
      out.push(ch);
    } else if (FOLD[ch] !== undefined) {
      out.push(...FOLD[ch]);
    } else if (ch >= 'A' && ch <= 'Z') {
      out.push(String.fromCharCode(ch.charCodeAt(0) + 32));
    } else {
      out.push(ch);
    }
  }
  return out;
}

/** `./a`, `/a` and `a/` all name `a`; `\` is a separator. No other change: a name is not trimmed. */
function oracleNormalize(raw, trim) {
  let text = raw.split('\\').join('/');
  if (trim) text = text.trim();
  let start = 0;
  while (text.startsWith('./', start)) start += 2;
  while (text[start] === '/') start += 1;
  let end = text.length;
  while (end > start && text[end - 1] === '/') end -= 1;
  return text.slice(start, end);
}

function tokenize(body, fold) {
  const tokens = [];
  const chars = [...body];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === '*' && chars[i + 1] === '*') {
      i += 1;
      if (chars[i + 1] === '/') {
        i += 1;
        tokens.push({ kind: 'dirs' }); // `**/`: zero or more WHOLE directories
      } else {
        tokens.push({ kind: 'any' }); // `**`: anything, `/` included
      }
    } else if (ch === '*') {
      tokens.push({ kind: 'run' }); // `*`: anything but `/`
    } else if (ch === '?') {
      tokens.push({ kind: 'one' }); // `?`: one unit but `/`
    } else {
      for (const unit of units(ch, fold)) tokens.push({ kind: 'lit', unit });
    }
  }
  return tokens;
}

function globMatch(tokens, text) {
  const memo = new Map();
  const walk = (ti, ui) => {
    const key = ti * 100003 + ui;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (ti === tokens.length) {
      result = ui === text.length;
    } else {
      const token = tokens[ti];
      switch (token.kind) {
        case 'lit':
          result = ui < text.length && text[ui] === token.unit && walk(ti + 1, ui + 1);
          break;
        case 'one':
          result = ui < text.length && text[ui] !== '/' && walk(ti + 1, ui + 1);
          break;
        case 'run': {
          result = false;
          for (let j = ui; ; j += 1) {
            if (walk(ti + 1, j)) { result = true; break; }
            if (j >= text.length || text[j] === '/') break;
          }
          break;
        }
        case 'any': {
          result = false;
          for (let j = ui; j <= text.length; j += 1) {
            if (walk(ti + 1, j)) { result = true; break; }
          }
          break;
        }
        default: { // 'dirs'
          result = walk(ti + 1, ui);
          for (let j = ui + 1; !result && j <= text.length; j += 1) {
            if (text[j - 1] === '/' && walk(ti + 1, j)) result = true;
          }
        }
      }
    }
    memo.set(key, result);
    return result;
  };
  return walk(0, 0);
}

/**
 * The documented semantics of `matchesPattern`, written from the header comment, not from the implementation, for
 * ONE spelling of the name: `trim` drops surrounding whitespace, as a Windows checkout does.
 */
function oracleMatchesSpelling(pattern, rawPath, ignoreCase, trim) {
  let spelled = pattern.split('\\').join('/');
  const anchored = spelled.startsWith('/');
  if (anchored) spelled = spelled.slice(1);
  const directoryOnly = spelled.endsWith('/');
  let end = spelled.length;
  while (end > 0 && spelled[end - 1] === '/') end -= 1;
  const body = spelled.slice(0, end);
  if (body === '') return false;

  const bareName = !anchored && !body.includes('/');
  const subtree = directoryOnly || !/[*?]/.test(body);
  const fold = ignoreCase && !bareName;

  const path = oracleNormalize(rawPath, trim);
  if (path === '') return false;
  const segments = path.split('/');

  const named = [];
  if (!directoryOnly) named.push(segments);
  if (subtree) for (let i = 1; i < segments.length; i += 1) named.push(segments.slice(0, i));

  const tokens = tokenize(body, fold);
  return named.some((thing) => {
    const target = bareName ? thing[thing.length - 1] : thing.join('/');
    return globMatch(tokens, units(target, fold));
  });
}

/** A path matches when the name matches as git printed it OR with its surrounding whitespace dropped (more review, never less). */
function oracleMatches(pattern, rawPath, ignoreCase) {
  return oracleMatchesSpelling(pattern, rawPath, ignoreCase, false) || oracleMatchesSpelling(pattern, rawPath, ignoreCase, true);
}

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

const ATOMS = [
  '.github', 'workflows', 'actions', '.circleci', 'scripts', 'generate-codex', 'generate-x', 'validate-all.js',
  'publish-npm.sh', 'release-notes', 'install-hook', 'install.sh', 'install.ps1', 'Jenkinsfile', 'constitution.md',
  'CONSTITUTION.md', 'REVIEW.md', 'CODEOWNERS', 'packages', 'development', 'lib', 'pr-review-paths.js', 'skills',
  'pr-review-cycle', 'SKILL.md', 'docs', 'src', 'auth', 'a', 'b', 'c.yml', 'ci.yml', 'index.js', 'azure-pipelines.yml',
  '.gitlab-ci.yml', 'test', 'dist',
];
// Characters a name may hold that a glob engine must not trip over. No `*`/`?` (a pattern cannot spell them
// literally) and no `/` or `\` (separators).
const JUNK = [
  'a', 'b', 'k', 'K', 's', 'S', 'f', 'l', 'i', 't', 'x', 'z', '.', '-', '_', ' ', '0',
  '\n', '\r', '\u2028', '\u2029', '\0', '\u00A0', '\u00E9', '\u00C9', '\u65E5',
];
const ALIASES = [
  ['k', '\u212A'], ['s', '\u017F'], ['ss', '\u00DF'], ['ss', '\u1E9E'], ['ff', '\uFB00'], ['fi', '\uFB01'],
  ['fl', '\uFB02'], ['ffi', '\uFB03'], ['ffl', '\uFB04'], ['st', '\uFB05'], ['st', '\uFB06'],
];

function flipCase(rng, text) {
  let out = '';
  for (const ch of text) {
    const swapped = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
    out += rng.chance(0.3) && swapped.length === 1 ? swapped : ch;
  }
  return out;
}

/** Re-spells a name the way another case, or a Unicode alias, would. */
function respell(rng, text) {
  let out = flipCase(rng, text);
  for (const [plain, alias] of ALIASES) {
    let at = out.toLowerCase().indexOf(plain);
    while (at !== -1) {
      if (rng.chance(0.5)) {
        out = out.slice(0, at) + alias + out.slice(at + plain.length);
        at = out.toLowerCase().indexOf(plain, at + 1);
      } else {
        at = out.toLowerCase().indexOf(plain, at + plain.length);
      }
    }
  }
  return out;
}

function junkSegment(rng) {
  let out = '';
  const length = 1 + rng.int(5);
  for (let i = 0; i < length; i += 1) out += rng.pick(JUNK);
  return out;
}

function segmentList(rng) {
  const length = 1 + rng.int(5);
  const list = [];
  for (let i = 0; i < length; i += 1) list.push(rng.chance(0.75) ? rng.pick(ATOMS) : junkSegment(rng));
  return list;
}

/** A changed path as git can print it, including the spellings a checkout can alias. */
function makePath(rng, segments) {
  const spelled = segments.map((segment) => (rng.chance(0.45) ? respell(rng, segment) : segment));
  let text = spelled[0];
  for (let i = 1; i < spelled.length; i += 1) text += (rng.chance(0.04) ? '\\' : '/') + spelled[i];
  if (rng.chance(0.15)) text = rng.pick(['./', '/', '././']) + text;
  if (rng.chance(0.05)) text += '/';
  if (rng.chance(0.04)) text = rng.pick([' ', '\n', '\u2028', '\u00A0']) + text;
  if (rng.chance(0.04)) text += rng.pick([' ', '\n', '\u2028', '\u00A0']);
  return text;
}

/** A glob read off a path: some segments kept, some wildcarded, the rest cut off. */
function deriveGlob(rng, segments) {
  const keep = 1 + rng.int(segments.length);
  const parts = segments.slice(0, keep).map((segment) => {
    const roll = rng.next();
    if (roll < 0.5) return rng.chance(0.3) ? respell(rng, segment) : segment;
    if (roll < 0.62) return '*';
    if (roll < 0.74) { // wildcard one character or a span of the name
      const at = rng.int(segment.length);
      return `${segment.slice(0, at)}?${segment.slice(at + 1)}`;
    }
    if (roll < 0.88) {
      const at = rng.int(segment.length + 1);
      return `${segment.slice(0, at)}*${segment.slice(at + rng.int(3))}`;
    }
    return segment.length > 1 ? `*${segment.slice(1 + rng.int(segment.length - 1))}` : '*';
  });
  if (parts.length > 1 && rng.chance(0.25)) parts[rng.int(parts.length - 1)] = '**';
  if (keep < segments.length && rng.chance(0.3)) parts[parts.length - 1] = '**';
  if (rng.chance(0.1)) parts.unshift('**');
  let glob = parts.join('/');
  if (rng.chance(0.2)) glob = `/${glob}`;
  if (rng.chance(0.25) && !glob.endsWith('**')) glob += '/';
  return glob;
}

function randomGlob(rng) {
  const length = 1 + rng.int(4);
  const parts = [];
  for (let i = 0; i < length; i += 1) {
    const roll = rng.next();
    if (roll < 0.15) parts.push('*');
    else if (roll < 0.22) parts.push('**');
    else if (roll < 0.35) parts.push(`${rng.pick(ATOMS).slice(0, 3)}*`);
    else if (roll < 0.45) parts.push(`*${rng.pick(['.js', '.yml', '.md', '-all.js', 'ws'])}`);
    else if (roll < 0.55) parts.push(`${rng.pick(['a', 'b', 'x'])}?`);
    else parts.push(rng.chance(0.3) ? respell(rng, rng.pick(ATOMS)) : rng.pick(ATOMS));
  }
  let glob = parts.join('/');
  if (rng.chance(0.15)) glob = `/${glob}`;
  if (rng.chance(0.2) && !glob.endsWith('**')) glob += '/';
  return glob;
}

/** A pattern is read after `trim()`: keep generated edges free of whitespace, which no real pattern carries. */
function trimEdges(glob) {
  return glob.replace(/^\s/, 'x').replace(/\s$/, 'x');
}

function* generateCases(seed, count) {
  const rng = makeRng(seed);
  for (let index = 0; index < count; index += 1) {
    const segments = segmentList(rng);
    const path = makePath(rng, segments);
    const pattern = trimEdges(rng.chance(0.7) ? deriveGlob(rng, segments) : randomGlob(rng));
    yield { index, pattern, path, ignoreCase: rng.chance(0.6) };
  }
}

// ---------------------------------------------------------------------------
// Properties.
// ---------------------------------------------------------------------------

function fail(title, mismatches, extra = '') {
  if (mismatches.length === 0) return;
  const shown = mismatches.slice(0, 8).map((m) => JSON.stringify(m)).join('\n');
  throw new Error(
    `${title}: ${mismatches.length} mismatch(es). seed=${SEED}; replay with ${REPLAY(SEED)}${extra}\n${shown}`
  );
}

describe('pr-review-paths property harness: the cases are a function of the seed', () => {
  test('the same seed generates the same cases, another seed generates others', () => {
    const run = (seed) => [...generateCases(seed, 500)];
    expect(run(SEED)).toEqual(run(SEED));
    expect(run(SEED)).not.toEqual(run(SEED + 1));
  });

  test('the generator reaches the forms the matcher must survive', () => {
    const cases = [...generateCases(SEED, CASES)];
    const seen = (test) => cases.some(test);
    expect(seen((c) => c.path.includes('\u212A') || c.path.includes('\u017F'))).toBe(true);
    expect(seen((c) => /[\u00DF\u1E9E\uFB00-\uFB06]/.test(c.path))).toBe(true);
    expect(seen((c) => /[\n\r\u2028\u2029]/.test(c.path))).toBe(true);
    expect(seen((c) => c.path.includes('\0'))).toBe(true);
    expect(seen((c) => /^\s|\s$/.test(c.path))).toBe(true);
    expect(seen((c) => c.pattern.includes('**/'))).toBe(true);
    expect(seen((c) => c.pattern.endsWith('/'))).toBe(true);
    expect(seen((c) => oracleMatches(c.pattern, c.path, c.ignoreCase))).toBe(true);
    expect(seen((c) => !oracleMatches(c.pattern, c.path, c.ignoreCase))).toBe(true);
    // A healthy share of cases must be positives, or agreement on "no" proves little.
    const positives = cases.filter((c) => oracleMatches(c.pattern, c.path, c.ignoreCase)).length;
    expect(positives / cases.length).toBeGreaterThan(0.15);
  });
});

describe('pr-review-paths property harness: the oracle itself', () => {
  // The oracle is only worth anything if it can tell the answers apart.
  test.each([
    ['a/**/b', 'a/b', false, true],
    ['a/**/b', 'a/x/y/b', false, true],
    ['a/**/b', 'a/xb', false, false],
    ['**/foo', 'barfoo', false, false],
    ['**/foo', 'x/foo', false, true],
    ['src/*', 'src/a/b.js', false, false],
    ['src/auth', 'src/auth/a.js', false, true],
    ['docs/', 'docs', false, false],
    ['.github/workflows/**', '.github/workflows/a\nb.yml', false, true],
    ['scripts/ci-local.js', '\u017Fcripts/ci-local.js', true, true],
    ['scripts/ci-local.js', '\u017Fcripts/ci-local.js', false, false],
    ['.github/workflows/**', '.github/work\uFB02ows/ci.yml', true, true],
    ['packages/**/pr-review-*', 'packages/a/pr-revie\u017F', true, false],
    ['a/ss/b', 'a/\u00DF/b', true, true],
    ['a/?/b', 'a/\u00DF/b', true, false],
    ['REVIEW.md', 'docs/review.md', true, false],
  ])('%j vs %j (ignoreCase %s) -> %s', (pattern, path, ignoreCase, expected) => {
    expect(oracleMatches(pattern, path, ignoreCase)).toBe(expected);
  });
});

describe('pr-review-paths property harness: matchesPattern agrees with the oracle', () => {
  test(`${CASES} generated (pattern, path) pairs`, () => {
    const mismatches = [];
    for (const c of generateCases(SEED, CASES)) {
      const expected = oracleMatches(c.pattern, c.path, c.ignoreCase);
      const actual = matchesPattern(c.pattern, c.path, { ignoreCase: c.ignoreCase });
      if (actual !== expected) mismatches.push({ ...c, lib: actual, oracle: expected });
    }
    fail('matchesPattern vs oracle', mismatches);
  });

  test('loosening letter case only ever adds matches', () => {
    const mismatches = [];
    for (const c of generateCases(SEED ^ 0x9e3779b9, CASES / 3)) {
      const exact = matchesPattern(c.pattern, c.path);
      const loose = matchesPattern(c.pattern, c.path, { ignoreCase: true });
      if (exact && !loose) mismatches.push(c);
    }
    fail('ignoreCase dropped a match', mismatches);
  });
});

describe('pr-review-paths property harness: classifyPaths over `git diff --name-only -z --no-renames` listings', () => {
  const ZLIST = (names) => `${names.join('\0')}\0`;
  const parseZ = (raw) => raw.split('\0').slice(0, -1);

  test('a name holding a newline, a space or a line separator stays ONE entry in the documented listing', () => {
    const names = ['a b.yml', 'dir/new\nline.yml', '.github/workflows/u\u2028v.yml', 'p\u2029q'];
    expect(parseZ(ZLIST(names))).toEqual(names);
  });

  test('every path is graded by the default sensitive set and the declaration files exactly as the oracle grades it', () => {
    const rng = makeRng(SEED ^ 0x51ed270b);
    const mismatches = [];
    for (let batch = 0; batch < 3000; batch += 1) {
      // A rename is two entries under --no-renames; both sides go through the grader.
      const names = [];
      const count = 1 + rng.int(4);
      for (let i = 0; i < count; i += 1) names.push(makePath(rng, segmentList(rng)).replace(/\0/g, ''));
      const changedPaths = parseZ(ZLIST(names)).filter((name) => name.trim() !== '');
      if (changedPaths.length === 0) continue;

      const result = classifyPaths({ changedPaths, declaration: null, baseSha: BASE });
      if (!result.ok) { mismatches.push({ names, reason: result.reason }); continue; }

      changedPaths.forEach((name, i) => {
        const sensitive = DEFAULT_SENSITIVE_PATHS.some((pattern) => oracleMatches(pattern, name, true));
        const declarationFile = DEFAULT_DECLARATION_PATHS.some((file) => oracleNormalize(name, true) === file);
        if (result.paths[i].sensitive !== (sensitive || declarationFile)) {
          mismatches.push({ name, lib: result.paths[i].sensitive, oracle: sensitive || declarationFile });
        }
      });
      const anySensitive = result.paths.some((p) => p.sensitive);
      if (result.prSensitive !== anySensitive) mismatches.push({ names, prSensitive: result.prSensitive, anySensitive });
    }
    fail('classifyPaths vs oracle', mismatches);
  });

  // Spellings a case-insensitive checkout resolves onto a guarded file (each verified as an alias on APFS). They
  // are fixed by hand, not by the oracle, so a shared mistake in both cannot hide them.
  test.each([
    ['.github/work\uFB02ows/ci.yml'], // ligature fl, needs the FULL fold: `iu` does not map it to `fl`
    ['.github/workflows/\uFB01x.yml'],
    ['.GitHub/Workflows/ci.yml'],
    ['.github/wor\u212Aflows/ci.yml'], // Kelvin sign
    ['SCRIPT\u017F/generate-x/a.js'], // long s
    ['scripts/in\uFB05all-hook'], // ligature st
    ['scripts/in\uFB06all-hook'],
    ['scripts/in\u017Ftall-hook'],
    ['scripts/relea\u017Fe-notes.sh'],
    ['scripts/generate-\u017Fub/\u00DF.js'], // long s in a generate-* directory, with a sharp-s file under it
  ])('the alias %j of a guarded path is sensitive', (changedPath) => {
    const result = classifyPaths({ changedPaths: [changedPath], declaration: null, baseSha: BASE });
    expect(result.paths[0].sensitive).toBe(true);
  });

  test.each([
    ['scripts/\u0131nstall-hook'], // dotless i is no alias of i
    ['scripts/\u0130nstall-hook'], // dotted capital I folds to i + U+0307, not to i
    ['.github/workflow/ci.yml'],
    ['github/workflows/ci.yml'],
    ['xscripts/install-hook'],
    ['packages/development/lib/trd-parser.js'],
  ])('the lookalike %j is NOT sensitive', (changedPath) => {
    const result = classifyPaths({ changedPaths: [changedPath], declaration: null, baseSha: BASE });
    expect(result.paths[0].sensitive).toBe(false);
  });
});

// Defects the harness found in the matcher, pinned by hand so they do not depend on the seed reaching them again.
describe('pr-review-paths property harness: defects found by the fuzz, pinned', () => {
  test.each([
    // `**/` is whole directories, not "anything": these matched on the last letters of an unrelated name.
    ['**/foo', 'barfoo', false],
    ['**/foo', 'x/foo', true],
    ['**/foo', 'foo', true],
    ['a/**/b', 'a/xb', false],
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/x/y/b', true],
    ['**/x', 'scripts/generate-codex', false],
  ])('%j vs %j matches: %s', (pattern, changedPath, expected) => {
    expect(matchesPattern(pattern, changedPath)).toBe(expected);
  });

  test.each([
    ['.circleci/\r'],
    ['.circleci/     '],
    ['.github/workflows/     '],
    ['.github/workflows/\u2028'],
    ['scripts/generate-x/\n'],
  ])('a name that is only whitespace under a guarded directory, %j, is still under it', (changedPath) => {
    const result = classifyPaths({ changedPaths: [changedPath], declaration: null, baseSha: BASE });
    expect(result.ok).toBe(true);
    expect(result.paths[0].sensitive).toBe(true);
  });

  test('a path with whitespace around it is graded as git printed it AND with the whitespace dropped', () => {
    expect(classifyPaths({ changedPaths: ['azure-pipelines.yml '], declaration: null, baseSha: BASE }).paths[0].sensitive).toBe(true);
    expect(matchesPattern('skills/', 'skills/     ')).toBe(true);
    expect(matchesPattern('/REVIEW.md', ' REVIEW.md')).toBe(true);
  });
});
