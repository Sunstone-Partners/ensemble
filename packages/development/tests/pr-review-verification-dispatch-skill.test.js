'use strict';

/**
 * TRD-040: verification dispatch, CodeRabbit ingestion and degraded modes in
 * packages/development/skills/pr-review-cycle/SKILL.md.
 *
 * The skill is prose, so its Implementation AC is checked by parsing the
 * markdown -- and every contract the prose asserts about `votes` is checked
 * against the real module, so the skill and the library can never drift into
 * disagreeing about what an outcome means. The PRD scenarios for REQ-005 and
 * REQ-006 belong to TRD-040-TEST; this file covers only what TRD-040 owns.
 */

const fs = require('fs');
const { readSkillBundle } = require('./helpers/pr-review-cycle-skill');
const path = require('path');

const { tallyVotes } = require('../lib/pr-review-votes');
const { HANDLERS } = require('../lib/pr-review-cli');

const SKILL_PATH = path.join(__dirname, '..', 'skills', 'pr-review-cycle', 'SKILL.md');
const TEXT = readSkillBundle();
const FLAT = TEXT.replace(/\s+/g, ' ');

const sectionIndex = (label) => {
  const at = TEXT.indexOf(label);
  expect([label, at > -1]).toEqual([label, true]);
  return at;
};

const section = (from, to) => TEXT.slice(sectionIndex(from), sectionIndex(to));

/** One candidate finding, shaped as Step 3b documents it. */
function candidate(overrides = {}) {
  return {
    id: 'F1',
    severity: 'important',
    reviewer: 'reviewer-a',
    votes: [
      { verifier: 'v1', verdict: 'real' },
      { verifier: 'v2', verdict: 'real' },
      { verifier: 'v3', verdict: 'not-real' },
    ],
    ...overrides,
  };
}

describe('TRD-040: the verification step exists and is reachable from where it is referenced', () => {
  test('Step 3b is a real section, and the Step 1c cross-reference points at it', () => {
    const at = sectionIndex('### Step 3b -- Verify the candidates before they are presented (CLI `votes`)');
    expect(FLAT).toContain('settled by verification (Step 3b / `votes`)');
    // It is referenced from Step 1c and runs before triage, so only verified
    // candidates are ever triaged or fixed.
    expect(sectionIndex('### Step 3 -- Build ledger')).toBeLessThan(at);
    expect(at).toBeLessThan(sectionIndex('### Step 4 -- Triage all findings before any edit'));
    // The dangling reference this task existed to resolve is gone.
    expect(TEXT).not.toContain('Step 6b');
  });

  test('`votes` is a registered CLI subcommand, so the documented call is real', () => {
    expect(Object.prototype.hasOwnProperty.call(HANDLERS, 'votes')).toBe(true);
  });
});

describe('TRD-040: verifier dispatch -- the depth\'s verifiers, never the finding\'s own reviewer', () => {
  const step = section('### Step 3b --', '### Step 4 --');
  const flat = step.replace(/\s+/g, ' ');

  test('dispatches the count the mode resolved, as fresh-context subagents', () => {
    expect(flat).toContain('bounds.verifiers');
    expect(flat).toContain('Quick none, Standard 3, Deep 5');
    expect(flat).toContain('**fresh-context subagent**');
    expect(flat).toContain('never the authoring conversation');
  });

  test('a verifier never votes on a finding it produced itself', () => {
    expect(flat).toContain('**A verifier never votes on a finding it produced itself**');
    expect(flat).toContain('that reviewer is excluded from that finding\'s verifier set');
    // And the documented fallback when exclusion is impossible is the marked,
    // presented outcome -- not a self-confirmed finding.
    expect(flat).toContain('record it in `incompleteVerifiers`');
    expect(flat).toContain('rather than letting the author of the finding confirm their own finding');
  });

  test('the verdict vocabulary is the module\'s closed set', () => {
    expect(flat).toContain('`real`, `not-real` or `abstain`');
    expect(flat).toContain('Anything else is not a vote');
    // The library agrees: an invented verdict is not counted as agreement.
    const result = tallyVotes({
      depth: 'standard',
      findings: [candidate({ votes: [{ verifier: 'v1', verdict: 'looks-fine' }, { verifier: 'v2', verdict: 'looks-fine' }] })],
    });
    expect(result.findings[0].outcome).not.toBe('present');
  });

  test('the denominator is the count the depth expects, not the votes that arrived', () => {
    expect(flat).toContain('never the number of votes that happened to arrive');
    const oneVote = tallyVotes({ depth: 'standard', findings: [candidate({ votes: [{ verifier: 'v1', verdict: 'real' }] })] });
    expect(oneVote.findings[0].outcome).toBe('filtered');
    expect(oneVote.presented.map((entry) => entry.id)).not.toContain('F1');
  });
});

