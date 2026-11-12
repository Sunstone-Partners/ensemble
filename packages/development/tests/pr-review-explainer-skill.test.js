'use strict';

/**
 * TRD-036: structure and contract of
 * packages/development/skills/pr-review-explainer/SKILL.md.
 *
 * A skill is prose, so its Implementation AC is checked the way a maintainer
 * or another skill reads it: by parsing the markdown. The PRD scenarios for
 * REQ-022 belong to TRD-036-TEST and the report-side offer to TRD-043; this
 * file covers only what TRD-036 owns.
 */

const fs = require('fs');
const path = require('path');

const SKILL_PATH = path.join(__dirname, '..', 'skills', 'pr-review-explainer', 'SKILL.md');

describe('pr-review-explainer SKILL.md', () => {
  const text = fs.readFileSync(SKILL_PATH, 'utf8');
  const flat = text.replace(/\s+/g, ' ');

  const sectionIndex = (label) => {
    const at = text.indexOf(label);
    expect(at).toBeGreaterThan(-1);
    return at;
  };

  test('has frontmatter with the skill name and a when-to-use description', () => {
    const match = text.match(/^---\n([\s\S]*?)\n---\n/);
    expect(match).not.toBeNull();
    const frontmatter = match[1];
    expect(frontmatter).toContain('name: pr-review-explainer');
    expect(frontmatter).toMatch(/description: .+/);
    expect(frontmatter).toContain('do not use');
  });

  test('AC-022-1: the explainer is derived from the code as it is now, not from memory or docs', () => {
    const read = text.slice(sectionIndex('## Step 3 -- Read the current code'), sectionIndex('## Step 4'));
    const flatRead = read.replace(/\s+/g, ' ');
    expect(flatRead).toContain('from the working tree as it is now');
    expect(flatRead).toContain('not from a base commit');
    expect(flatRead).toContain('the abbreviated HEAD commit id');
    // Resolution happens before any prose is written.
    expect(sectionIndex('## Step 1 -- Resolve `MODULE` to files')).toBeLessThan(
      sectionIndex('## Step 4 -- Write the explainer')
    );
  });

  test('AC-022-2: every explainer ends with the list of files it was derived from', () => {
    expect(text).toContain('Derived from:');
    expect(flat).toContain(
      '`Derived from:` lists every file read and nothing else'
    );
    expect(flat).toContain('never an explainer with an empty or guessed `Derived from:` list');
  });

  test('no readable source: the skill says so and produces no explainer', () => {
    const stop = text.slice(
      sectionIndex('## Step 2 -- Stop when there is no readable source'),
      sectionIndex('## Step 3')
    );
    expect(stop).toContain('EXPLAINER_UNAVAILABLE');
    expect(stop).toContain('No explainer was produced.');
    const flatStop = stop.replace(/\s+/g, ' ');
    // The substitutes a model would reach for are each refused by name.
    for (const substitute of ['documentation', 'a commit message', 'a test file alone', 'an older revision', 'prior knowledge']) {
      expect(flatStop).toContain(substitute);
    }
  });

  test('the two outcomes are exclusive, so an unavailable explainer cannot carry text', () => {
    const outputs = text.slice(sectionIndex('## Outputs'), sectionIndex('## Step 1'));
    expect(outputs).toContain('Exactly one of:');
    expect(outputs.replace(/\s+/g, ' ')).toContain('Never both');
    expect(outputs).toContain('**no explainer text**');
  });

  test('untrusted input never selects the file and mirrors are never the source', () => {
    const resolve = text.slice(sectionIndex('## Step 1 -- Resolve `MODULE` to files'), sectionIndex('## Step 2'));
    const flatResolve = resolve.replace(/\s+/g, ' ');
    expect(flatResolve).toContain('escapes `REPO_ROOT`');
    expect(flatResolve).toContain('it never selects the file');
    expect(flatResolve).toContain('are never the source of an explainer');
    expect(resolve).toContain('packages/pi/skills/**');
  });

  test('High-tier offer: nothing is produced until a person asks', () => {
    const offer = text.slice(sectionIndex('## Step 5 -- The High-tier offer'), sectionIndex('## Reachability'));
    const flatOffer = offer.replace(/\s+/g, ' ');
    expect(flatOffer).toContain('With `REQUESTED = false` this skill produces nothing');
    expect(flatOffer).toContain('An offer is an invitation, never a job');
    // Sensitivity is a computed fact, not a judgement made in prose.
    expect(offer).toContain('pr-review-cli.js paths');
    expect(offer).toContain('`sensitive: true`');
    // The report-side half stays out of this skill.
    expect(flatOffer).toContain("that is TRD-043's half");
  });

  test('REQUESTED is declared as an input, so the offer gate has something to read', () => {
    const inputs = text.slice(sectionIndex('## Inputs'), sectionIndex('## Outputs'));
    for (const name of ['`MODULE`', '`REPO_ROOT`', '`REQUESTED`', '`TIER`', '`SENSITIVE_PATHS`']) {
      expect(inputs).toContain(name);
    }
  });

  test('the skill reaches the CLI itself and YAML callers reference only the skill', () => {
    const reach = text.slice(sectionIndex('## Reachability'));
    expect(reach.replace(/\s+/g, ' ')).toContain('No YAML caller references the CLI');
  });
});
