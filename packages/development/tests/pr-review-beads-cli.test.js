'use strict';

/**
 * Tests for the bead recorder's executor and CLI (packages/development/lib/pr-review-beads-cli.js,
 * kata n350, plan 3H item 1 and acceptance tests (b) and (d)).
 *
 * The tracker is an in-memory stand-in for `br` that keeps the behaviours the recorder depends on:
 * an external reference is unique across the whole workspace and `create` refuses a second bead
 * with it, `update` appends notes, `label` only adds, and `close` records its reason and commit.
 * The real beads adapter and a real `br` are exercised by scripts/tests/tracker-findings.test.js
 * (replayed captured output) and by the smoke run recorded in the kata comment.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { main, recordBeads } = require('../lib/pr-review-beads-cli');
const { evaluateGate } = require('../lib/pr-review-gate');
const { buildDispositionChoices, COLLAPSE_THRESHOLD } = require('../lib/pr-review-disposition');

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

const nits = (count, file = 'src/same.js') =>
  Array.from({ length: count }, (_, i) => finding({ id: `N-${i + 1}`, severity: 'nit', locationOrLink: `${file}:${i + 1}`, failureMode: `nit number ${i + 1}` }));

function payload(ledger, extra = {}) {
  return { repo: 'Acme/Widgets', prNumber: 7, headSha: HEAD, ledger, ...extra };
}

const WRITES = ['tracker.create-detailed', 'tracker.update-detailed', 'tracker.close-with-reason', 'tracker.label'];

/** An in-memory `br`: the deps `recordBeads` runs against. */
function fakeTracker({ fail = () => null } = {}) {
  const issues = [];
  const calls = [];
  const byId = (id) => issues.find((issue) => issue.id === id);
  return {
    issues,
    calls,
    writes: () => calls.filter((c) => WRITES.includes(c.capability)),
    run(capability, args) {
      calls.push({ capability, args });
      const failure = fail(capability, args);
      if (failure) return failure;
      switch (capability) {
        case 'tracker.find-by-key':
          return { ok: true, data: JSON.stringify({ issues: JSON.parse(JSON.stringify(issues)) }) };
        case 'tracker.create-detailed': {
          if (issues.some((issue) => issue.external_ref === args.externalKey)) {
            return { ok: false, error: { code: 'TOOL_FAILED', message: 'CONFIG_ERROR: external_ref already exists' } };
          }
          const issue = {
            id: `bd-${issues.length + 1}`,
            status: 'open',
            title: args.title,
            description: args.description,
            issue_type: args.type,
            priority: Number(args.priority),
            labels: args.labels.split(','),
            external_ref: args.externalKey,
            notes: '',
          };
          issues.push(issue);
          return { ok: true, data: { id: issue.id } };
        }
        case 'tracker.update-detailed': {
          const issue = byId(args.id);
          Object.assign(issue, { title: args.title, description: args.description, priority: Number(args.priority) });
          issue.notes += `${args.notes}\n`;
          return { ok: true, data: { id: issue.id } };
        }
        case 'tracker.close-with-reason': {
          const issue = byId(args.id);
          issue.status = 'closed';
          issue.close_reason = args.reason;
          issue.close_comment = `closed at commit ${args.commit}`;
          return { ok: true, data: { id: issue.id, status: 'closed' } };
        }
        case 'tracker.label': {
          const issue = byId(args.ids);
          for (const label of args.labels.split(',')) if (!issue.labels.includes(label)) issue.labels.push(label);
          return { ok: true, data: {} };
        }
        default:
          throw new Error(`unexpected capability ${capability}`);
      }
    },
  };
}

const UNAVAILABLE = { ok: false, unavailable: true, error: { code: 'UNAVAILABLE', message: "tracker is unavailable: no '.beads' workspace" } };