describe('TRD-040: only present, disputed and unverified findings are presented', () => {
  const step = section('### Step 3b --', '### Step 4 --');
  const flat = step.replace(/\s+/g, ' ');

  test('the skill names exactly the three presented outcomes', () => {
    expect(flat).toContain('Present exactly `presented[]`');
    expect(flat).toContain('the `present`, `disputed` and `unverified` findings -- and nothing else');
  });

  test('a filtered finding is not presented, and is not deleted either', () => {
    expect(flat).toContain('is **not** presented as something to fix');
    expect(flat).toContain('it stays in the ledger with its tally and reason');
    const triage = section('### Step 4 --', '### Step 5 --').replace(/\s+/g, ' ');
    expect(triage).toContain('Classify every **presented** ledger entry from Step 3b');
    expect(triage).toContain('A `filtered` finding is not triaged and not fixed');
    expect(triage).toContain('but it is never deleted from the ledger');
  });

  test('the author-facing wording the skill promises is the wording the module emits', () => {
    expect(flat).toContain('"verifier disagrees"');
    expect(flat).toContain('never "required fix"');
    const failed = tallyVotes({
      depth: 'standard',
      findings: [candidate({ votes: [{ verifier: 'v1', verdict: 'not-real' }, { verifier: 'v2', verdict: 'not-real' }, { verifier: 'v3', verdict: 'not-real' }] })],
    });
    expect(failed.findings[0].outcome).toBe('filtered');
    expect(failed.findings[0].authorLabel).toBe('verifier disagrees');

    const security = tallyVotes({
      depth: 'standard',
      findings: [candidate({ security: true, votes: [{ verifier: 'v1', verdict: 'not-real' }, { verifier: 'v2', verdict: 'not-real' }, { verifier: 'v3', verdict: 'not-real' }] })],
    });
    expect(security.findings[0].outcome).toBe('disputed');
    expect(security.presented.map((entry) => entry.id)).toContain('F1');
  });

  test('an incomplete verifier degrades the finding even when the votes would have passed', () => {
    expect(flat).toContain('**even if the votes that did arrive would have reached a majority**');
    expect(flat).toContain('supply-the-missing-votes');
    const result = tallyVotes({
      depth: 'standard',
      findings: [candidate({ incompleteVerifiers: [{ verifier: 'v3', reason: 'timeout' }] })],
    });
    expect(result.findings[0].outcome).toBe('unverified');
    expect(result.findings[0].reason).toBe('verifier-incomplete');
    expect(result.presented.map((entry) => entry.id)).toContain('F1');
    expect(result.recoveryAction).toBe('supply-the-missing-votes');
  });

  test('a blocked tally is REVIEW_BLOCKED, not a round with no findings', () => {
    expect(flat).toContain('not a round with no findings');
    expect(tallyVotes({ depth: 'standard', findings: 'all of them' }).verification).toBe('blocked');
  });
});

