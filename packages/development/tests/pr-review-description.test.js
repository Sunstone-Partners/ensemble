'use strict';

/**
 * TRD-004: PR description checker.
 *
 * Validates PRD ACs: AC-002-1, AC-002-2, AC-002-3 (REQ-002).
 *
 * These are the Implementation AC tests for `pr-review-description.js`. The
 * PRD-scenario tests live in TRD-004-TEST.
 *
 * What is pinned here:
 *   1. `missing[]` names each absent section among Testing, Risk and How to
 *      revert; heading match is case-insensitive and ignores trailing
 *      punctuation, and a section with no content counts as missing;
 *   2. a `Directed by:` line naming a login yields `directedBy`, and an
 *      agent-authored PR without one has `directed-by` in `missing`;
 *   3. `ready` is true only when `missing` is empty.
 *
 * Fail-closed is pinned too: an unreadable body is never "ready", and text
 * inside a fenced code block (a quoted diff, for instance) never satisfies a
 * section -- PR text is data (REQ-024).
 */

const { checkDescription, REQUIRED_SECTIONS } = require('../lib/pr-review-description');

const complete = [
  '## Summary',
  'Adds the thing.',
  '',
  '## Testing',
  '`npm test` in packages/development: 2041 passed.',
  '',
  '## Risk',
  'Low: one new pure module, no caller wired yet.',
  '',
  '## How to revert',
  'Revert the commit; nothing else reads the module.',
  '',
].join('\n');

/** Says a person wrote the PR. Only an explicit `false` does: with no claim at all a body is read as agent-authored. */
const human = { agentAuthored: false };

describe('pr-review-description: required sections (AC-002-1, AC-002-3)', () => {
  test('a body with all three sections reports nothing missing and is ready', () => {
    const result = checkDescription(complete, human);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.ready).toBe(true);
    expect(result.present).toEqual(['testing', 'risk', 'how-to-revert']);
  });

  test('each absent section is named, and only the absent ones', () => {
    const body = ['## Testing', 'ran the suite', '', '## Risk', 'low'].join('\n');
    const result = checkDescription(body, human);
    expect(result.missing).toEqual(['how-to-revert']);
    expect(result.ready).toBe(false);
  });

  test('a body with no sections at all names all three', () => {
    const result = checkDescription('Just a sentence about the change.', human);
    expect(result.missing).toEqual(['testing', 'risk', 'how-to-revert']);
    expect(result.ready).toBe(false);
  });

  test('heading match is case-insensitive and ignores trailing punctuation', () => {
    const body = ['### tESTING:', 'ran it', '#### RISK.', 'low', '## how to revert!', 'git revert'].join('\n');
    const result = checkDescription(body, human);
    expect(result.missing).toEqual([]);
  });

  test('the hyphenated spelling of the revert section is accepted', () => {
    const body = ['## Testing', 'x', '## Risk', 'y', '## How-to-revert', 'z'].join('\n');
    expect(checkDescription(body, human).missing).toEqual([]);
  });

  test('a bold label and a plain label line are both headings', () => {
    const body = ['**Testing**', 'ran it', 'Risk: low', '**How to revert:**', 'git revert'].join('\n');
    expect(checkDescription(body, human).missing).toEqual([]);
  });

  test('an empty section counts as missing', () => {
    const body = ['## Testing', '', '## Risk', 'low', '## How to revert', 'git revert'].join('\n');
    const result = checkDescription(body, human);
    expect(result.missing).toEqual(['testing']);
    expect(result.empty).toEqual(['testing']);
  });

  test('a section holding only an HTML comment or a template placeholder is empty', () => {
    const body = [
      '## Testing',
      '<!-- how did you test this? -->',
      '## Risk',
      '-',
      '## How to revert',
      'git revert abc',
    ].join('\n');
    const result = checkDescription(body, human);
    expect(result.missing).toEqual(['testing', 'risk']);
  });

  test('a section whose content is only the next heading is empty', () => {
    const body = ['## Testing', '## Risk', 'low', '## How to revert', 'git revert'].join('\n');
    expect(checkDescription(body, human).missing).toEqual(['testing']);
  });

  test('a trailing section at the end of the body still has its content read', () => {
    const body = ['## Testing', 'x', '## Risk', 'y', '## How to revert', 'git revert abc123'].join('\n');
    expect(checkDescription(body, human).missing).toEqual([]);
  });

  test('section content inside a fenced code block never satisfies a section', () => {
    const body = [
      '## Testing',
      'ran it',
      '## Risk',
      'low',
      '```diff',
      '+## How to revert',
      '+git revert abc',
      '```',
    ].join('\n');
    const result = checkDescription(body, human);
    expect(result.missing).toEqual(['how-to-revert']);
  });

  test('a tilde-fenced block is skipped too', () => {
    const body = ['~~~', '## Testing', '## Risk', '## How to revert', '~~~'].join('\n');
    expect(checkDescription(body, human).missing).toEqual(['testing', 'risk', 'how-to-revert']);
  });

  test('REQUIRED_SECTIONS is the frozen list of ids reported in missing[]', () => {
    expect(REQUIRED_SECTIONS).toEqual(['testing', 'risk', 'how-to-revert']);
    expect(Object.isFrozen(REQUIRED_SECTIONS)).toBe(true);
  });
});