describe('re-review updates beads and creates none for an unchanged finding (acceptance test b)', () => {
  const ledger = [finding(), finding({ id: 'F-2', severity: 'nit', locationOrLink: 'src/other.js:3', failureMode: 'stray log' })];

  test('first review creates one bead per finding; the same review again writes nothing', () => {
    const tracker = fakeTracker();
    const first = recordBeads(payload(ledger), tracker);
    expect(first).toMatchObject({ ok: true, status: 'RECORDED', recorded: true, counts: { create: 2 } });
    expect(tracker.issues).toHaveLength(2);
    expect(tracker.issues[0]).toMatchObject({ labels: ['pr-review'], priority: 1, issue_type: 'bug' });
    expect(first.beads['F-1'].beadId).toBe('bd-1');
    expect(first.beads['F-2'].beadId).toBe('bd-2');

    const writesBefore = tracker.writes().length;
    const again = recordBeads(payload(ledger), tracker);
    expect(again).toMatchObject({ ok: true, status: 'RECORDED', counts: { create: 0, update: 0, close: 0, skip: 2 } });
    expect(tracker.writes()).toHaveLength(writesBefore);
    expect(again.beads['F-1'].beadId).toBe('bd-1');
  });

  test('a later head updates the same beads, appends one note each, and creates none', () => {
    const tracker = fakeTracker();
    recordBeads(payload(ledger), tracker);
    const later = recordBeads(payload(ledger, { headSha: NEXT_HEAD, prNumber: 8 }), tracker);
    expect(later).toMatchObject({ ok: true, counts: { create: 0, update: 2 } });
    expect(tracker.issues).toHaveLength(2);
    expect(tracker.issues[0].description).toContain(`at head ${NEXT_HEAD}`);
    expect(tracker.issues[0].notes).toBe(`Re-confirmed at head ${NEXT_HEAD} (PR #8): 1 location.\n`);
    expect(tracker.calls.filter((c) => c.capability === 'tracker.create-detailed')).toHaveLength(2);
  });

  test('the tracker is asked once for every key, however many findings there are', () => {
    const tracker = fakeTracker();
    recordBeads(payload([...ledger, ...nits(COLLAPSE_THRESHOLD + 3)]), tracker);
    expect(tracker.calls.filter((c) => c.capability === 'tracker.find-by-key')).toHaveLength(1);
  });

  test('a collapsed file is one bead that later heads update in place', () => {
    const tracker = fakeTracker();
    recordBeads(payload(nits(COLLAPSE_THRESHOLD + 2)), tracker);
    expect(tracker.issues).toHaveLength(1);
    expect(tracker.issues[0].title).toBe(`[nit] src/same.js: ${COLLAPSE_THRESHOLD + 2} Nit findings (collapsed)`);
    const later = recordBeads(payload(nits(COLLAPSE_THRESHOLD + 1), { headSha: NEXT_HEAD }), tracker);
    expect(later.counts).toMatchObject({ create: 0, update: 1 });
    expect(tracker.issues).toHaveLength(1);
    expect(tracker.issues[0].title).toContain(`${COLLAPSE_THRESHOLD + 1} Nit findings`);
  });

  test('a review with no findings at all records nothing and never touches the tracker', () => {
    const tracker = fakeTracker();
    expect(recordBeads(payload([]), tracker)).toMatchObject({ ok: true, status: 'RECORDED', counts: { create: 0 } });
    expect(tracker.calls).toEqual([]);
  });
});

describe('a finding verified fixed at a later head closes its bead with the commit (AC2)', () => {
  test('the bead is closed with a reason and the clearing commit; an already closed bead is not touched again', () => {
    const tracker = fakeTracker();
    recordBeads(payload([finding()]), tracker);

    const fixed = payload([finding({ cleared: true, clearedBy: FIX_COMMIT })], { headSha: NEXT_HEAD });
    const result = recordBeads(fixed, tracker);
    expect(result).toMatchObject({ ok: true, status: 'RECORDED', counts: { close: 1, create: 0 } });
    expect(tracker.issues[0]).toMatchObject({ status: 'closed', close_comment: `closed at commit ${FIX_COMMIT}` });
    expect(tracker.issues[0].close_reason).toContain('PR #7');
    expect(result.beads['F-1']).toMatchObject({ action: 'close', beadId: 'bd-1' });

    const writes = tracker.writes().length;
    expect(recordBeads(fixed, tracker).counts).toMatchObject({ close: 0, skip: 1 });
    expect(tracker.writes()).toHaveLength(writes);
  });

  test('a finding that is only missing from the next review leaves its bead open', () => {
    const tracker = fakeTracker();
    recordBeads(payload([finding()]), tracker);
    recordBeads(payload([finding({ id: 'F-9', failureMode: 'something unrelated' })], { headSha: NEXT_HEAD }), tracker);
    expect(tracker.issues[0].status).toBe('open');
  });
});

