'use strict';

/**
 * Tests for the findings-as-beads planner (packages/development/lib/pr-review-beads.js, kata n350,
 * docs/plans/pr-review-speedup-plan.md section 3H item 1 and acceptance test (b)).
 *
 * Pure module: every test hands it a ledger and the tracker's answer for each key
 * (`findByKey`'s result shape) and reads the plan back.
 */

const {
  reviewFindingKey,
  reviewGroupKey,
  beadKeys,
  planBeads,
  BEAD_LABEL,
  FOLLOW_ON_LABEL,
} = require('../lib/pr-review-beads');
const { COLLAPSE_THRESHOLD } = require('../lib/pr-review-disposition');

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const FIX_COMMIT = 'c'.repeat(40);

function finding(overrides = {}) {
  return {
    id: 'F-1',
    source: 'code-reviewer',
    locationOrLink: 'src/widget.js:12',
    severity: 'important',
    failureMode: 'Unchecked path join',
    disposition: 'fix',
    evidence: 'line 12 joins user input',
    originalTextOrLink: 'https://example.invalid/pr/1#r1',
    ...overrides,
  };
}

const nits = (count, file = 'src/same.js', overrides = {}) =>
  Array.from({ length: count }, (_, i) =>
    finding({ id: `N-${i + 1}`, severity: 'nit', locationOrLink: `${file}:${i + 1}`, failureMode: `nit number ${i + 1}`, ...overrides }));

function input(ledger, extra = {}) {
  return { repo: 'Acme/Widgets', prNumber: 7, headSha: HEAD, ledger, ...extra };
}

/** What `findByKey` says for every key when the tracker holds nothing. */
function empty(inp) {
  const keys = beadKeys(inp).keys;
  return Object.fromEntries(keys.map((key) => [key, { ok: true, found: false }]));
}

/** A tracker bead as `findByKey` returns it. */
function bead(id, overrides = {}) {
  return { ok: true, found: true, item: { id, status: 'open', labels: [BEAD_LABEL], title: 'old', description: 'old', priority: 9, ...overrides }, labels: overrides.labels || [BEAD_LABEL] };
}

/** The tracker as it would hold the beads the plan creates, so a second plan can be run against it. */
function afterCreate(plan, inp) {
  const keys = beadKeys(inp).keys;
  const held = Object.fromEntries(keys.map((key) => [key, { ok: true, found: false }]));
  plan.actions
    .filter((a) => a.action === 'create')
    .forEach((a, i) => {
      held[a.key] = {
        ok: true,
        found: true,
        item: { id: `bd-${i}`, status: 'open', title: a.create.title, description: a.create.description, priority: a.create.priority, labels: a.create.labels },
        labels: a.create.labels,
      };
    });
  return held;
}

const one = (plan, id) => plan.actions.find((a) => a.findingIds.includes(id));