describe('TRD-040: CodeRabbit findings enter the same ledger and the same verification (AC-005-3)', () => {
  const step = section('**Ingesting CodeRabbit and other review-bot findings', '### Step 3b --');
  const flat = step.replace(/\s+/g, ' ');

  test('a bot finding becomes a ledger entry with its source and its permalink', () => {
    expect(flat).toContain('`source` set to that bot\'s login');
    expect(flat).toContain('`originalTextOrLink` set to the permalink of the comment');
    expect(flat).toContain('the **same** `dedupe` / `recordRound` and the same verification in Step 3b');
  });

  test('a bot finding is neither pre-trusted nor pre-dismissed', () => {
    expect(flat).toContain('never pre-trusted into `present` and never pre-dismissed');
    expect(flat).toContain('the verifiers decide, exactly as for a human reviewer\'s finding');
  });

  test('no CodeRabbit comment is edited, resolved or suppressed', () => {
    for (const verb of ['edit', 'resolve', 'minimise', 'hide', 'delete']) {
      expect([verb, flat.toLowerCase().includes(verb)]).toEqual([verb, true]);
    }
    expect(flat).toContain('never push a commit whose purpose is to make one disappear');
    // And the same rule is a standing safety rule, not only a step note.
    const safety = TEXT.slice(sectionIndex('## Safety rules')).replace(/\s+/g, ' ');
    expect(safety).toContain('A review bot\'s own comments are read-only');
  });
});

describe('TRD-040: a runtime without subagents reviews once, visibly reduced (AC-006-4)', () => {
  const step = section('**Degraded mode: a runtime with no subagents', 'A `verification: \'blocked\'` result');
  const flat = step.replace(/\s+/g, ' ');

  test('a single-pass review still runs -- the review is never skipped', () => {
    expect(flat).toContain('do not skip the review and do not pretend it ran');
    expect(flat).toContain('perform a **single-pass review** of the whole `range`');
  });

  test('verificationCapability: false is passed, and the module degrades every finding', () => {
    expect(flat).toContain('`verificationCapability: false`');
    const result = tallyVotes({ depth: 'standard', findings: [candidate()], verificationCapability: false });
    expect(result.verification).toBe('not-performed');
    expect(result.findings[0].outcome).toBe('unverified');
    expect(result.findings[0].reason).toBe('no-subagent-capability');
    expect(result.presented.map((entry) => entry.id)).toContain('F1');
    expect(result.recoveryAction).toBe('re-run-verification');
  });

  test('the report and the state report both carry a visible reduced-review notice', () => {
    expect(flat).toContain('visible reduced-review notice');
    expect(flat).toContain('in the report *and* in the state report');
    expect(step).toContain('REDUCED REVIEW:');
    expect(step).toContain('no subagent capability');
    expect(step).toContain('verification: not-performed, reason: no-subagent-capability');
    expect(step).toContain('Re-run this review on a runtime with subagents before relying on it.');
    expect(flat).toContain('never omitted because the findings look clean');
    expect(flat).toContain('a reduced review is never reported as a verified one');
  });

  test('Step 9 records the verification word and the notice in the state report', () => {
    const state = section('**What the report records about verification', '## Safety rules').replace(/\s+/g, ' ');
    expect(state).toContain('`performed`, `partial`, `not-performed` or `blocked`');
    expect(state).toContain('under `reducedReview`');
    expect(state).toContain('whenever that word is not `performed`');
    // The exact shape the module reports, so the recorded word is a real one.
    const degraded = tallyVotes({ depth: 'standard', findings: [candidate()], verificationCapability: false });
    expect(['performed', 'partial', 'not-performed', 'blocked']).toContain(degraded.verification);
  });

  test('the degraded path is a standing safety rule too', () => {
    const safety = TEXT.slice(sectionIndex('## Safety rules')).replace(/\s+/g, ' ');
    expect(safety).toContain('A review that could not be verified is reported as reduced, never as clean');
    expect(safety).toContain('no finding is dropped to make a degraded round look complete');
  });
});