describe('follow-on is applied to the beads the operator named, after the fact too', () => {
  test('choosing follow-on once the beads exist adds the label to the existing bead and nothing else', () => {
    const tracker = fakeTracker();
    const ledger = [finding({ id: 'A', failureMode: 'claim a' }), finding({ id: 'B', failureMode: 'claim b' })];
    recordBeads(payload(ledger), tracker);
    const before = JSON.stringify(tracker.issues[0].description);

    const result = recordBeads(payload(ledger, { followOnIds: ['A'] }), tracker);
    expect(result.counts).toMatchObject({ update: 1, create: 0 });
    expect(tracker.issues[0].labels).toEqual(['pr-review', 'follow-on']);
    expect(tracker.issues[1].labels).toEqual(['pr-review']);
    expect(JSON.stringify(tracker.issues[0].description)).toBe(before);
    expect(tracker.calls.filter((c) => c.capability === 'tracker.update-detailed')).toHaveLength(0);
  });
});

describe('--foreman / non-interactive: beads are recorded, nothing is fixed or decided, the gate still refuses (acceptance test d, unit level)', () => {
  function gateInput(ledger) {
    return {
      headSha: HEAD,
      ledger,
      approvals: {
        ok: true, headSha: HEAD, satisfied: true, reason: 'required-approvals-present', tier: 'medium', humansRequired: 1,
        humansCounted: 1, approvedBy: ['human-a'], directedBy: null, ignored: [], refusals: [], reasons: [], warnings: [],
      },
      tier: { ok: true, tier: 'medium', effectiveTier: 'medium', humansRequired: 1, refusals: [], reasons: [], warnings: [] },
      description: { ok: true, missing: [], present: ['testing', 'risk', 'rollback'], empty: [], ready: true, warnings: [] },
      security: { status: 'clean', findings: [] },
    };
  }

  const deepFreeze = (value) => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    }
    return value;
  };

  test('a blocking Important finding gets its bead, the ledger is untouched, and the gate is still not mergeable', () => {
    const ledger = deepFreeze([finding(), finding({ id: 'N-1', severity: 'nit', locationOrLink: 'src/n.js:1', failureMode: 'a nit' })]);
    expect(evaluateGate(gateInput(ledger)).mergeable).toBe(false);

    const tracker = fakeTracker();
    const result = recordBeads(payload(ledger), tracker);
    expect(result.status).toBe('RECORDED');

    // Only the tracker was touched: no other capability, no fix, nothing that could decide a finding.
    expect(new Set(tracker.calls.map((c) => c.capability))).toEqual(new Set(['tracker.find-by-key', 'tracker.create-detailed']));
    // The ledger is exactly what it was: no resolution, no cleared mark (it is frozen, so a write would have thrown).
    expect(ledger.every((f) => f.resolution === undefined && f.cleared === undefined && f.beadId === undefined)).toBe(true);

    // The caller records the bead ids on the findings and asks the gate again: still refused.
    const withBeads = ledger.map((f) => ({ ...f, beadId: result.beads[f.id].beadId }));
    const verdict = evaluateGate(gateInput(withBeads));
    expect(verdict.mergeable).toBe(false);
    expect(verdict.findings.open).toEqual(['F-1']);

    // And the operator's list shows both findings, each with its bead.
    const list = buildDispositionChoices({ ledger: withBeads, headSha: HEAD });
    expect(list.ok).toBe(true);
    expect(list.dispositionChoices.map((e) => [e.id, e.beadId])).toEqual([['F-1', 'bd-1'], ['N-1', 'bd-2']]);
    expect(list.mergeConfirmation).toMatchObject({ openBeads: 2, findingsWithoutBead: 0, undecidedBlocking: ['F-1'] });
  });
});