describe('the dedupe key: repository, file and normalized claim', () => {
  const base = { repo: 'Acme/Widgets', file: 'src/a.js', claim: 'unchecked path::' };

  test('the same claim in the same file is one key, whatever the case of the repo or the spelling of the file', () => {
    const key = reviewFindingKey(base);
    expect(key).toMatch(/^pr-review:v1:acme\/widgets:[0-9a-f]{32}$/);
    expect(reviewFindingKey({ ...base, repo: 'acme/widgets' })).toBe(key);
    expect(reviewFindingKey({ ...base, file: './src/a.js' })).toBe(key);
    expect(reviewFindingKey({ ...base, file: 'src\\a.js' })).toBe(key);
  });

  test('another repository, file or claim is another key', () => {
    const key = reviewFindingKey(base);
    expect(reviewFindingKey({ ...base, repo: 'acme/other' })).not.toBe(key);
    expect(reviewFindingKey({ ...base, file: 'src/b.js' })).not.toBe(key);
    expect(reviewFindingKey({ ...base, claim: 'unchecked read::' })).not.toBe(key);
  });

  test('a repository or claim that cannot be read gives no key, never a key shared with others', () => {
    expect(reviewFindingKey({ ...base, repo: 'acme widgets' })).toBeNull();
    expect(reviewFindingKey({ ...base, repo: '' })).toBeNull();
    expect(reviewFindingKey({ ...base, claim: '  ' })).toBeNull();
    expect(reviewFindingKey({ ...base, file: 7 })).toBeNull();
    expect(reviewGroupKey({ repo: 'acme/widgets', file: 'src/a.js', group: 'important' })).toBeNull();
  });

  test('a collapsed bead can never be mistaken for a finding bead', () => {
    expect(reviewGroupKey({ repo: 'acme/widgets', file: 'src/a.js', group: 'nit' })).toMatch(/:group:/);
    expect(reviewGroupKey({ repo: 'acme/widgets', file: 'src/a.js', group: 'nit' })).not.toBe(reviewFindingKey(base));
  });

  test('the key ignores the line, the wording of the claim and the PR: a defect that moved is the same bead', () => {
    const a = beadKeys(input([finding({ locationOrLink: 'src/widget.js:12', failureMode: 'Unchecked path join' })])).keys;
    const b = beadKeys({ ...input([finding({ locationOrLink: 'src/widget.js:91', failureMode: '  unchecked   PATH join. ' })]), prNumber: 99, headSha: NEXT_HEAD }).keys;
    expect(a).toEqual(b);
  });

  test('two findings with one claim in one file share one bead', () => {
    const ledger = [finding({ id: 'A', locationOrLink: 'src/widget.js:10' }), finding({ id: 'B', locationOrLink: 'src/widget.js:40' })];
    expect(beadKeys(input(ledger)).keys).toHaveLength(1);
    const plan = planBeads(input(ledger), empty(input(ledger)));
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].findingIds).toEqual(['A', 'B']);
    expect(plan.actions[0].create.description).toContain('src/widget.js:10');
    expect(plan.actions[0].create.description).toContain('src/widget.js:40');
  });
});

describe('re-review updates beads and never duplicates them (acceptance test b)', () => {
  const ledger = [
    finding({ id: 'F-1' }),
    finding({ id: 'F-2', severity: 'nit', locationOrLink: 'src/other.js:3', failureMode: 'stray log' }),
  ];

  test('the first review creates one bead per finding with the pr-review label, priority and key', () => {
    const plan = planBeads(input(ledger), empty(input(ledger)));
    expect(plan.ok).toBe(true);
    expect(plan.counts).toMatchObject({ create: 2, update: 0, close: 0 });
    const important = one(plan, 'F-1').create;
    expect(important).toMatchObject({ type: 'bug', priority: 1, labels: [BEAD_LABEL], key: one(plan, 'F-1').key });
    expect(important.title).toBe('[important] src/widget.js: Unchecked path join');
    expect(one(plan, 'F-2').create).toMatchObject({ type: 'chore', priority: 3, labels: [BEAD_LABEL] });
  });

  test('the bead carries the claim, location, votes, state report, PR number and head', () => {
    const votes = { ok: true, findings: [{ id: 'F-1', outcome: 'present', presented: true, tally: { real: 2, notReal: 1, abstain: 0, expected: 3, needed: 2 } }] };
    const plan = planBeads(input(ledger, { votes, reportLink: '.ensemble/pr-review/pr-7.json' }), empty(input(ledger)));
    const { description } = one(plan, 'F-1').create;
    expect(description).toContain('Claim: Unchecked path join');
    expect(description).toContain('src/widget.js:12');
    expect(description).toContain('2 real / 1 not-real of 3 expected (present)');
    expect(description).toContain('State report: .ensemble/pr-review/pr-7.json');
    expect(description).toContain(`PR #7 at head ${HEAD}`);
  });

  test('a later head UPDATES the existing beads and creates none', () => {
    const first = planBeads(input(ledger), empty(input(ledger)));
    const held = afterCreate(first, input(ledger));
    const later = input(ledger, { headSha: NEXT_HEAD, prNumber: 8 });
    const second = planBeads(later, held);

    expect(second.counts).toMatchObject({ create: 0, update: 2, close: 0, error: 0 });
    expect(second.actions.every((a) => a.action === 'update')).toBe(true);
    expect(one(second, 'F-1').update.id).toBe('bd-0');
    expect(one(second, 'F-1').update.description).toContain(`at head ${NEXT_HEAD}`);
    expect(one(second, 'F-1').update.note).toContain(`Re-confirmed at head ${NEXT_HEAD} (PR #8)`);
  });

  test('an unchanged finding at the SAME head is left alone: no update, no new note', () => {
    const first = planBeads(input(ledger), empty(input(ledger)));
    const again = planBeads(input(ledger), afterCreate(first, input(ledger)));
    expect(again.counts).toMatchObject({ create: 0, update: 0, close: 0, skip: 2 });
    expect(again.actions.map((a) => a.reason)).toEqual(['unchanged', 'unchanged']);
  });

  test('a finding that moved to another line is the same bead, updated with the new line', () => {
    const first = planBeads(input(ledger), empty(input(ledger)));
    const moved = input([finding({ id: 'F-9', locationOrLink: 'src/widget.js:88' }), ledger[1]], { headSha: NEXT_HEAD });
    const plan = planBeads(moved, afterCreate(first, input(ledger)));
    expect(plan.counts.create).toBe(0);
    expect(one(plan, 'F-9')).toMatchObject({ action: 'update', beadId: 'bd-0' });
    expect(one(plan, 'F-9').update.description).toContain('src/widget.js:88');
  });

  test('a bead the tracker lacks a pr-review label on gets it, without rewriting the fields', () => {
    const first = planBeads(input([ledger[0]]), empty(input([ledger[0]])));
    const held = afterCreate(first, input([ledger[0]]));
    const key = first.actions[0].key;
    held[key].item.labels = ['triaged'];
    const plan = planBeads(input([ledger[0]]), held);
    expect(plan.actions[0]).toMatchObject({ action: 'update', reason: 'labels', addLabels: [BEAD_LABEL] });
    expect(plan.actions[0].update).toBeUndefined();
  });
});