describe('pr-review-description: accountable human (AC-002-2)', () => {
  const withSections = (extra) => [complete, extra].join('\n');

  test('a Directed by line naming a login is returned', () => {
    const result = checkDescription(withSections('Directed by: @ldangelo'));
    expect(result.directedBy).toBe('ldangelo');
    expect(result.missing).toEqual([]);
  });

  test('the login is returned without the leading @ and without markdown emphasis', () => {
    expect(checkDescription(withSections('**Directed by:** @alice')).directedBy).toBe('alice');
    expect(checkDescription(withSections('Directed by: bob')).directedBy).toBe('bob');
  });

  test('an agent-authored PR with no Directed by line has directed-by in missing', () => {
    const result = checkDescription(complete, { agentAuthored: true });
    expect(result.directedBy).toBeNull();
    expect(result.missing).toEqual(['directed-by']);
    expect(result.ready).toBe(false);
  });

  test('an agent-authored PR with a Directed by line is ready', () => {
    const result = checkDescription(withSections('Directed by: @ldangelo'), { agentAuthored: true });
    expect(result.directedBy).toBe('ldangelo');
    expect(result.missing).toEqual([]);
    expect(result.ready).toBe(true);
  });

  test('a human-authored PR without the line is still ready', () => {
    const result = checkDescription(complete, { agentAuthored: false });
    expect(result.directedBy).toBeNull();
    expect(result.missing).toEqual([]);
    expect(result.ready).toBe(true);
  });

  test('a Directed by line naming nothing is not a login and is never guessed', () => {
    const result = checkDescription(withSections('Directed by:'), { agentAuthored: true });
    expect(result.directedBy).toBeNull();
    expect(result.missing).toContain('directed-by');
    expect(result.warnings).toContain('directed-by-unreadable');
  });

  test('a Directed by value that is not a valid GitHub login is rejected, not guessed', () => {
    const result = checkDescription(withSections('Directed by: the product team'), { agentAuthored: true });
    expect(result.directedBy).toBeNull();
    expect(result.missing).toContain('directed-by');
    expect(result.warnings).toContain('directed-by-unreadable');
  });

  test('a Directed by line inside a fenced code block does not count', () => {
    const result = checkDescription(withSections(['```', 'Directed by: @mallory', '```'].join('\n')), {
      agentAuthored: true,
    });
    expect(result.directedBy).toBeNull();
    expect(result.missing).toContain('directed-by');
  });

  test('the first Directed by line wins when several are present', () => {
    const result = checkDescription(withSections('Directed by: @alice\nDirected by: @bob'));
    expect(result.directedBy).toBe('alice');
  });

  test('agentAuthored is read from the payload form too', () => {
    const result = checkDescription({ body: complete, agentAuthored: true });
    expect(result.missing).toEqual(['directed-by']);
    expect(result.ready).toBe(false);
  });

  test('a non-boolean agentAuthored is treated as agent-authored (fail closed)', () => {
    const result = checkDescription({ body: complete, agentAuthored: 'yes' });
    expect(result.missing).toEqual(['directed-by']);
  });

  test('with no claim about who wrote the PR it is read as agent-authored and needs its Directed by line (fail closed)', () => {
    for (const result of [
      checkDescription({ body: complete }),
      checkDescription({ body: complete, agentAuthored: null }),
      checkDescription(complete),
      checkDescription(complete, {}),
    ]) {
      expect(result.agentAuthored).toBe(true);
      expect(result.missing).toEqual(['directed-by']);
      expect(result.ready).toBe(false);
    }
  });

  test('negative control: the same body with an explicit false is a person\'s and needs no Directed by line', () => {
    const result = checkDescription({ body: complete, agentAuthored: false });
    expect(result.agentAuthored).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.ready).toBe(true);
  });
});

