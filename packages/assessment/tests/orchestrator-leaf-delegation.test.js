'use strict';

/**
 * assess-repo and assess-team are thin orchestrators: each specialist task is a dispatch block
 * ("Load the `<leaf>` skill and follow it." plus this run's rules) and the leaf skill is the single
 * source of that specialist's instructions.
 *
 * These are structural assertions over the prose skill files -- there is no runtime harness for a
 * skill. They read the files at run time, so editing a skill never needs a test edit; only adding,
 * renaming, or removing a dispatched dimension touches EXPECTED_DISPATCH below. They guard:
 *
 *   (a) every leaf an orchestrator dispatches to resolves to skills/<leaf>/SKILL.md (whose
 *       frontmatter `name` matches the directory), each orchestrator dispatches exactly the expected
 *       leaves, and a dispatch block stays thin (no specialist prompt re-inlined);
 *   (b) no leaf instructs a bare letter-only score -- scores are `<1.0-5.0> / <Letter>`, the letter
 *       derived from `skill://assessment-report-suite`'s Scoring Scale;
 *   (c) every `skill://<name>` reference in the assessment skills resolves to a skill directory in
 *       this package.
 */

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');

const EXPECTED_DISPATCH = {
  'assess-repo': [
    'assess-purpose',
    'assess-architect',
    'assess-code-quality',
    'assess-testing',
    'assess-security',
    'assess-ai-readiness',
    'assess-cicd',
  ],
  'assess-team': [
    'assess-team-commit-volume',
    'assess-team-commit-messages',
    'assess-team-code-quality',
    'assess-team-test-coverage',
    'assess-team-ai-adoption',
    'assess-team-documentation',
    'assess-team-incidents',
    'assess-team-code-review',
  ],
};
const ORCHESTRATORS = Object.keys(EXPECTED_DISPATCH);

// The first line of every thin dispatch block.
const DISPATCH_LINE = /^Load the `([^`\s]+)` skill and follow it\.$/gm;
const MAX_DISPATCH_BLOCK_LINES = 12;
// A `Score` heading line (`## Score: ...`), as opposed to e.g. a `# Score Anchors` section.
const SCORE_HEADING = /^#{1,6}\s*Score\s*(?::|$)/;
// Phrases that only appear in a specialist's own prompt / output template.
const INLINED_PROMPT = new RegExp(`Output structure|${SCORE_HEADING.source}|^Analyze:`, 'm');

const skillPath = (name) => path.join(SKILLS_DIR, name, 'SKILL.md');
const readSkill = (name) => fs.readFileSync(skillPath(name), 'utf8');
const frontmatterName = (text) => {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text);
  const name = frontmatter && /^name:\s*(\S+)\s*$/m.exec(frontmatter[1]);
  return name ? name[1] : undefined;
};

// Each dispatch: the leaf name and its block (the line up to the closing code fence).
const dispatches = (orchestrator) => {
  const text = readSkill(orchestrator);
  return [...text.matchAll(DISPATCH_LINE)].map((match) => {
    const close = text.indexOf('```', match.index);
    return { leaf: match[1], block: text.slice(match.index, close === -1 ? text.length : close) };
  });
};
const dispatchedLeaves = (orchestrator) => dispatches(orchestrator).map(({ leaf }) => leaf);

const markdownFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });

describe.each(ORCHESTRATORS)('%s orchestrator (a)', (orchestrator) => {
  test('dispatches exactly the expected leaf skills, once each', () => {
    expect(dispatchedLeaves(orchestrator).sort()).toEqual([...EXPECTED_DISPATCH[orchestrator]].sort());
  });

  test('every dispatched leaf resolves to an existing skill whose frontmatter name matches', () => {
    const problems = [];
    for (const leaf of dispatchedLeaves(orchestrator)) {
      if (!fs.existsSync(skillPath(leaf))) {
        problems.push(`${leaf}: skills/${leaf}/SKILL.md does not exist`);
      } else if (frontmatterName(readSkill(leaf)) !== leaf) {
        problems.push(`${leaf}: frontmatter name is ${frontmatterName(readSkill(leaf))}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('dispatch blocks stay thin (no specialist prompt or output template re-inlined)', () => {
    const problems = [];
    for (const { leaf, block } of dispatches(orchestrator)) {
      const lines = block.trimEnd().split('\n').length;
      if (lines > MAX_DISPATCH_BLOCK_LINES) problems.push(`${leaf}: ${lines} lines`);
      if (INLINED_PROMPT.test(block)) problems.push(`${leaf}: contains specialist prompt text`);
    }
    expect(problems).toEqual([]);
  });
});

describe('dispatched leaf skills (b)', () => {
  // A dispatch to a missing skill is reported by (a); (b) checks the leaves that do exist.
  const leaves = [...new Set(ORCHESTRATORS.flatMap(dispatchedLeaves))].filter((leaf) =>
    fs.existsSync(skillPath(leaf)),
  );

  test('at least one leaf is dispatched', () => {
    expect(leaves.length).toBeGreaterThan(0);
  });

  test('every leaf states the numeric-first scoring rule and points at the shared Scoring Scale', () => {
    const missing = [];
    for (const leaf of leaves) {
      const text = readSkill(leaf);
      if (!text.includes('1.0-5.0')) missing.push(`${leaf}: no 1.0-5.0 scoring rule`);
      if (!text.includes('skill://assessment-report-suite')) {
        missing.push(`${leaf}: no skill://assessment-report-suite Scoring Scale reference`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('no leaf instructs a bare letter-only score', () => {
    const offenders = [];
    for (const leaf of leaves) {
      readSkill(leaf)
        .split('\n')
        .forEach((line, index) => {
          const where = `${leaf}:${index + 1}: ${line.trim()}`;
          // A letter-range placeholder instead of a number: `## Score: A-F`, a `| A-F |` cell.
          if (/\bA\s*[-–]\s*F\b/.test(line)) offenders.push(where);
          // A `<Letter>` placeholder with no numeric part beside it.
          else if (line.includes('<Letter>') && !line.includes('1.0-5.0')) offenders.push(where);
          // A Score heading that does not carry the numeric-first placeholder.
          else if (SCORE_HEADING.test(line) && !line.includes('1.0-5.0')) offenders.push(where);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('skill:// references (c)', () => {
  test('every skill:// reference in the assessment skills resolves to a skill directory in this package', () => {
    const unresolved = [];
    let references = 0;
    for (const file of markdownFiles(SKILLS_DIR)) {
      for (const [, name] of fs.readFileSync(file, 'utf8').matchAll(/skill:\/\/([A-Za-z0-9][A-Za-z0-9_-]*)/g)) {
        references += 1;
        if (!fs.existsSync(skillPath(name))) {
          unresolved.push(`${path.relative(SKILLS_DIR, file)} -> skill://${name}`);
        }
      }
    }
    expect(references).toBeGreaterThan(0);
    expect(unresolved).toEqual([]);
  });
});