describe('a fix closes the bead, and only a fix does', () => {
  const fixed = (overrides = {}) => finding({ cleared: true, clearedBy: FIX_COMMIT, clearedReason: 'location-changed', ...overrides });

  test('a cleared finding closes its open bead with the clearing commit and a reason that names the PR', () => {
    const inp = input([fixed()]);
    const key = beadKeys(inp).keys[0];
    const plan = planBeads(inp, { [key]: bead('bd-1') });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ action: 'close', beadId: 'bd-1', close: { id: 'bd-1', commit: FIX_COMMIT } });
    expect(plan.actions[0].close.reason).toContain(FIX_COMMIT);
    expect(plan.actions[0].close.reason).toContain('Acme/Widgets'.toLowerCase());
    expect(plan.actions[0].close.reason).toContain('PR #7');
  });

  test('no commit, no close: a cleared mark without a commit id never closes a bead', () => {
    for (const clearedBy of [undefined, '', 'not-a-sha', 'main']) {
      const inp = input([finding({ cleared: true, clearedBy })]);
      // Nothing about this finding can be matched to a bead, so there is nothing to look up either.
      expect(beadKeys(inp).keys).toEqual([]);
      const plan = planBeads(inp, {});
      expect(plan.ok).toBe(true);
      expect(plan.counts.close).toBe(0);
      expect(plan.actions[0]).toMatchObject({ action: 'skip', reason: 'cleared-without-commit' });
    }
  });

  test('a finding that is merely absent from the ledger closes nothing (absence is not a fix)', () => {
    const inp = input([finding({ id: 'F-other', failureMode: 'something else entirely' })]);
    const plan = planBeads(inp, empty(inp));
    expect(plan.counts.close).toBe(0);
  });

  test('an already closed bead and a fix with no bead are skipped, not closed again or created', () => {
    const inp = input([fixed()]);
    const key = beadKeys(inp).keys[0];
    expect(planBeads(inp, { [key]: bead('bd-1', { status: 'closed' }) }).actions[0]).toMatchObject({ action: 'skip', reason: 'already-closed', beadId: 'bd-1' });
    expect(planBeads(inp, { [key]: { ok: true, found: false } }).actions[0]).toMatchObject({ action: 'skip', reason: 'fixed-without-bead' });
  });

  test('a claim that is still live at another location does not close the bead', () => {
    const inp = input([fixed({ id: 'A' }), finding({ id: 'B', locationOrLink: 'src/widget.js:70' })]);
    const key = beadKeys(inp).keys[0];
    const plan = planBeads(inp, { [key]: bead('bd-1') });
    expect(plan.counts.close).toBe(0);
    expect(plan.actions[0].action).toBe('update');
    expect(plan.actions[0].update.description).not.toContain('src/widget.js:12');
    expect(plan.actions[0].update.description).toContain('src/widget.js:70');
  });

  test('a live finding whose bead a person closed is reported, never re-created and never silently dropped', () => {
    const inp = input([finding()]);
    const key = beadKeys(inp).keys[0];
    const plan = planBeads(inp, { [key]: bead('bd-1', { status: 'closed' }) });
    expect(plan.counts.create).toBe(0);
    expect(plan.byFinding['F-1']).toMatchObject({ action: 'skip', reason: 'bead-closed', beadId: 'bd-1' });
  });
});