describe('a repository with no usable tracker skips the beads, and the list is still shown', () => {
  test('an unavailable tracker is UNAVAILABLE with the skip fallback, exit-clean, and nothing was written', () => {
    const calls = [];
    const deps = { run: (capability) => (calls.push(capability), UNAVAILABLE) };
    const ledger = [finding()];
    const result = recordBeads(payload(ledger), deps);
    expect(result).toMatchObject({ ok: true, status: 'UNAVAILABLE', recorded: false, fallback: 'skip-finding-beads', beads: {} });
    expect(result.reason).toContain('no \'.beads\' workspace');
    expect(calls).toEqual(['tracker.find-by-key']);

    const list = buildDispositionChoices({ ledger, headSha: HEAD });
    expect(list.ok).toBe(true);
    expect(list.mergeConfirmation).toMatchObject({ openBeads: 0, findingsWithoutBead: 1 });
  });

  test('an adapter that finds beads but cannot create them is UNAVAILABLE, not a half-recorded run', () => {
    const tracker = fakeTracker({ fail: (capability) => (capability === 'tracker.create-detailed' ? UNAVAILABLE : null) });
    const result = recordBeads(payload([finding()]), tracker);
    expect(result).toMatchObject({ ok: true, status: 'UNAVAILABLE', recorded: false, fallback: 'skip-finding-beads' });
    expect(tracker.issues).toEqual([]);
  });
});

describe('failures are reported, never swallowed', () => {
  test('a tracker that cannot be read fails the run before any write', () => {
    const tracker = fakeTracker({ fail: (capability) => (capability === 'tracker.find-by-key' ? { ok: false, error: { code: 'TOOL_FAILED', message: 'br exploded' } } : null) });
    const result = recordBeads(payload([finding()]), tracker);
    expect(result).toMatchObject({ ok: false, status: 'FAILED', recorded: false });
    expect(result.reason).toContain('br exploded');
    expect(tracker.writes()).toEqual([]);
  });

  test('one failing create does not stop the others, and the run is PARTIAL with the failure named', () => {
    const tracker = fakeTracker({ fail: (capability, args) => (capability === 'tracker.create-detailed' && /boom/.test(args.title) ? { ok: false, error: { code: 'TOOL_FAILED', message: 'disk full' } } : null) });
    const ledger = [finding({ id: 'A', failureMode: 'claim a' }), finding({ id: 'B', failureMode: 'boom claim' }), finding({ id: 'C', failureMode: 'claim c' })];
    const result = recordBeads(payload(ledger), tracker);
    expect(result).toMatchObject({ ok: false, status: 'PARTIAL', recorded: false });
    expect(tracker.issues).toHaveLength(2);
    const failed = result.actions.filter((a) => a.ok === false);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ findingIds: ['B'], error: { code: 'TOOL_FAILED', message: 'disk full' } });
    expect(result.beads.A.beadId).toBe('bd-1');
    expect(result.beads.B.beadId).toBeUndefined();
    expect(result.beads.C.beadId).toBe('bd-2');
  });

  test('two beads sharing a key make that finding an error and write nothing for it; the rest are recorded', () => {
    const tracker = fakeTracker();
    recordBeads(payload([finding({ id: 'A', failureMode: 'claim a' })]), tracker);
    tracker.issues.push({ ...tracker.issues[0], id: 'bd-dup' });
    const ledger = [finding({ id: 'A', failureMode: 'claim a' }), finding({ id: 'B', failureMode: 'claim b' })];
    const result = recordBeads(payload(ledger, { headSha: NEXT_HEAD }), tracker);
    expect(result).toMatchObject({ ok: false, status: 'PARTIAL' });
    expect(result.actions.find((a) => a.findingIds.includes('A'))).toMatchObject({ action: 'error', reason: 'ambiguous-key' });
    expect(tracker.issues.find((i) => i.title.includes('claim b'))).toBeDefined();
    expect(tracker.issues[0].notes).toBe('');
  });

  test('bad input is FAILED with a reason and the tracker is never called', () => {
    const tracker = fakeTracker();
    for (const bad of [{ ...payload([finding()]), repo: 'a b' }, { ...payload([finding()]), headSha: 'main' }, { ...payload([finding()]), ledger: 'x' }]) {
      const result = recordBeads(bad, tracker);
      expect(result).toMatchObject({ ok: false, status: 'FAILED', recorded: false });
    }
    expect(tracker.calls).toEqual([]);
  });
});

describe('dryRun', () => {
  test('plans and reports the actions and changes nothing', () => {
    const tracker = fakeTracker();
    const result = recordBeads(payload([finding()]), tracker, { dryRun: true });
    expect(result).toMatchObject({ ok: true, status: 'PLANNED', recorded: false, counts: { create: 1 } });
    expect(result.actions[0].create.title).toContain('Unchecked path join');
    expect(tracker.writes()).toEqual([]);
  });
});