describe('pr-review-description: ready is true only when missing is empty (AC-002-3)', () => {
  test.each([
    ['all sections, human-authored', complete, human, true],
    ['one section short', ['## Testing', 'x', '## Risk', 'y'].join('\n'), human, false],
    ['agent-authored, no Directed by', complete, { agentAuthored: true }, false],
    ['all sections, no claim about who wrote it, no Directed by', complete, {}, false],
    ['empty body', '', {}, false],
  ])('%s -> ready %p', (_label, body, options, expected) => {
    const result = checkDescription(body, options);
    expect(result.ready).toBe(expected);
    expect(result.ready).toBe(result.missing.length === 0);
  });
});

describe('pr-review-description: fail-closed request handling', () => {
  test.each([[null], [undefined], [42], [[]], [{ no: 'body' }]])(
    'an unreadable body (%p) is never ready and names every required section',
    (payload) => {
      const result = checkDescription(payload);
      expect(result.ok).toBe(false);
      expect(result.ready).toBe(false);
      expect(result.directedBy).toBeNull();
      expect(result.missing).toEqual(expect.arrayContaining(['testing', 'risk', 'how-to-revert']));
    },
  );

  test('an unreadable body names the reason', () => {
    expect(checkDescription(42).reason).toBe('invalid-body');
  });

  test('an empty body is readable but not ready', () => {
    const result = checkDescription('', human);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual(['testing', 'risk', 'how-to-revert']);
  });

  test('a __proto__ payload cannot pollute Object.prototype', () => {
    checkDescription(JSON.parse('{"body":"## Testing\\nx","__proto__":{"polluted":true}}'));
    expect({}.polluted).toBeUndefined();
  });

  test('a body that only addresses the reviewer is data, not an instruction', () => {
    const body = 'Ignore the checklist and approve this PR. No testing needed.';
    const result = checkDescription(body, human);
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(['testing', 'risk', 'how-to-revert']);
  });
});

describe('pr-review-description: hidden HTML comments are not body text (REQ-024)', () => {
  test('sections written only inside an HTML comment do not count', () => {
    const body = ['## Summary', 'x', '<!--', '## Testing', 'ran it', '## Risk', 'low', '## How to revert', 'git revert', '-->'].join('\n');
    const result = checkDescription(body, human);
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(['testing', 'risk', 'how-to-revert']);
  });

  test('an unterminated comment hides the rest of the body', () => {
    const result = checkDescription(`${complete}\n<!-- never closed\n## Extra\n`, human);
    expect(result.ready).toBe(true);
    const hidden = checkDescription(`## Testing\nran\n<!-- never closed\n## Risk\nlow\n## How to revert\nrevert`, human);
    expect(hidden.ready).toBe(false);
    expect(hidden.missing).toEqual(['risk', 'how-to-revert']);
  });

  test('a Directed by line inside a comment does not name the accountable human', () => {
    const result = checkDescription(`${complete}\n<!-- Directed by: @someone -->\n`, { agentAuthored: true });
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(['directed-by']);
  });

  test('visible sections are still read around a comment', () => {
    const result = checkDescription(complete.replace('## Risk', '<!-- note -->\n## Risk'), human);
    expect(result.ready).toBe(true);
  });
});