describe('which findings are recorded', () => {
  test('every finding gets a verdict: filtered, duplicate, not-applicable and unkeyable ones are named skips, not omissions', () => {
    const ledger = [
      finding({ id: 'live' }),
      finding({ id: 'filtered', failureMode: 'filtered claim' }),
      finding({ id: 'dup', failureMode: 'dup claim', disposition: 'duplicate' }),
      finding({ id: 'na', failureMode: 'na claim', disposition: 'not-applicable' }),
      finding({ id: 'blank', failureMode: '!!!' }),
    ];
    const votes = { ok: true, findings: [{ id: 'filtered', outcome: 'filtered', presented: false, tally: { real: 0, notReal: 3, abstain: 0, expected: 3 } }] };
    const plan = planBeads(input(ledger, { votes }), empty(input(ledger)));
    expect(Object.keys(plan.byFinding).sort()).toEqual(['blank', 'dup', 'filtered', 'live', 'na']);
    expect(plan.byFinding.live.action).toBe('create');
    expect(plan.byFinding.filtered.reason).toBe('filtered');
    expect(plan.byFinding.dup.reason).toBe('not-recorded:duplicate');
    expect(plan.byFinding.na.reason).toBe('not-recorded:not-applicable');
    expect(plan.byFinding.blank.reason).toBe('unkeyable');
    expect(plan.counts.create).toBe(1);
  });

  test('unverified and disputed findings are recorded and say so, because the operator list shows them', () => {
    const ledger = [finding({ id: 'U' }), finding({ id: 'D', failureMode: 'disputed claim' })];
    const votes = {
      ok: true,
      findings: [
        { id: 'U', outcome: 'unverified', presented: true, reason: 'verifier-incomplete', tally: { real: 1, notReal: 0, abstain: 0, expected: 3 } },
        { id: 'D', outcome: 'disputed', presented: true, tally: { real: 1, notReal: 2, abstain: 0, expected: 3 } },
      ],
    };
    const plan = planBeads(input(ledger, { votes }), empty(input(ledger)));
    expect(plan.counts.create).toBe(2);
    expect(one(plan, 'U').create.description).toContain('(unverified)');
    expect(one(plan, 'D').create.description).toContain('(disputed)');
  });

  test('a finding with no vote record is still recorded, marked as not recorded', () => {
    const plan = planBeads(input([finding()]), empty(input([finding()])));
    expect(plan.actions[0].create.description).toContain('[not recorded]');
  });

  test('a security-lane finding is recorded as security at the highest bead priority, whatever its severity word', () => {
    const lane = finding({ id: 'S-1', severity: 'pre-existing', failureMode: 'ligature fold', locationOrLink: 'src/p.js:192' });
    const inp = input([], { security: { status: 'findings', findings: [lane] } });
    const plan = planBeads(inp, empty(inp));
    expect(plan.actions[0].create).toMatchObject({ priority: 1, type: 'bug' });
    expect(plan.actions[0].create.title).toMatch(/^\[pre-existing, security\]/);
  });

  test('credential-shaped text is redacted before it reaches a bead title or description', () => {
    const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const plan = planBeads(input([finding({ failureMode: `leaks ${secret} to logs`, evidence: `token ${secret}` })]), empty(input([finding({ failureMode: `leaks ${secret} to logs` })])));
    const created = plan.actions[0].create;
    expect(created.title).not.toContain(secret);
    expect(created.description).not.toContain(secret);
    expect(created.description).toContain('[REDACTED]');
  });
});