describe('main(): the process entry point', () => {
  const tempDirs = [];
  afterEach(() => {
    while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  });
  /** A directory `resolveProjectRootFlag` accepts as a repository root. */
  function fakeRepo() {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-beads-')));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    return dir;
  }

  function run(body, io = {}) {
    const out = [];
    const code = main({ readJson: () => body, emit: (value) => out.push(value), now: () => 0, ...io });
    return { code, out: out[0] };
  }

  test('records through the injected tracker, exits 0, and fills the state report link from the repo root', () => {
    const repo = fakeRepo();
    const tracker = fakeTracker();
    const { code, out } = run({ ...payload([finding()]), repoRoot: repo }, { deps: tracker });
    expect(code).toBe(0);
    expect(out).toMatchObject({ ok: true, status: 'RECORDED', wallMs: 0 });
    expect(tracker.issues[0].description).toContain(`State report: ${path.join(repo, '.ensemble', 'pr-review', 'pr-7.json')}`);
  });

  test('a PARTIAL run and a FAILED run exit 1; an UNAVAILABLE run exits 0', () => {
    const repo = fakeRepo();
    expect(run({ ...payload([finding()]), repoRoot: repo }, { deps: { run: () => UNAVAILABLE } }).code).toBe(0);
    expect(run({ ...payload([finding()]), repoRoot: repo }, { deps: fakeTracker({ fail: (c) => (c === 'tracker.create-detailed' ? { ok: false, error: { code: 'TOOL_FAILED', message: 'x' } } : null) }) }).code).toBe(1);
    expect(run({ ...payload([finding()]), repo: 'no good', repoRoot: repo }, { deps: fakeTracker() }).code).toBe(1);
  });

  test('a repoRoot that is not a git repository is refused before any tracker is resolved', () => {
    const notRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-beads-')));
    tempDirs.push(notRepo);
    const { code, out } = run({ ...payload([finding()]), repoRoot: notRepo });
    expect(code).toBe(1);
    expect(out).toMatchObject({ ok: false, status: 'FAILED' });
    expect(out.reason).toContain('not a git repository');
  });

  test('unreadable stdin and a payload that is not an object are FAILED, not thrown', () => {
    const readFail = () => {
      throw new SyntaxError('Unexpected token');
    };
    const bad = [];
    expect(main({ readJson: readFail, emit: (v) => bad.push(v), now: () => 0 })).toBe(1);
    expect(bad[0].reason).toContain('invalid JSON on stdin');
    expect(run([1, 2]).code).toBe(1);
    expect(run({ ...payload([finding()]), dryRun: 'yes' }, { deps: fakeTracker() }).code).toBe(1);
    expect(run({ ...payload([finding()]), repoRoot: '' }, { deps: fakeTracker() }).code).toBe(1);
  });

  test('without injected deps the tracker is resolved for the repository UNDER REVIEW and never from its own adapters', () => {
    const repo = fakeRepo();
    const trackerModule = require('../lib/tracker-findings');
    const tracker = fakeTracker();
    const spy = jest.spyOn(trackerModule, 'createToolchainDeps').mockReturnValue(tracker);
    try {
      const { code } = run({ ...payload([finding()]), repoRoot: repo, timeoutMs: 1234 });
      expect(code).toBe(0);
      // The tree is named explicitly (so it is not the current directory) and is untrusted: it supplies
      // config and a working directory, never the adapter that records its own findings.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({ projectRoot: repo, untrustedProjectRoot: true, timeoutMs: 1234 });
      expect(tracker.issues).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('dryRun through main changes nothing', () => {
    const repo = fakeRepo();
    const tracker = fakeTracker();
    const { code, out } = run({ ...payload([finding()]), repoRoot: repo, dryRun: true }, { deps: tracker });
    expect(code).toBe(0);
    expect(out.status).toBe('PLANNED');
    expect(tracker.writes()).toEqual([]);
  });

  test('credential-shaped text in the result is redacted on the way out', () => {
    const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const repo = fakeRepo();
    const written = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => (written.push(String(chunk)), true));
    try {
      main({ readJson: () => ({ ...payload([finding({ failureMode: `leaks ${secret}` })]), repoRoot: repo, dryRun: true }), deps: fakeTracker(), now: () => 0 });
    } finally {
      spy.mockRestore();
    }
    expect(written.join('')).not.toContain(secret);
    expect(written.join('')).toContain('[REDACTED]');
  });
});
