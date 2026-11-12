'use strict';

/**
 * TRD-004-TEST: PR description sections (PRD scenarios).
 *
 * Validates PRD ACs: AC-002-1, AC-002-2, AC-002-3 (REQ-002).
 *
 * The Implementation AC tests for the module live in
 * pr-review-description.test.js. These are the PRD-LEVEL scenarios: each one
 * is written the way REQ-002 words it -- a whole PR description as a human or
 * an agent would really write it, graded once, and the verdict a reviewer
 * would act on is the thing asserted.
 *
 *   - AC-002-1: a description created for a PR opened by a human or by an
 *     agent contains Testing, Risk and How-to-revert.
 *   - AC-002-2: when an agent drafts those sections, the person who directed
 *     the agent is identified as the one accountable for them, and the PR is
 *     not ready for human approval while that person is unnamed.
 *   - AC-002-3: a description missing any of the three sections is reported
 *     as not ready for approval and names the missing section.
 *
 * Each scenario carries a NEGATIVE CONTROL: the same scenario with the thing
 * it is proving taken away, which must produce the opposite verdict. A
 * scenario that cannot fail proves nothing.
 */

const { checkDescription, REQUIRED_SECTIONS } = require('../lib/pr-review-description');

/** A PR description a person would really write, with all three sections. */
const humanAuthored = [
  '## Summary',
  '',
  'Adds the applicable review-rules resolver.',
  '',
  '## Testing',
  '',
  '`npx jest tests/pr-review` in packages/development: 2121 passed.',
  '',
  '## Risk',
  '',
  'Low. One new pure module; no caller is wired to it yet.',
  '',
  '## How to revert',
  '',
  'Revert the commit. Nothing else reads the module.',
  '',
].join('\n');

/** The same PR, drafted by an agent working for a named person. */
const agentAuthored = [
  humanAuthored,
  'Directed by: @ldangelo',
  '',
].join('\n');

/**
 * The options that say a person wrote the PR. Only an explicit `false` does: a description graded with no claim at all
 * is read as agent-authored, and then also needs its `Directed by:` line.
 */
const byAPerson = { agentAuthored: false };

/** Drops one section (heading and body) from a description. */
const without = (body, heading) => {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) throw new Error(`fixture has no "${heading}" section`);
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('## ')) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
};

describe('Scenario AC-002-1: a PR description contains Testing, Risk and How-to-revert', () => {
  test('a human-opened PR with all three sections is ready for approval', () => {
    const result = checkDescription(humanAuthored, { agentAuthored: false });

    expect(result.ok).toBe(true);
    expect(result.present).toEqual(['testing', 'risk', 'how-to-revert']);
    expect(result.missing).toEqual([]);
    expect(result.ready).toBe(true);
  });

  test('an agent-opened PR with the same three sections is ready too', () => {
    const result = checkDescription({ body: agentAuthored, agentAuthored: true });

    expect(result.present).toEqual(['testing', 'risk', 'how-to-revert']);
    expect(result.missing).toEqual([]);
    expect(result.ready).toBe(true);
  });

  test('the three required sections are exactly the ones REQ-002 names', () => {
    expect([...REQUIRED_SECTIONS]).toEqual(['testing', 'risk', 'how-to-revert']);
  });

  test('negative control: the same PR without its Risk section is not ready', () => {
    const result = checkDescription(without(humanAuthored, 'Risk'), byAPerson);

    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(['risk']);
  });
});

describe('Scenario AC-002-2: the person who directed the agent is accountable', () => {
  test('an agent-drafted PR names the directing person', () => {
    const result = checkDescription({ body: agentAuthored, agentAuthored: true });

    expect(result.agentAuthored).toBe(true);
    expect(result.directedBy).toBe('ldangelo');
    expect(result.ready).toBe(true);
  });

  test('an agent-drafted PR with nobody named is not ready for human approval', () => {
    const result = checkDescription({ body: humanAuthored, agentAuthored: true });

    expect(result.directedBy).toBeNull();
    expect(result.missing).toContain('directed-by');
    expect(result.ready).toBe(false);
  });

  test('the accountable person is read from the description, never inferred', () => {
    const vague = [humanAuthored, 'Directed by: the team', ''].join('\n');
    const result = checkDescription({ body: vague, agentAuthored: true });

    expect(result.directedBy).toBeNull();
    expect(result.warnings).toContain('directed-by-unreadable');
    expect(result.ready).toBe(false);
  });

  test('a PR that only claims in prose to be agent work does not relax the check', () => {
    // The claim lives in the PR text, which is data (REQ-024): the caller's
    // agentAuthored flag decides, and an unreadable flag fails closed.
    const claim = [humanAuthored, 'This PR was written by an agent.', ''].join('\n');
    const result = checkDescription({ body: claim, agentAuthored: 'yes' });

    expect(result.agentAuthored).toBe(true);
    expect(result.missing).toContain('directed-by');
    expect(result.ready).toBe(false);
  });

  test('negative control: the same body opened by a human needs no attribution', () => {
    const result = checkDescription({ body: humanAuthored, agentAuthored: false });

    expect(result.missing).not.toContain('directed-by');
    expect(result.ready).toBe(true);
  });
});

describe('Scenario AC-002-3: a missing section is reported and named', () => {
  test.each([
    ['Testing', 'testing'],
    ['Risk', 'risk'],
    ['How to revert', 'how-to-revert'],
  ])('a PR with no %s section is not ready and names %s', (heading, id) => {
    const result = checkDescription(without(humanAuthored, heading), byAPerson);

    expect(result.ready).toBe(false);
    expect(result.missing).toEqual([id]);
  });

  test('two missing sections are both named', () => {
    const result = checkDescription(without(without(humanAuthored, 'Risk'), 'How to revert'), byAPerson);

    expect(result.missing).toEqual(['risk', 'how-to-revert']);
    expect(result.ready).toBe(false);
  });

  test('a heading with no content under it counts as missing and is named', () => {
    const emptied = humanAuthored.replace(
      'Low. One new pure module; no caller is wired to it yet.',
      '<!-- TODO -->',
    );
    const result = checkDescription(emptied, byAPerson);

    expect(result.missing).toEqual(['risk']);
    expect(result.empty).toEqual(['risk']);
    expect(result.ready).toBe(false);
  });

  test('a description that only quotes the sections inside a code fence is not ready', () => {
    const quoted = [
      '## Summary',
      '',
      'Here is the template we should fill in:',
      '',
      '```markdown',
      '## Testing',
      'how it was tested',
      '## Risk',
      'low',
      '## How to revert',
      'revert the commit',
      '```',
      '',
    ].join('\n');
    const result = checkDescription(quoted, byAPerson);

    expect(result.missing).toEqual(['testing', 'risk', 'how-to-revert']);
    expect(result.ready).toBe(false);
  });

  test('an empty description names all three sections', () => {
    const result = checkDescription('', byAPerson);

    expect(result.missing).toEqual(['testing', 'risk', 'how-to-revert']);
    expect(result.ready).toBe(false);
  });

  test('an unreadable description is reported as not ready, never approved by default', () => {
    const result = checkDescription(undefined);

    expect(result.ok).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining(['testing', 'risk', 'how-to-revert']));
    // Fail-closed also demands the accountable human when nothing can be read.
    expect(result.missing).toContain('directed-by');
  });

  test('negative control: the complete description is ready and names nothing', () => {
    const result = checkDescription(humanAuthored, byAPerson);

    expect(result.missing).toEqual([]);
    expect(result.ready).toBe(true);
  });
});