describe('Nits and Pre-existing findings collapse per file (threshold shared with the operator list)', () => {
  test('the threshold is the operator list\'s own: more than COLLAPSE_THRESHOLD collapse, exactly that many do not', () => {
    const atThreshold = input(nits(COLLAPSE_THRESHOLD));
    expect(planBeads(atThreshold, empty(atThreshold)).counts.create).toBe(COLLAPSE_THRESHOLD);

    const over = input(nits(COLLAPSE_THRESHOLD + 1));
    const plan = planBeads(over, empty(over));
    expect(plan.counts.create).toBe(1);
    expect(plan.actions[0].findingIds).toHaveLength(COLLAPSE_THRESHOLD + 1);
    expect(plan.actions[0].create.title).toBe(`[nit] src/same.js: ${COLLAPSE_THRESHOLD + 1} Nit findings (collapsed)`);
    expect(plan.actions[0].key).toMatch(/:group:/);
    // Every member is mapped to the one bead's key.
    expect(new Set(Object.values(plan.byFinding).map((v) => v.key)).size).toBe(1);
  });

  test('Nits and Pre-existing findings of one file are two groups, each counted on its own', () => {
    const preExisting = nits(COLLAPSE_THRESHOLD, 'src/same.js', { severity: 'pre-existing' }).map((f, i) => ({ ...f, id: `P-${i}`, failureMode: `old problem ${i}` }));
    const ledger = [...nits(COLLAPSE_THRESHOLD), ...preExisting];
    const plan = planBeads(input(ledger), empty(input(ledger)));
    expect(plan.counts.create).toBe(COLLAPSE_THRESHOLD * 2);
  });

  test('another file is another bead', () => {
    const ledger = [...nits(COLLAPSE_THRESHOLD + 1), ...nits(COLLAPSE_THRESHOLD + 1, 'src/elsewhere.js').map((f, i) => ({ ...f, id: `E-${i}` }))];
    expect(planBeads(input(ledger), empty(input(ledger))).counts.create).toBe(2);
  });

  test('Important and security findings are never collapsed, however many share a file', () => {
    const important = Array.from({ length: COLLAPSE_THRESHOLD + 2 }, (_, i) => finding({ id: `I-${i}`, failureMode: `distinct claim ${i}` }));
    expect(planBeads(input(important), empty(input(important))).counts.create).toBe(important.length);

    const security = nits(COLLAPSE_THRESHOLD + 2, 'src/sec.js', { security: true });
    expect(planBeads(input(security), empty(input(security))).counts.create).toBe(security.length);
  });

  test('a finding that already has its own bead keeps it: it is updated, never folded into the collapsed bead', () => {
    const ledger = nits(COLLAPSE_THRESHOLD + 1);
    const lookups = empty(input(ledger));
    const ownKey = reviewFindingKey({ repo: 'acme/widgets', file: 'src/same.js', claim: 'nit number 1::' });
    lookups[ownKey] = bead('bd-own');
    const plan = planBeads(input(ledger), lookups);
    expect(plan.byFinding['N-1']).toMatchObject({ action: 'update', beadId: 'bd-own' });
    expect(plan.byFinding['N-2'].action).toBe('create');
    expect(plan.byFinding['N-2'].key).toMatch(/:group:/);
    expect(plan.actions.filter((a) => a.action === 'create')).toHaveLength(1);
  });

  test('once a file has a collapsed bead the choice is sticky: fewer findings still join it, none get their own bead', () => {
    const big = input(nits(COLLAPSE_THRESHOLD + 1));
    const first = planBeads(big, empty(big));
    const held = afterCreate(first, big);

    const small = input(nits(2), { headSha: NEXT_HEAD });
    const heldSmall = Object.fromEntries(beadKeys(small).keys.map((key) => [key, held[key] || { ok: true, found: false }]));
    const plan = planBeads(small, heldSmall);
    expect(plan.counts.create).toBe(0);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ action: 'update', key: first.actions[0].key });
    expect(plan.actions[0].update.title).toBe('[nit] src/same.js: 2 Nit findings (collapsed)');
  });

  test('re-review of an unchanged collapsed file is a no-op', () => {
    const big = input(nits(COLLAPSE_THRESHOLD + 1));
    const first = planBeads(big, empty(big));
    const again = planBeads(big, afterCreate(first, big));
    expect(again.counts).toMatchObject({ create: 0, update: 0, close: 0 });
    expect(again.actions[0]).toMatchObject({ action: 'skip', reason: 'unchanged' });
  });

  test('the collapsed bead closes only when every finding that joined it is fixed', () => {
    const big = input(nits(COLLAPSE_THRESHOLD + 1));
    const first = planBeads(big, empty(big));
    const held = afterCreate(first, big);
    const fixedAll = nits(COLLAPSE_THRESHOLD + 1).map((f) => ({ ...f, cleared: true, clearedBy: FIX_COMMIT }));
    const lookupsFor = (inp) => Object.fromEntries(beadKeys(inp).keys.map((key) => [key, held[key] || { ok: true, found: false }]));

    const all = input(fixedAll, { headSha: NEXT_HEAD });
    const closed = planBeads(all, lookupsFor(all));
    expect(closed.counts).toMatchObject({ close: 1, create: 0 });
    expect(closed.actions[0].close).toMatchObject({ commit: FIX_COMMIT, id: 'bd-0' });
    expect(closed.actions[0].findingIds).toHaveLength(COLLAPSE_THRESHOLD + 1);

    const some = input([...fixedAll.slice(0, 2), ...nits(COLLAPSE_THRESHOLD + 1).slice(2)], { headSha: NEXT_HEAD });
    const partial = planBeads(some, lookupsFor(some));
    expect(partial.counts.close).toBe(0);
    expect(partial.byFinding['N-1']).toMatchObject({ action: 'skip', reason: 'collapsed-member-fixed', beadId: 'bd-0' });
    expect(partial.actions.find((a) => a.action === 'update').update.description).not.toContain('nit number 1');
  });

  test('a collapsed bead is rendered with every member listed, capped for very large groups', () => {
    const many = input(nits(60));
    const plan = planBeads(many, empty(many));
    const { description } = plan.actions[0].create;
    expect(description).toContain('nit number 1 ');
    expect(description).toContain('- ... and 10 more');
  });
});

describe('labels: follow-on is the operator\'s choice, applied only to the findings they named', () => {
  test('a new bead for a named finding is created with follow-on; the others are not', () => {
    const ledger = [finding({ id: 'A', failureMode: 'claim a' }), finding({ id: 'B', failureMode: 'claim b' })];
    const inp = input(ledger, { followOnIds: ['A'] });
    const plan = planBeads(inp, empty(inp));
    expect(one(plan, 'A').create.labels).toEqual([BEAD_LABEL, FOLLOW_ON_LABEL]);
    expect(one(plan, 'B').create.labels).toEqual([BEAD_LABEL]);
  });

  test('the operator choosing follow-on AFTER the bead exists labels it without touching its fields', () => {
    const ledger = [finding({ id: 'A' })];
    const first = planBeads(input(ledger), empty(input(ledger)));
    const held = afterCreate(first, input(ledger));
    const after = planBeads(input(ledger, { followOnIds: ['A'] }), held);
    expect(after.actions[0]).toMatchObject({ action: 'update', reason: 'labels', addLabels: [FOLLOW_ON_LABEL], beadId: 'bd-0' });
    expect(after.actions[0].update).toBeUndefined();
    // And once labelled, the next run is a no-op.
    held[first.actions[0].key].item.labels = [BEAD_LABEL, FOLLOW_ON_LABEL];
    expect(planBeads(input(ledger, { followOnIds: ['A'] }), held).actions[0].reason).toBe('unchanged');
  });

  test('numeric ids work, and an id nobody named never gets the label', () => {
    const ledger = [finding({ id: 7 }), finding({ id: 8, failureMode: 'other claim' })];
    const inp = input(ledger, { followOnIds: [7] });
    const plan = planBeads(inp, empty(inp));
    expect(one(plan, '7').create.labels).toContain(FOLLOW_ON_LABEL);
    expect(one(plan, '8').create.labels).not.toContain(FOLLOW_ON_LABEL);
  });

  test('a collapsed bead gets follow-on only when every finding in it was chosen', () => {
    const ledger = nits(COLLAPSE_THRESHOLD + 1);
    const all = input(ledger, { followOnIds: ledger.map((f) => f.id) });
    expect(planBeads(all, empty(all)).actions[0].create.labels).toContain(FOLLOW_ON_LABEL);
    const most = input(ledger, { followOnIds: ledger.slice(1).map((f) => f.id) });
    expect(planBeads(most, empty(most)).actions[0].create.labels).toEqual([BEAD_LABEL]);
  });
});

describe('fail closed', () => {
  const lookupsOf = (inp) => empty(inp);

  test.each([
    ['no input', undefined],
    ['a repo with whitespace', { ...input([finding()]), repo: 'acme widgets' }],
    ['no repo', { ...input([finding()]), repo: undefined }],
    ['a PR number that is not a positive integer', { ...input([finding()]), prNumber: '7' }],
    ['a head that is not a hex commit id', { ...input([finding()]), headSha: 'main' }],
    ['a ledger that is not an array', { ...input([finding()]), ledger: {} }],
    ['a finding that is not an object', input(['x'])],
    ['a finding with no id', input([{ ...finding(), id: undefined }])],
    ['security that is not an object', { ...input([finding()]), security: 'clean' }],
    ['security findings that are not an array', { ...input([finding()]), security: { findings: 'x' } }],
    ['votes that are not a votes result', { ...input([finding()]), votes: [] }],
    ['followOnIds that are not an array', { ...input([finding()]), followOnIds: 'A' }],
    ['a reportLink that is not text', { ...input([finding()]), reportLink: 3 }],
  ])('%s is refused with a reason and no action', (_name, bad) => {
    const keys = beadKeys(bad);
    expect(keys.ok).toBe(false);
    expect(keys.keys).toEqual([]);
    const plan = planBeads(bad, {});
    expect(plan).toMatchObject({ ok: false, actions: [], byFinding: {} });
    expect(typeof plan.reason).toBe('string');
  });

  test('a lookup missing for a key the plan needs is refused, never read as "not found"', () => {
    const inp = input([finding()]);
    expect(planBeads(inp, {})).toMatchObject({ ok: false, actions: [] });
    expect(planBeads(inp, {}).reason).toMatch(/no lookup result for key/);
    expect(planBeads(inp, null).ok).toBe(false);
  });

  test('a collapsed file whose group key was not looked up is refused too', () => {
    const inp = input(nits(COLLAPSE_THRESHOLD + 1));
    const lookups = empty(inp);
    delete lookups[beadKeys(inp).keys.find((key) => key.includes(':group:'))];
    expect(planBeads(inp, lookups).ok).toBe(false);
  });

  test('two beads sharing a key (AMBIGUOUS_KEY) are an error action: nothing is created or written for it', () => {
    const inp = input([finding()]);
    const key = beadKeys(inp).keys[0];
    const plan = planBeads(inp, { [key]: { ok: false, error: { code: 'AMBIGUOUS_KEY', message: 'two', ids: ['a', 'b'] } } });
    expect(plan.ok).toBe(true);
    expect(plan.actions[0]).toMatchObject({ action: 'error', reason: 'ambiguous-key' });
    expect(plan.counts).toMatchObject({ error: 1, create: 0, update: 0 });
  });

  test('a lookup that failed for a key is an error action, never a create', () => {
    const inp = input([finding()]);
    const key = beadKeys(inp).keys[0];
    const plan = planBeads(inp, { [key]: { ok: false, error: { code: 'TOOL_FAILED', message: 'x' } } });
    expect(plan.actions[0]).toMatchObject({ action: 'error', reason: 'lookup-failed' });
    expect(plan.counts.create).toBe(0);
  });

  test('the input is never modified', () => {
    const deepFreeze = (value) => {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
      }
      return value;
    };
    const frozen = deepFreeze(input([finding(), ...nits(COLLAPSE_THRESHOLD + 1)], { followOnIds: ['F-1'], votes: { ok: true, findings: [] } }));
    expect(() => planBeads(frozen, lookupsOf(frozen))).not.toThrow();
  });
});
