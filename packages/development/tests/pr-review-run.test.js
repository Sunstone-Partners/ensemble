'use strict';

/**
 * The light-mode review runner (kata znd1): prepareRun / collectRun over fake deps.
 *
 * Everything that talks to the outside is a fake that RECORDS what it was asked (gh reads, git argv, the precheck, the
 * prepare step, the state writer, the tracer). The two real parts are the result-file collector and the filesystem, in a
 * private scratch directory under ~/.omp/pr-review-speedup/znd1/scratch (never /tmp), because an agent's result is a file
 * and its change time is part of the contract. One test per fail-closed rule of the protocol: each one fails if its guard
 * is removed (the mutation table is in the kata report).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { prepareRun, collectRun, PREPARE_KEYS, COLLECT_KEYS } = require('../lib/pr-review-run');
const S = require('../lib/pr-review-run-support');
const { collectResults } = require('../lib/pr-review-results');
const { renderBriefFromFiles } = require('../lib/pr-review-brief-files');
const { classifyPaths } = require('../lib/pr-review-paths');
const { loadPolicy } = require('../lib/pr-review-policy');
const { realFs } = require('../lib/review-run-cli');
const { redact, statePath } = require('../lib/pr-review-state');

const SCRATCH = path.join(os.homedir(), '.omp', 'pr-review-speedup', 'znd1', 'scratch');
const HEAD = 'a'.repeat(40);
const MOVED = 'd'.repeat(40);
const BASE = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const GOOD_BODY = '## Testing\nran the relevant tests\n\n## Risk\nlow\n\n## How to revert\nrevert the commit\n';

let roots = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function makeFacts({ changedPaths, numstat, policyJson = {} }) {
  const text = `# Review\n\n\`\`\`ensemble-review-policy\n${JSON.stringify(policyJson)}\n\`\`\`\n`;
  const policy = loadPolicy({ text, baseSha: BASE, sourceSha: BASE });
  const declaration = { sourceSha: BASE, sensitive: policy.policy.sensitivePaths, high: policy.policy.highPaths };
  const paths = classifyPaths({ changedPaths, declaration, baseSha: BASE });
  return { schema: 2, baseSha: BASE, headSha: HEAD, changedPaths, numstat, policy, paths };
}

/**
 * A harness: scratch repo root, a prepared directory with facts/baseline, and fake deps with call logs.
 * `overrides` replaces any fake dep; `facts`/`baseline`/`rangeDiff` replace what the prepared directory holds.
 */
function harness({ changedPaths = ['src/a.js'], numstat, policyJson, facts, baseline, overrides = {}, prepareOverride, rangeDiff = 'diff --git a/x b/x\n' } = {}) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH, 'u-'));
  roots.push(root);
  const repoRoot = path.join(root, 'repo');
  const dir = path.join(root, 'prepared');
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(path.join(dir, 'snapshot'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'range.diff'), rangeDiff);
  const theFacts = facts === undefined ? makeFacts({ changedPaths, numstat: numstat || changedPaths.map((p) => ({ path: p, added: 10, deleted: 2 })), policyJson }) : facts;
  fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify(theFacts));
  const theBaseline = baseline === undefined ? { ran: false, reason: 'no-test-files', command: null, exitCode: null, timedOut: false, selection: [] } : baseline;
  fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify(theBaseline));

  const h = {
    root,
    repoRoot,
    head: HEAD,
    gitCalls: [],
    ghReads: [],
    precheckCalls: [],
    prepareCalls: [],
    stateWrites: [],
    spans: [],
    pr: { ok: true, headSha: HEAD, baseRefName: 'main', state: 'OPEN', body: GOOD_BODY, author: 'alice', isCrossRepository: false },
    reviews: { ok: true, reviews: [] },
    protection: { ok: true, notProtected: true },
  };
  let spanSeq = 0;
  h.deps = {
    now: () => Date.now(),
    redact,
    fs: realFs(),
    readPr: async () => {
      h.ghReads.push('readPr');
      return { ...h.pr, headSha: h.head };
    },
    readReviews: async () => {
      h.ghReads.push('readReviews');
      return h.reviews;
    },
    readProtection: async () => {
      h.ghReads.push('readProtection');
      return h.protection;
    },
    git: async (args) => {
      h.gitCalls.push(args);
      if (args[0] === 'merge-base') return { status: 0, stdout: `${BASE}\n`, stderr: '' };
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${TREE}\n`, stderr: '' };
      return { status: 1, stdout: '', stderr: 'unexpected git call' };
    },
    fetchRefs: async () => ({ ok: true }),
    precheck: async (opts) => {
      h.precheckCalls.push(opts);
      return { ok: true, headSha: HEAD, blockers: [], comment: { action: 'created', id: 1 } };
    },
    prepareReview: async (options) => {
      h.prepareCalls.push(options);
      if (prepareOverride) return prepareOverride(options);
      return {
        ok: true,
        status: 'PREPARED',
        reused: false,
        dir,
        manifestPath: path.join(dir, 'manifest.json'),
        headSha: options.headSha,
        baseSha: options.baseSha,
        mode: 'full',
        absent: {},
        artifacts: { snapshot: { path: path.join(dir, 'snapshot') }, 'range.diff': { path: path.join(dir, 'range.diff') }, 'facts.json': { path: path.join(dir, 'facts.json') }, 'baseline.json': { path: path.join(dir, 'baseline.json') } },
      };
    },
    collectResults: (input) => collectResults(input),
    renderBrief: (role, vars) => renderBriefFromFiles(role, vars),
    writeState: async (target, state) => {
      h.stateWrites.push({ target, state });
      return { ok: true, path: target };
    },
    makeTracer: () => ({
      startSpan: (name, opts) => {
        spanSeq += 1;
        h.spans.push({ type: 'start', id: spanSeq, name, kind: opts.kind });
        return spanSeq;
      },
      endSpan: (id, opts) => {
        h.spans.push({ type: 'end', id, status: opts.status });
        return true;
      },
    }),
    ...overrides,
  };
  h.prepare = (extra = {}) => prepareRun({ repo: 'o/r', pr: 7, repoRoot, runId: 'run1', agentAuthored: false, ...extra }, h.deps);
  h.collect = (extra = {}) => collectRun({ repoRoot, runId: extra.runId || 'run1', ...extra }, h.deps);
  h.runDir = (runId = 'run1') => path.join(repoRoot, '.ensemble', 'pr-review', 'run', runId);
  h.readRun = (runId) => JSON.parse(fs.readFileSync(path.join(h.runDir(runId), 'run.json'), 'utf8'));
  return h;
}

const writeResult = (agent, object) => {
  fs.mkdirSync(path.dirname(agent.outPath), { recursive: true });
  const temp = `${agent.outPath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(object));
  fs.renameSync(temp, agent.outPath);
};

const finding = (over = {}) => ({ locationOrLink: 'src/a.js:3', severity: 'important', failureMode: 'the loop reads past the end of the list', disposition: 'fix', evidence: 'src/a.js line 3 indexes list[list.length]', originalTextOrLink: 'src/a.js:3', ...over });

/** Writes every reviewer's result (all paths reviewed) and the lane's; `findingsFor(name)` may add findings. */
function answerReview(manifest, { findingsFor = () => [], skip = [], lane = { findings: [] }, partial = {} } = {}) {
  for (const agent of manifest.agents) {
    if (skip.includes(agent.name)) continue;
    if (agent.role === 'reviewer') writeResult(agent, { findings: findingsFor(agent.name), pathsReviewed: partial[agent.name] || agent.paths });
    else if (agent.role === 'security') writeResult(agent, { findings: lane.findings, pathsReviewed: lane.pathsReviewed || partial[agent.name] || (lane.all || []) });
  }
}

const allPaths = (h) => h.readRun().changedPaths;

/** prepare -> answer every agent -> collect. Returns {manifest, next}. */
async function reviewRound(h, options = {}) {
  const manifest = await h.prepare(options.prepare);
  expect(manifest.status).toBe('DISPATCH');
  const lane = options.lane || { findings: [], pathsReviewed: allPaths(h) };
  answerReview(manifest, { ...options, lane });
  const next = await h.collect(options.collect);
  return { manifest, next };
}

function voteAll(manifest, verdictFor = () => 'real', skip = []) {
  for (const agent of manifest.agents) {
    if (skip.includes(agent.name)) continue;
    writeResult(agent, { votes: agent.candidateIds.map((id) => ({ candidateId: id, verdict: verdictFor(agent.name, id), evidence: 'checked' })) });
  }
}

describe('prepare: the dispatch manifest', () => {
  test('a Medium PR dispatches two reviewers and the security lane with generated briefs and prompts', async () => {
    const h = harness();
    const m = await h.prepare();
    expect(m).toMatchObject({ ok: true, status: 'DISPATCH', runId: 'run1', round: 'review', wave: '1 of 1', headSha: HEAD, maxConcurrentAgents: 8 });
    expect(m.mode).toMatchObject({ mode: 'light', securityLane: true });
    expect(m.tier).toMatchObject({ tier: 'medium', effectiveTier: 'medium' });
    expect(m.depth).toMatchObject({ mode: 'standard', reviewersPerSlice: 2, verifiersPerCandidate: 3 });
    expect(m.agents.map((a) => [a.name, a.role])).toEqual([['reviewer-s1-a', 'reviewer'], ['reviewer-s1-b', 'reviewer'], ['security-lane', 'security']]);
    for (const a of m.agents) {
      expect(a.deadlineAt).toBeGreaterThan(a.dispatchedAt);
      expect(a.prompt).toContain(a.briefPath);
      expect(a.prompt).toContain(a.outPath);
      expect(a.prompt).toContain(a.deadlineAtIso);
      const brief = fs.readFileSync(a.briefPath, 'utf8');
      expect(brief).toContain('Output contract');
      expect(brief).not.toMatch(/\{\{/);
    }
    expect(fs.readFileSync(m.agents[0].briefPath, 'utf8')).toContain('src/a.js');
    expect(m.rules.join(' ')).toMatch(/cannot enforce/);
    expect(m.next).toContain('collect');
    // the run directory and its files are private
    expect(fs.statSync(h.runDir()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(h.runDir(), 'run.json')).mode & 0o777).toBe(0o600);
    expect(h.readRun().phase).toBe('review-dispatched');
  });

  test('the precheck runs first, before prepare, and is advisory when it fails', async () => {
    const order = [];
    const h = harness();
    const precheck = h.deps.precheck;
    h.deps.precheck = async (o) => {
      order.push('precheck');
      return precheck({ ...o }).then(() => ({ ok: false, stage: 'pr', error: 'the pull request is "MERGED", not OPEN' }));
    };
    const prepareReview = h.deps.prepareReview;
    h.deps.prepareReview = async (o) => {
      order.push('prepare');
      return prepareReview(o);
    };
    const m = await h.prepare();
    expect(order).toEqual(['precheck', 'prepare']);
    expect(m.status).toBe('DISPATCH');
    expect(m.precheck).toMatchObject({ ok: false, error: expect.stringContaining('MERGED') });
  });

  test('skipPrecheck skips it and says so; dryRun is passed through', async () => {
    const h = harness();
    const skipped = await h.prepare({ skipPrecheck: true });
    expect(h.precheckCalls).toEqual([]);
    expect(skipped.precheck).toEqual({ skipped: true, reason: 'requested' });
    const dry = harness();
    await dry.prepare({ dryRun: true });
    expect(dry.precheckCalls).toEqual([{ dryRun: true }]);
  });

  test('prepare is handed the merge base, the head and the passthrough options', async () => {
    const h = harness();
    await h.prepare({ lastReviewedSha: 'e'.repeat(40), remediationShas: ['f'.repeat(40)], testFiles: ['t/x.test.js'] });
    expect(h.prepareCalls[0]).toMatchObject({ repoRoot: h.repoRoot, runId: 'run1', baseSha: BASE, headSha: HEAD, lastReviewedSha: 'e'.repeat(40), remediationShas: ['f'.repeat(40)], testFiles: ['t/x.test.js'] });
    expect(h.gitCalls.some((a) => a[0] === 'merge-base')).toBe(true);
  });

  test('a stated baseSha is a check, not an override: it is accepted only when it IS the merge base (a base inside the PR would leave its earlier commits unreviewed and unreported)', async () => {
    const same = harness();
    await same.prepare({ baseSha: BASE });
    expect(same.prepareCalls[0].baseSha).toBe(BASE);
    expect(same.gitCalls.some((a) => a[0] === 'merge-base')).toBe(true);

    const inside = harness();
    const out = await inside.prepare({ baseSha: '9'.repeat(40) });
    expect(out).toMatchObject({ ok: false, status: 'RUN_FAILED', reason: 'base-not-merge-base' });
    expect(out.error).toContain('9'.repeat(40));
    expect(out.error).toContain(BASE);
    expect(inside.prepareCalls).toEqual([]);
    expect(fs.existsSync(path.join(inside.runDir(), 'run.json'))).toBe(false);
  });

  test('the base and the head are fetched even when the caller states the base', async () => {
    const h = harness();
    h.deps.fetchRefs = async () => ({ ok: false, error: 'network' });
    expect(await h.prepare({ baseSha: BASE })).toMatchObject({ ok: false, status: 'RUN_FAILED', reason: 'refs-unavailable' });
    expect(h.prepareCalls).toEqual([]);
  });

  test.each(['MERGED', 'CLOSED', 'open', undefined])('a PR whose state is %p is refused before anything runs (it was reviewed and answered mergeable before; review of PR 264, P2)', async (state) => {
    const h = harness();
    h.pr.state = state;
    const out = await h.prepare();
    expect(out).toMatchObject({ ok: false, status: 'RUN_FAILED', reason: 'pr-not-open', error: expect.stringContaining('not OPEN') });
    expect(h.precheckCalls).toEqual([]);
    expect(h.prepareCalls).toEqual([]);
    expect(h.gitCalls).toEqual([]);
    expect(fs.existsSync(path.join(h.repoRoot, '.ensemble'))).toBe(false);
  });

  test('the default run id names the PR, the head and the second; a run id that is not file-name safe is refused', async () => {
    const h = harness();
    const m = await prepareRun({ repo: 'o/r', pr: 7, repoRoot: h.repoRoot, agentAuthored: false }, h.deps);
    expect(m.runId).toMatch(/^pr7-aaaaaaaaaaaa-\d+$/);
    const bad = await prepareRun({ repo: 'o/r', pr: 7, repoRoot: h.repoRoot, runId: '../escape' }, h.deps);
    expect(bad).toMatchObject({ ok: false, status: 'RUN_FAILED', reason: 'invalid-runId' });
    const dotted = await prepareRun({ repo: 'o/r', pr: 7, repoRoot: h.repoRoot, runId: 'a.b' }, h.deps);
    expect(dotted.reason).toBe('invalid-runId');
  });

  test('an unknown payload key, a bad value and an existing run are refused', async () => {
    const h = harness();
    expect(await h.prepare({ dryrun: true })).toMatchObject({ ok: false, status: 'RUN_FAILED', reason: 'invalid-input', error: expect.stringContaining('dryrun') });
    expect(await h.prepare({ pr: 0 })).toMatchObject({ reason: 'invalid-input' });
    expect(await h.prepare({ baseSha: 'main' })).toMatchObject({ reason: 'invalid-input' });
    expect((await h.prepare()).status).toBe('DISPATCH');
    expect(await h.prepare()).toMatchObject({ ok: false, reason: 'run-exists' });
    expect(PREPARE_KEYS).toContain('stateRoot');
    expect(COLLECT_KEYS).toEqual(['repoRoot', 'runId', 'now', 'adjudications']);
    expect(await h.collect({ extra: 1 })).toMatchObject({ ok: false, reason: 'invalid-input' });
  });
});

describe('prepare: a head from outside this repository is refused before anything runs (review of PR 264, P0)', () => {
  const refused = async (isCrossRepository, reason) => {
    const h = harness();
    h.pr.isCrossRepository = isCrossRepository;
    let fetches = 0;
    h.deps.fetchRefs = async () => {
      fetches += 1;
      return { ok: true };
    };
    const out = await h.prepare();
    expect(out).toMatchObject({ ok: false, status: 'RUN_FAILED', reason, headSha: HEAD });
    expect(out.error).toMatch(/head/);
    // nothing was fetched, prepared (the baseline test run lives there), prechecked, classified or written
    expect(fetches).toBe(0);
    expect(h.prepareCalls).toEqual([]);
    expect(h.precheckCalls).toEqual([]);
    expect(h.gitCalls).toEqual([]);
    expect(h.stateWrites).toEqual([]);
    expect(h.ghReads).toEqual(['readPr']);
    expect(fs.existsSync(path.join(h.repoRoot, '.ensemble'))).toBe(false);
    return out;
  };

  test('a fork head', async () => {
    const out = await refused(true, 'cross-repository-head');
    expect(out.error).toMatch(/fork/);
  });

  test.each([[undefined], [null], ['false'], [0]])('a head whose repository is not stated as exactly `false` (%p) is not "this repository"', async (value) => {
    await refused(value, 'head-repository-unknown');
  });

  test('a head stated to be on this repository is prepared as before', async () => {
    const h = harness();
    h.pr.isCrossRepository = false;
    expect((await h.prepare()).status).toBe('DISPATCH');
    expect(h.prepareCalls).toHaveLength(1);
  });
});

describe('fail closed: the tier selects full mode and nothing is dispatched (AC4)', () => {
  const expectFull = async (h, reason) => {
    const out = await h.prepare();
    expect(out).toMatchObject({ ok: false, status: 'NEEDS_FULL_MODE', dispatched: [] });
    expect(out.reason).toMatch(reason);
    expect(out.mode.mode).toBe('full');
    const run = h.readRun();
    expect(run.phase).toBe('needs-full-mode');
    expect(run.waves).toEqual([]);
    expect(fs.existsSync(path.join(h.runDir(), 'briefs'))).toBe(false);
    expect(h.stateWrites).toEqual([]);
    // later calls repeat the answer and dispatch nothing
    expect(await h.collect()).toMatchObject({ ok: false, status: 'NEEDS_FULL_MODE' });
    return out;
  };

  test('a sensitive path', async () => {
    await expectFull(harness({ changedPaths: ['secure/key.js'], policyJson: { sensitivePaths: ['secure/**'] } }), /sensitive-path/);
  });

  test('an owner-declared High path', async () => {
    await expectFull(harness({ changedPaths: ['core/x.js'], policyJson: { highPaths: ['core/**'] } }), /high-path/);
  });

  test('an unreadable path classification (the tier module answers High and not ok)', async () => {
    const facts = makeFacts({ changedPaths: ['src/a.js'], numstat: [{ path: 'src/a.js', added: 1, deleted: 0 }] });
    delete facts.paths;
    await expectFull(harness({ facts }), /not-ok|tier-result-not-ok|unknown|unreadable|high/i);
  });

  test('a PR with no changed paths cites no kind: ambiguity is full, never light', async () => {
    await expectFull(harness({ changedPaths: [], numstat: [] }), /no-kinds-cited|uncited|unreadable/);
  });

  test('a brief the renderer refuses (a path with a space) cannot be reviewed mechanically: full mode', async () => {
    const h = harness({ changedPaths: ['src/a b.js'] });
    const out = await h.prepare();
    expect(out).toMatchObject({ ok: false, status: 'NEEDS_FULL_MODE', reason: expect.stringContaining('brief-refused') });
    expect(h.readRun().phase).toBe('needs-full-mode');
  });

  test('a prose-only PR is Low but not waived: Medium, light, standard depth', async () => {
    const h = harness({ changedPaths: ['docs/guide.md', 'README.md'] });
    const m = await h.prepare();
    expect(m.status).toBe('DISPATCH');
    expect(m.tier).toMatchObject({ tier: 'low', effectiveTier: 'medium' });
    expect(m.depth.mode).toBe('standard');
  });
});

describe('fail closed: a head that moves invalidates the run (AC4)', () => {
  test('moved between prepare and collect: RUN_INVALIDATED, nothing computed, and the answer is stable', async () => {
    const h = harness();
    const m = await h.prepare();
    answerReview(m, { lane: { findings: [], pathsReviewed: allPaths(h) } });
    h.head = MOVED;
    const out = await h.collect();
    expect(out).toMatchObject({ ok: false, status: 'RUN_INVALIDATED', reason: 'head-moved', expectedHead: HEAD, currentHead: MOVED });
    expect(h.stateWrites).toEqual([]);
    expect(fs.existsSync(path.join(h.runDir(), 'final.json'))).toBe(false);
    expect(h.readRun()).toMatchObject({ phase: 'invalidated' });
    expect(h.readRun().candidates).toBeUndefined();
    // terminal: even if the head moves back, the run stays invalid
    h.head = HEAD;
    expect(await h.collect()).toMatchObject({ ok: false, status: 'RUN_INVALIDATED' });
  });

  test('moved while prepare ran: RUN_INVALIDATED before anything is dispatched', async () => {
    const h = harness();
    const prepared = h.deps.prepareReview;
    h.deps.prepareReview = async (o) => {
      const result = await prepared(o);
      h.head = MOVED;
      return result;
    };
    const out = await h.prepare();
    expect(out).toMatchObject({ ok: false, status: 'RUN_INVALIDATED', reason: 'head-moved' });
    expect(h.readRun().waves).toEqual([]);
  });

  test('moved between dispatch and the gate (after the last wave): RUN_INVALIDATED, no ledger, gate, state or final', async () => {
    const h = harness();
    const m = await h.prepare();
    answerReview(m, { lane: { findings: [], pathsReviewed: allPaths(h) } });
    // the first head read (collect step 1) is still the old head; the read made for the gate is the moved one
    let reads = 0;
    h.deps.readPr = async () => {
      reads += 1;
      return { ...h.pr, headSha: reads === 1 ? HEAD : MOVED };
    };
    const out = await h.collect();
    expect(out).toMatchObject({ ok: false, status: 'RUN_INVALIDATED', reason: 'head-moved' });
    expect(reads).toBe(2);
    expect(h.stateWrites).toEqual([]);
    expect(fs.existsSync(path.join(h.runDir(), 'final.json'))).toBe(false);
    expect(h.readRun().phase).toBe('invalidated');
  });

  test('an unreadable head is RUN_FAILED without changing the phase, and a later call proceeds', async () => {
    const h = harness();
    const m = await h.prepare();
    answerReview(m, { lane: { findings: [], pathsReviewed: allPaths(h) } });
    const good = h.deps.readPr;
    h.deps.readPr = async () => ({ ok: false, error: 'gh: rate limited' });
    const out = await h.collect();
    expect(out).toMatchObject({ ok: false, status: 'RUN_FAILED', reason: 'head-unreadable' });
    expect(h.readRun().phase).toBe('review-dispatched');
    h.deps.readPr = good;
    expect((await h.collect()).status).toBe('DONE');
  });

  test('a head read that returns a malformed sha is unreadable, never "the same head"', async () => {
    const h = harness();
    await h.prepare();
    h.deps.readPr = async () => ({ ...h.pr, headSha: 'not-a-sha' });
    expect(await h.collect()).toMatchObject({ status: 'RUN_FAILED', reason: 'head-unreadable' });
  });
});

describe('fail closed: a PR that is no longer open gets no verdict (review of PR 264, P2)', () => {
  test('closed while the agents ran: collect refuses before collecting anything, records nothing, and a retry on a reopened PR proceeds', async () => {
    const h = harness();
    const m = await h.prepare();
    answerReview(m, { lane: { findings: [], pathsReviewed: allPaths(h) } });
    h.pr.state = 'CLOSED';
    const out = await h.collect();
    expect(out).toMatchObject({ ok: false, status: 'RUN_FAILED', reason: 'pr-not-open', prState: 'CLOSED', runId: 'run1' });
    expect(h.stateWrites).toEqual([]);
    expect(h.readRun().phase).toBe('review-dispatched');
    expect(h.readRun().waves[0].status).toBe('dispatched');
    h.pr.state = 'OPEN';
    expect((await h.collect()).status).toBe('DONE');
  });

  test('merged between the last wave and the gate: no verdict, no state report, no final.json; the phase is unchanged', async () => {
    const h = harness();
    const m = await h.prepare();
    answerReview(m, { lane: { findings: [], pathsReviewed: allPaths(h) } });
    // the first head read (collect step 1) still says OPEN; the read made for the gate says MERGED
    let reads = 0;
    h.deps.readPr = async () => {
      reads += 1;
      return { ...h.pr, headSha: HEAD, state: reads === 1 ? 'OPEN' : 'MERGED' };
    };
    const out = await h.collect();
    expect(out).toMatchObject({ ok: false, status: 'RUN_FAILED', reason: 'pr-not-open', prState: 'MERGED' });
    expect(reads).toBe(2);
    expect(h.stateWrites).toEqual([]);
    expect(fs.existsSync(path.join(h.runDir(), 'final.json'))).toBe(false);
    expect(h.readRun().phase).not.toBe('done');
  });
});

describe('collect: pending, expired and missing agents', () => {
  test('PENDING while an agent has not arrived and its deadline has not passed; nothing else changes', async () => {
    const h = harness();
    const m = await h.prepare();
    answerReview(m, { skip: ['reviewer-s1-b'], lane: { findings: [], pathsReviewed: allPaths(h) } });
    const out = await h.collect();
    expect(out).toMatchObject({ ok: true, status: 'PENDING', round: 'review', waitingOn: ['reviewer-s1-b'] });
    expect(out.retryAfterMs).toBeGreaterThanOrEqual(1000);
    expect(out.earliestDeadlineAt).toBe(m.agents[1].deadlineAt);
    const run = h.readRun();
    expect(run.phase).toBe('review-dispatched');
    expect(run.candidates).toBeUndefined();
    expect(run.calls.map((c) => c.call)).toEqual(['prepare', 'collect']);
  });

  test('a reviewer that never arrived: its slice is NOT reviewed, coverage is never complete, and it is named', async () => {
    const h = harness();
    const m = await h.prepare();
    answerReview(m, { skip: ['reviewer-s1-b'], lane: { findings: [], pathsReviewed: allPaths(h) } });
    const after = m.agents[1].deadlineAt + 1000;
    const out = await h.collect({ now: after });
    expect(out.status).toBe('DONE');
    expect(out.notReviewed.unreviewedSlices).toEqual(['whole-pr']);
    expect(out.notReviewed.unreviewedPaths).toEqual(['src/a.js']);
    expect(out.notReviewed.expiredAgents).toEqual([expect.objectContaining({ name: 'reviewer-s1-b', state: 'expired' })]);
    expect(out.coverage.complete).toBe(false);
    expect(out.reducedReview).toMatch(/NOT REVIEWED/);
    expect(h.stateWrites[0].state.notReviewed.unreviewedSlices).toEqual(['whole-pr']);
  });

  test('a reviewer that arrived without covering every path of its slice also leaves the slice unreviewed', async () => {
    const h = harness({ changedPaths: ['src/a.js', 'src/b.js'] });
    const m = await h.prepare();
    answerReview(m, { partial: { 'reviewer-s1-a': ['src/a.js'] }, lane: { findings: [], pathsReviewed: allPaths(h) } });
    const out = await h.collect();
    expect(out.notReviewed.unreviewedSlices).toEqual(['whole-pr']);
    expect(out.notReviewed.unreviewedPaths).toEqual(['src/a.js', 'src/b.js']);
    expect(out.coverage.complete).toBe(false);
  });

  test('every reviewer and the lane arrived and covered everything: coverage is complete', async () => {
    const h = harness();
    const { next } = await reviewRound(h);
    expect(next.status).toBe('DONE');
    expect(next.coverage).toEqual({ complete: true, unreviewedSlices: [], uncovered: [] });
    expect(next.notReviewed.expiredAgents).toEqual([]);
  });
});

describe('the security lane (merge-gate 10c)', () => {
  test('clean only when the lane arrived and covered every changed path', async () => {
    const h = harness();
    const { next } = await reviewRound(h);
    expect(next.security).toEqual({ status: 'clean', findings: [] });
    expect(next.gate.securityLane.status).toBe('clean');
  });

  test('a lane that never arrived is not clean: the gate blocks a Medium PR on it', async () => {
    const h = harness();
    const m = await h.prepare();
    answerReview(m, { skip: ['security-lane'] });
    const out = await h.collect({ now: m.agents[2].deadlineAt + 1000 });
    expect(out.security.status).toBe('not-run');
    expect(out.security.status).not.toBe('clean');
    expect(out.gate.mergeable).toBe(false);
    expect(out.gate.blockers.map((b) => b.code)).toContain('security-review-missing');
    expect(out.coverage.complete).toBe(false);
  });

  test('a lane file that is not valid is not clean either', async () => {
    const h = harness();
    const m = await h.prepare();
    answerReview(m, { skip: ['security-lane'] });
    const lane = m.agents.find((a) => a.role === 'security');
    fs.mkdirSync(path.dirname(lane.outPath), { recursive: true });
    fs.writeFileSync(lane.outPath, '{ not json');
    const out = await h.collect({ now: lane.deadlineAt + 1000 });
    expect(out.security.status).not.toBe('clean');
    expect(out.gate.blockers.map((b) => b.code)).toContain('security-review-missing');
  });

  test('a lane that reported clean without having read every changed path is unavailable, never clean', async () => {
    const h = harness({ changedPaths: ['src/a.js', 'src/b.js'] });
    const { next } = await reviewRound(h, { lane: { findings: [], pathsReviewed: ['src/a.js'] } });
    expect(next.security.status).toBe('unavailable');
    expect(next.security.reason).toContain('src/b.js');
    expect(next.gate.blockers[0].code).toBe('review-data-unavailable');
  });

  test('lane findings go to the gate as `security`, not to the verifiers, and block until fixed', async () => {
    const h = harness();
    const m = await h.prepare();
    answerReview(m, { lane: { findings: [finding({ failureMode: 'the path is spliced into a shell command' })], pathsReviewed: allPaths(h) } });
    const out = await h.collect();
    expect(out.status).toBe('DONE');
    expect(out.security.status).toBe('findings');
    expect(out.security.findings[0]).toMatchObject({ id: 's1', source: 'security-lane' });
    expect(out.ledger).toEqual([]);
    expect(out.gate.blockers.map((b) => b.code)).toContain('security-finding-open');
    expect(out.gate.securityLane.open).toEqual(['s1']);
  });
});

describe('findings: completed, never dropped, never closed by an agent', () => {
  test('ids are unique across agents, source is the agent that wrote the file, missing fields are filled and named', async () => {
    const h = harness();
    const m = await h.prepare();
    answerReview(m, {
      findingsFor: (name) => (name === 'reviewer-s1-a' ? [{ id: 'dup', source: 'someone-else', locationOrLink: 'src/a.js:1' }, finding({ id: 'dup', locationOrLink: 'src/a.js:9', failureMode: 'second distinct defect in another place entirely' })] : [{ id: 'dup', locationOrLink: 'src/a.js:40', failureMode: 'a third unrelated problem with the cache invalidation' }]),
      lane: { findings: [], pathsReviewed: allPaths(h) },
    });
    const next = await h.collect();
    expect(next.status).toBe('DISPATCH');
    const run = h.readRun();
    const ids = run.candidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['f1', 'f2', 'f3']);
    const first = run.candidates.find((c) => c.id === 'f1');
    expect(first).toMatchObject({ source: 'reviewer-s1-a', reportedId: 'dup', reportedSource: 'someone-else', severity: 'important', disposition: 'fix' });
    expect(first.completedFields).toEqual(expect.arrayContaining(['severity', 'failureMode', 'evidence', 'originalTextOrLink', 'disposition']));
  });

  test('resolution, cleared and blocking:false written by an agent are stripped: the finding still blocks the gate', async () => {
    const h = harness();
    const m = await h.prepare();
    answerReview(m, {
      findingsFor: (name) => (name === 'reviewer-s1-a' ? [finding({ cleared: true, blocking: false, disposition: 'deferred', reason: 'later', resolution: { reason: 'ok', by: 'maintainer', at: new Date().toISOString(), headSha: HEAD } })] : []),
      lane: { findings: [], pathsReviewed: allPaths(h) },
    });
    let next = await h.collect();
    expect(next.status).toBe('DISPATCH');
    const entry = h.readRun().candidates[0];
    expect(entry.strippedFields).toEqual(expect.arrayContaining(['cleared', 'blocking', 'resolution']));
    expect(entry.cleared).toBeUndefined();
    expect(entry.blocking).toBeUndefined();
    expect(entry.resolution).toBeUndefined();
    voteAll(next, () => 'real');
    next = await h.collect();
    expect(next.status).toBe('DONE');
    expect(next.gate.mergeable).toBe(false);
    expect(next.gate.findings.open).toEqual(['f1']);
  });

  test('an agent cannot resolve a finding by naming the disposition `resolved`', () => {
    const entry = S.completeFinding({ ...finding(), disposition: 'resolved' }, 'reviewer-s1-a', 'f1');
    expect(entry.disposition).toBe('fix');
    expect(entry.completedFields).toContain('disposition');
  });

  test('a severity the ledger does not know is kept (the gate blocks on it), an absent one is Important', () => {
    expect(S.completeFinding(finding({ severity: 'catastrophic' }), 'r', 'f1').severity).toBe('catastrophic');
    expect(S.completeFinding({ ...finding(), severity: undefined }, 'r', 'f1').severity).toBe('important');
  });

  test('non-boolean flags the ledger would refuse are stripped, not carried', () => {
    const entry = S.completeFinding(finding({ uncertain: 'yes', unresolvedThread: true }), 'r', 'f1');
    expect(entry.uncertain).toBeUndefined();
    expect(entry.unresolvedThread).toBe(true);
    expect(entry.strippedFields).toContain('uncertain');
  });

  test('zero candidates skip the verify round', async () => {
    const h = harness();
    const { next } = await reviewRound(h);
    expect(next.status).toBe('DONE');
    expect(next.ledger).toEqual([]);
    expect(h.readRun().waves.map((w) => w.round)).toEqual(['review']);
  });
});

describe('a `pre-existing` label is a claim about provenance and is checked against the diff (review of PR 264, P1)', () => {
  // A unified diff as git writes it: hunks in a changed file, a new file, a deleted file and a binary file.
  const DIFF = `${[
    'diff --git a/src/a.js b/src/a.js',
    'index 1111111..2222222 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,3 +1,4 @@ function head()',
    ' one',
    '+two',
    ' three',
    ' four',
    '@@ -40,2 +41,2 @@',
    '-old forty',
    '+new forty-one',
    ' tail',
    'diff --git a/src/new.js b/src/new.js',
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    '+++ b/src/new.js',
    '@@ -0,0 +1,2 @@',
    '+a',
    '+b',
    'diff --git a/old.js b/old.js',
    'deleted file mode 100644',
    'index 4444444..0000000',
    '--- a/old.js',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-x',
    '-y',
    'diff --git a/img.png b/img.png',
    'index 5555555..6666666 100644',
    'Binary files a/img.png and b/img.png differ',
  ].join('\n')}\n`;
  const diffOf = (over = {}) => ({ index: S.parseDiffHunks(DIFF), changedPaths: ['src/a.js', 'src/new.js', 'old.js', 'img.png'], snapshotDir: '/snap/dir', ...over });
  const claim = (location, over = {}) => S.completeFinding(finding({ severity: 'pre-existing', locationOrLink: location, ...over }), 'reviewer-s1-a', 'f1');

  test('parseDiffHunks: the new-side range of every hunk, per file; a deleted and a binary file have none', () => {
    const { files } = S.parseDiffHunks(DIFF);
    expect([...files.keys()].sort()).toEqual(['src/a.js', 'src/new.js']);
    expect(files.get('src/a.js').hunks).toEqual([[1, 4], [41, 42]]);
    expect(files.get('src/new.js').hunks).toEqual([[1, 2]]);
    expect(S.parseDiffHunks(null)).toBeNull();
    expect(S.parseDiffHunks('').files.size).toBe(0);
  });

  test('parseDiffHunks counts hunk bodies: an added line `++ x` (read `+++ x`) and a removed `-- x` (read `--- x`) start no file', () => {
    const trap = `${[
      'diff --git a/notes.md b/notes.md',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,2 +1,3 @@',
      '--- a/not-a-header.txt',
      '+++ b/not-a-header.txt',
      ' context',
      '+added',
      '\\ No newline at end of file',
      'diff --git a/after.js b/after.js',
      '--- a/after.js',
      '+++ b/after.js',
      '@@ -5 +5 @@',
      '-x',
      '+y',
    ].join('\n')}\n`;
    const { files } = S.parseDiffHunks(trap);
    expect([...files.keys()].sort()).toEqual(['after.js', 'notes.md']);
    expect(files.get('notes.md').hunks).toEqual([[1, 3]]);
    expect(files.get('after.js').hunks).toEqual([[5, 5]]);
  });

  test('parseDiffHunks reads the quoted path git writes for a non-ASCII name', () => {
    const quoted = `${['diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"', '--- "a/caf\\303\\251.js"', '+++ "b/caf\\303\\251.js"', '@@ -3 +3 @@', '-a', '+b'].join('\n')}\n`;
    expect(S.parseDiffHunks(quoted).files.get('caf\u00e9.js').hunks).toEqual([[3, 3]]);
  });

  // src/a.js changes lines 1-4 and 41-42 (context included); src/new.js is new (lines 1-2)
  test.each([
    ['src/a.js:1', false],
    ['src/a.js:4', false],
    ['src/a.js:5', true],
    ['src/a.js:40', true],
    ['src/a.js:41', false],
    ['src/a.js:42', false],
    ['src/a.js:43', true],
    ['src/a.js:3-10', false],
    ['src/a.js:10-3', false],
    ['src/a.js:5-39', true],
    ['src/a.js:39-41', false],
    ['src/other.js:7', true],
    ['README.md:1', true],
    ['./src/a.js:2', false],
    ['SRC/A.JS:2', false],
    ['SRC/A.JS:20', true],
    ['/snap/dir/src/a.js:2', false],
    ['/snap/dir/src/a.js:20', true],
    ['src/new.js:1', false],
    ['img.png:1', false],
    ['old.js:1', false],
    ['src/a.js', false],
    ['src/a.js:12:5', false],
    ['src/a.js#L12', false],
    ['src/a.js:0', false],
    ['unspecified', false],
    ['../escape.js:3', false],
    ['/etc/passwd:3', false],
  ])('a pre-existing claim at %s is honoured: %p', (location, honoured) => {
    const out = S.gradePreExisting(claim(location), diffOf());
    expect(out.severity).toBe(honoured ? 'pre-existing' : 'important');
  });

  test('a claim the diff does not bear out is graded Important, the agent\'s word kept beside it and the severity named as stripped', () => {
    const out = S.gradePreExisting(claim('src/a.js:2', { preExisting: true }), diffOf());
    expect(out).toMatchObject({ severity: 'important', claimedSeverity: 'pre-existing', severityNote: expect.stringContaining('inside a hunk'), strippedFields: ['severity'], locationOrLink: 'src/a.js:2' });
    expect(out.preExisting).toBeUndefined();
  });

  test('an unreadable diff bears nothing out; any other severity, and the spellings of pre-existing the ledger reads, are handled as the gate reads them', () => {
    expect(S.gradePreExisting(claim('src/c.js:7'), diffOf({ index: null })).severity).toBe('important');
    expect(S.gradePreExisting(claim('src/c.js:7'), diffOf({ index: null })).severityNote).toMatch(/could not be read/);
    for (const severity of ['Pre-Existing', 'PREEXISTING', 'pre existing']) {
      expect(S.gradePreExisting(claim('src/a.js:2', { severity }), diffOf())).toMatchObject({ severity: 'important', claimedSeverity: severity });
    }
    for (const severity of ['important', 'nit', 'critical', 'catastrophic']) {
      const entry = S.completeFinding(finding({ severity, locationOrLink: 'src/a.js:2' }), 'reviewer-s1-a', 'f1');
      expect(S.gradePreExisting(entry, diffOf())).toBe(entry);
    }
  });

  async function claimsRun(h, locations) {
    h.reviews = { ok: true, reviews: [{ login: 'bob', authorType: 'User', state: 'APPROVED', commitSha: HEAD, submittedAt: '2026-01-01T00:00:00Z' }] };
    const m = await h.prepare();
    answerReview(m, {
      findingsFor: (name) => (name === 'reviewer-s1-a' ? locations.map((location, i) => finding({ severity: 'pre-existing', locationOrLink: location, failureMode: `defect number ${i} of a different kind in ${location}` })) : []),
      lane: { findings: [], pathsReviewed: allPaths(h) },
    });
    const verify = await h.collect();
    expect(verify).toMatchObject({ status: 'DISPATCH', round: 'verify' });
    voteAll(verify, () => 'real');
    return h.collect();
  }

  test('through a run: a pre-existing finding on a changed line stays in the gate as Important; ones the diff bears out stay pre-existing and do not block', async () => {
    const h = harness({ rangeDiff: DIFF });
    const out = await claimsRun(h, ['src/a.js:2', 'src/c.js:7', 'src/a.js:20']);
    expect(out.status).toBe('DONE');
    const byId = Object.fromEntries(out.ledger.map((entry) => [entry.id, entry]));
    expect(byId.f1).toMatchObject({ severity: 'important', claimedSeverity: 'pre-existing' });
    expect(byId.f2.severity).toBe('pre-existing');
    expect(byId.f3.severity).toBe('pre-existing');
    expect(out.gate.findings).toMatchObject({ open: ['f1'], important: 1, preExisting: 2 });
    expect(out.gate.blockers.map((b) => b.code)).toContain('open-important-finding');
    expect(out.gate.mergeable).toBe(false);
    expect(out.reducedReview).toMatch(/graded Important, not pre-existing[^\n]*f1 \(src\/a\.js:2\)/);
    expect(h.stateWrites[0].state.ledger.find((entry) => entry.id === 'f1').claimedSeverity).toBe('pre-existing');
  });

  test('control: the same claims all on lines the diff does not touch leave the gate mergeable', async () => {
    const h = harness({ rangeDiff: DIFF });
    const out = await claimsRun(h, ['src/c.js:7', 'src/a.js:20']);
    expect(out.gate.findings).toMatchObject({ open: [], important: 0, preExisting: 2 });
    expect(out.gate.mergeable).toBe(true);
    expect(out.reducedReview).not.toMatch(/graded Important, not pre-existing/);
  });

  test('a diff that cannot be read bears nothing out: every pre-existing claim is graded Important', async () => {
    const h = harness({ rangeDiff: DIFF });
    const out = await (async () => {
      h.reviews = { ok: true, reviews: [] };
      const m = await h.prepare();
      fs.rmSync(path.join(h.root, 'prepared', 'range.diff'));
      answerReview(m, { findingsFor: (name) => (name === 'reviewer-s1-a' ? [finding({ severity: 'pre-existing', locationOrLink: 'src/c.js:7' })] : []), lane: { findings: [], pathsReviewed: allPaths(h) } });
      const verify = await h.collect();
      voteAll(verify, () => 'real');
      return h.collect();
    })();
    expect(out.ledger[0]).toMatchObject({ severity: 'important', claimedSeverity: 'pre-existing', severityNote: expect.stringContaining('could not be read') });
    expect(out.gate.findings.open).toEqual(['f1']);
  });

  test('the diff is read only when a pre-existing claim needs it, and a security-lane finding is never regraded (it blocks whatever its label)', async () => {
    const reads = [];
    const h = harness({ rangeDiff: DIFF });
    const real = h.deps.fs;
    h.deps.fs = { ...real, readText: (file) => (reads.push(path.basename(file)), real.readText(file)) };
    const m = await h.prepare();
    answerReview(m, { findingsFor: (name) => (name === 'reviewer-s1-a' ? [finding()] : []), lane: { findings: [finding({ severity: 'pre-existing', locationOrLink: 'src/c.js:7', failureMode: 'the path is spliced into a shell command' })], pathsReviewed: allPaths(h) } });
    const verify = await h.collect();
    voteAll(verify, () => 'real');
    const out = await h.collect();
    expect(reads.filter((name) => name === 'range.diff')).toEqual([]);
    expect(out.security.findings[0]).toMatchObject({ id: 's1', severity: 'pre-existing' });
    expect(out.gate.blockers.map((b) => b.code)).toContain('security-finding-open');
  });

  test('the reviewer is told how the label is checked', async () => {
    const h = harness();
    const m = await h.prepare();
    expect(fs.readFileSync(m.agents[0].briefPath, 'utf8')).toMatch(/pre-existing[^\n]*checks the `file:line` you cite against the diff[^\n]*graded Important/);
  });
});

describe('the verify round', () => {
  async function toVerify(h, findings) {
    const { next } = await reviewRound(h, { findingsFor: (name) => (name === 'reviewer-s1-a' ? findings : []) });
    return next;
  }

  test('K=3 fresh verifiers per candidate, never the raiser, at most three candidates each; the brief carries only the failure mode', async () => {
    const h = harness();
    const m = await toVerify(h, [finding(), finding({ locationOrLink: 'src/a.js:20', failureMode: 'an unrelated defect in the retry loop of the client' })]);
    expect(m).toMatchObject({ status: 'DISPATCH', round: 'verify', wave: '1 of 1' });
    expect(m.agents.every((a) => a.role === 'verifier' && a.candidateIds.length <= 3)).toBe(true);
    const perCandidate = new Map();
    for (const a of m.agents) for (const id of a.candidateIds) perCandidate.set(id, (perCandidate.get(id) || 0) + 1);
    expect([...perCandidate.values()]).toEqual([3, 3]);
    expect(m.agents.some((a) => /reviewer/.test(a.name))).toBe(false);
    const brief = fs.readFileSync(m.agents[0].briefPath, 'utf8');
    expect(brief).toContain('the loop reads past the end of the list');
    expect(brief).toContain('src/a.js:3');
    expect(brief).not.toContain('reviewer-s1-a');
    expect(brief).not.toContain('line 3 indexes list'); // the reviewer's evidence is not handed over
    expect(brief).toContain('Output contract');
  });

  test('three real votes -> the finding is present and the gate holds it open; the lane is untouched', async () => {
    const h = harness();
    const m = await toVerify(h, [finding()]);
    voteAll(m, () => 'real');
    const out = await h.collect();
    expect(out.status).toBe('DONE');
    expect(out.votes.verification).toBe('performed');
    expect(out.votes.outcomes[0]).toMatchObject({ id: 'f1', outcome: 'present' });
    expect(out.ledger[0].verification).toMatchObject({ outcome: 'present', tally: { real: 3, expected: 3 } });
    expect(out.gate.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['open-important-finding']));
    expect(h.stateWrites[0].state.verification.verification).toBe('performed');
  });

  test('a verifier that never arrived: the candidate is unverified, never read as agreement, even when the others voted real', async () => {
    const h = harness();
    const m = await toVerify(h, [finding()]);
    voteAll(m, () => 'real', [m.agents[2].name]);
    const out = await h.collect({ now: m.agents[2].deadlineAt + 1000 });
    expect(out.status).toBe('DONE');
    const outcome = out.votes.outcomes[0];
    expect(outcome.outcome).toBe('unverified');
    expect(outcome.reason).toBe('verifier-incomplete');
    expect(outcome.outcome).not.toBe('present');
    expect(out.notReviewed.incompleteVerifiers.map((v) => v.verifier)).toEqual([m.agents[2].name]);
    expect(out.notReviewed.expiredAgents.map((a) => a.name)).toEqual([m.agents[2].name]);
    expect(out.votes.verification).toBe('not-performed');
    expect(out.reducedReview).toMatch(/verification not-performed/);
    // unverified is presented, and still open at the gate
    expect(out.gate.findings.open).toEqual(['f1']);
  });

  test('verifiers that vote not-real do not delete the finding: it stays in the ledger and the gate still holds it open', async () => {
    const h = harness();
    const m = await toVerify(h, [finding()]);
    voteAll(m, () => 'not-real');
    const out = await h.collect();
    expect(out.ledger).toHaveLength(1);
    expect(out.ledger[0].verification.outcome).toBe('filtered');
    expect(out.ledger[0].verification.authorLabel).toBe('verifier disagrees');
    expect(out.gate.findings.open).toEqual(['f1']);
  });

  test('an unbriefable candidate is KEPT: recorded unbriefable with the reason, unverified, and listed in the result', async () => {
    const h = harness();
    const m = await toVerify(h, [finding({ failureMode: 'the verdict of the cache is stale after reload' }), finding({ locationOrLink: 'src/a.js:20', failureMode: 'an unrelated defect in the retry loop of the client' })]);
    expect(m.status).toBe('DISPATCH');
    const ids = new Set(m.agents.flatMap((a) => a.candidateIds));
    expect(ids).toEqual(new Set(['f2']));
    voteAll(m, () => 'real');
    const out = await h.collect();
    expect(out.ledger.map((e) => e.id).sort()).toEqual(['f1', 'f2']);
    expect(out.notReviewed.unbriefable).toEqual([{ id: 'f1', reason: expect.stringContaining('verdict') }]);
    const kept = out.votes.outcomes.find((o) => o.id === 'f1');
    expect(kept.outcome).toBe('unverified');
    expect(out.notReviewed.unbriefable).toHaveLength(1);
    expect(out.gate.findings.open).toContain('f1');
  });

  test('a location the renderer refuses (no line) is unbriefable too, not dropped', async () => {
    const h = harness();
    const m = await toVerify(h, [finding({ locationOrLink: 'src/a.js' }), finding({ locationOrLink: 'src/a.js:2', failureMode: 'a second finding about the parser' })]);
    voteAll(m, () => 'real');
    const out = await h.collect();
    expect(out.notReviewed.unbriefable.map((u) => u.id)).toEqual(['f1']);
    expect(out.ledger).toHaveLength(2);
  });

  test('the concurrency cap makes WAVES: wave k+1 is emitted only after wave k is collected, with fresh deadlines', async () => {
    const h = harness({ policyJson: { maxConcurrentAgents: 2 } });
    const manifest = await h.prepare();
    // review round: 3 agents at a cap of 2 -> 2 waves
    expect(manifest).toMatchObject({ round: 'review', wave: '1 of 2', maxConcurrentAgents: 2 });
    expect(manifest.agents).toHaveLength(2);
    answerReview(manifest, { lane: { findings: [], pathsReviewed: allPaths(h) } });
    const second = await h.collect();
    expect(second).toMatchObject({ status: 'DISPATCH', round: 'review', wave: '2 of 2' });
    expect(second.agents.map((a) => a.name)).toEqual(['security-lane']);
    expect(second.agents[0].dispatchedAt).toBeGreaterThanOrEqual(manifest.agents[0].dispatchedAt);
    // still pending while wave 2 has not been answered
    expect((await h.collect()).status).toBe('PENDING');
    answerReview(second, { lane: { findings: [], pathsReviewed: allPaths(h) } });
    const done = await h.collect();
    expect(done.status).toBe('DONE');
    expect(done.coverage.complete).toBe(true);
  });

  test('verifier waves: 4 candidates x 3 verifiers at a cap of 2', async () => {
    const h = harness({ policyJson: { maxConcurrentAgents: 2 } });
    const m1 = await h.prepare();
    answerReview(m1, { findingsFor: (n) => (n === 'reviewer-s1-a' ? [0, 1, 2, 3].map((i) => finding({ locationOrLink: `src/a.js:${i + 1}`, failureMode: `distinct defect number ${i} in a different subsystem ${'x'.repeat(i)}` })) : []), lane: { findings: [], pathsReviewed: allPaths(h) } });
    const m2 = await h.collect();
    expect(m2.round).toBe('review');
    answerReview(m2, { lane: { findings: [], pathsReviewed: allPaths(h) } });
    let m = await h.collect();
    expect(m.round).toBe('verify');
    expect(m.agents.length).toBeLessThanOrEqual(2);
    const waves = [m];
    const [, total] = m.wave.split(' of ').map(Number);
    expect(total).toBeGreaterThan(1);
    for (let i = 1; i < total; i += 1) {
      voteAll(m, () => 'real');
      m = await h.collect();
      waves.push(m);
      expect(m.round).toBe('verify');
    }
    voteAll(m, () => 'real');
    const out = await h.collect();
    expect(out.status).toBe('DONE');
    expect(waves.every((w) => w.agents.length <= 2)).toBe(true);
    const names = waves.flatMap((w) => w.agents.map((a) => a.name));
    expect(new Set(names).size).toBe(names.length);
    expect(out.votes.outcomes.every((o) => o.outcome === 'present')).toBe(true);
    expect(out.metrics.dispatchRounds).toBe(2 + total);
  });
});

describe('the gate stage', () => {
  test('REVIEW_COMPLETE is only what deriveStatus says: every runner-side input is good and a gate blocker exists, so it is not complete', async () => {
    const h = harness({ baseline: { ran: true, exitCode: 0, timedOut: false, command: ['jest'], selection: [{ file: 't/a.test.js', why: 'related' }] } });
    const { next } = await reviewRound(h);
    expect(next.status).toBe('DONE');
    // no findings, clean lane, tests passed, fresh head: every fact the runner supplies is "good"
    expect(next.reviewStatus.tests.passed).toBe(true);
    expect(next.reviewStatus.findingCounts).toEqual({ total: 0, actionable: 0, deferred: 0 });
    // ... and approvals are short (a Medium PR needs one human), so the gate blocks
    expect(next.gate.mergeable).toBe(false);
    expect(next.gate.blockers.map((b) => b.code)).toContain('approvals-unsatisfied');
    expect(next.reviewStatus.status).not.toBe('REVIEW_COMPLETE');
    expect(next.reviewStatus.remotePhase).toBe('REMOTE_REVIEW_PENDING');
    expect(next.reviewStatus.localPhase).toBe('LOCAL_REVIEW_COMPLETE');
  });

  test('the runner source never names or sets the complete status', () => {
    for (const file of ['pr-review-run.js', 'pr-review-run-support.js', 'review-run-cli.js']) {
      const text = fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8');
      expect(text).not.toMatch(/REVIEW_COMPLETE/);
      expect(text).not.toMatch(/REMOTE_REVIEW_COMPLETE/);
    }
  });

  test('tests are the real baseline exit code, labelled as relevant files only; a non-zero exit is a failed test', async () => {
    const pass = harness({ baseline: { ran: true, exitCode: 0, timedOut: false, command: ['jest'], selection: [{ file: 't/a.test.js' }] } });
    const ok = (await reviewRound(pass)).next;
    expect(ok.reviewStatus.tests).toMatchObject({ exitCode: 0, passed: true });
    expect(ok.reviewStatus.tests.command).toMatch(/relevant test files only/);
    expect(ok.reducedReview).toMatch(/relevant test files only/);
    const fail = harness({ baseline: { ran: true, exitCode: 1, timedOut: false, command: ['jest'], selection: [{ file: 't/a.test.js' }] } });
    const bad = (await reviewRound(fail)).next;
    expect(bad.reviewStatus.tests.passed).toBe(false);
    expect(bad.reviewStatus.reasons).toContain('failed test');
  });

  test('an absent or timed-out baseline is tests NOT shown: skipped, never a pass and never a failure it did not have', async () => {
    for (const baseline of [{ ran: false, reason: 'no-test-files', exitCode: null, timedOut: false, selection: [] }, { ran: true, exitCode: 0, timedOut: true, command: ['jest'], selection: [{ file: 't' }] }]) {
      const h = harness({ baseline });
      const out = (await reviewRound(h)).next;
      expect(out.reviewStatus.tests.passed).toBe(false);
      expect(out.reviewStatus.tests.skipped).toBe(true);
      expect(out.reviewStatus.reasons).toContain('tests skipped');
      expect(out.reviewStatus.reasons).not.toContain('failed test');
      expect(out.reviewStatus.status).not.toBe('REVIEW_COMPLETE');
      expect(out.reducedReview).toMatch(/tests not shown/);
    }
  });

  test('reads that fail twice are named unavailable (one retry only); a read that succeeds on the retry is not', async () => {
    const h = harness();
    let calls = 0;
    h.deps.readReviews = async () => {
      calls += 1;
      return { ok: false, error: 'HTTP 502' };
    };
    h.deps.readProtection = async () => ({ ok: false, error: 'HTTP 403' });
    const out = (await reviewRound(h)).next;
    expect(calls).toBe(2);
    expect(out.unavailable).toEqual(['reviews', 'branch-protection']);
    expect(out.gate.mergeable).toBe(false);
    expect(out.gate.blockers[0]).toMatchObject({ code: 'review-data-unavailable' });
    expect(out.gate.blockers[0].message).toMatch(/reviews/);
    expect(out.protection.state).toBe('unknown');

    const retry = harness();
    let n = 0;
    retry.deps.readReviews = async () => {
      n += 1;
      return n === 1 ? { ok: false, error: 'blip' } : { ok: true, reviews: [] };
    };
    const ok = (await reviewRound(retry)).next;
    expect(n).toBe(2);
    expect(ok.unavailable).toEqual([]);
  });

  test('approvals are counted for the head from the host: a human approval on the head satisfies a Medium PR; a stale one does not', async () => {
    const h = harness();
    h.reviews = { ok: true, reviews: [{ login: 'bob', authorType: 'User', state: 'APPROVED', commitSha: HEAD, submittedAt: '2026-01-01T00:00:00Z' }] };
    const out = (await reviewRound(h)).next;
    expect(out.approvals).toMatchObject({ satisfied: true, humansCounted: 1 });
    expect(out.gate.mergeable).toBe(true);
    const stale = harness();
    stale.reviews = { ok: true, reviews: [{ login: 'bob', authorType: 'User', state: 'APPROVED', commitSha: 'e'.repeat(40), submittedAt: '2026-01-01T00:00:00Z' }] };
    stale.deps.git = async (args) => (args[0] === 'rev-parse' && /^e+\^\{tree\}$/.test(args[args.length - 1]) ? { status: 0, stdout: `${'1'.repeat(40)}\n`, stderr: '' } : { status: 0, stdout: `${args[0] === 'merge-base' ? BASE : TREE}\n`, stderr: '' });
    const out2 = (await reviewRound(stale)).next;
    expect(out2.approvals.humansCounted).toBe(0);
    expect(out2.gate.mergeable).toBe(false);
  });

  test('the PR body is read fresh: missing sections block; the agent-authored default is the strict one', async () => {
    const h = harness();
    h.pr.body = 'nothing here';
    const out = (await reviewRound(h)).next;
    expect(out.gate.blockers.map((b) => b.code)).toContain('description-section-missing');
    const strict = harness();
    const m = await prepareRun({ repo: 'o/r', pr: 7, repoRoot: strict.repoRoot, runId: 'run1' }, strict.deps); // agentAuthored not stated
    answerReview(m, { lane: { findings: [], pathsReviewed: allPaths(strict) } });
    const res = await strict.collect();
    expect(res.gate.blockers.some((b) => b.section === 'directed-by')).toBe(true);
  });

  test('the state report is written once, redacted, under the PR id, with the status facts, the ledger and the reduced-review notice', async () => {
    const h = harness();
    const { next } = await reviewRound(h);
    expect(h.stateWrites).toHaveLength(1);
    const { target, state } = h.stateWrites[0];
    expect(target).toBe(statePath(7, h.repoRoot));
    expect(state).toMatchObject({ prId: 7, runId: 'run1', mode: 'light', reviewedHeadSha: HEAD, headSha: HEAD, reviewedTreeSha: TREE, headTreeSha: TREE, security: { status: 'clean' } });
    expect(state.tier.tier).toBe('medium');
    expect(next.statePath).toBe(target);
    expect(fs.existsSync(path.join(h.runDir(), 'final.json'))).toBe(true);
    expect(h.readRun().phase).toBe('done');
  });

  test('a state report that could not be written is RUN_FAILED, the phase is unchanged and a retry can finish', async () => {
    const h = harness();
    const m = await h.prepare();
    answerReview(m, { lane: { findings: [], pathsReviewed: allPaths(h) } });
    h.deps.writeState = async () => ({ ok: false, reason: 'disk full' });
    expect(await h.collect()).toMatchObject({ ok: false, status: 'RUN_FAILED', reason: 'state-write-failed' });
    expect(h.readRun().phase).not.toBe('done');
    h.deps.writeState = async (t) => ({ ok: true, path: t });
    expect((await h.collect()).status).toBe('DONE');
  });
});

describe('adjudication re-entry', () => {
  async function uncertainRun(severity = 'important') {
    const h = harness();
    const m = await h.prepare();
    answerReview(m, { findingsFor: (n) => (n === 'reviewer-s1-a' ? [finding({ uncertain: true, severity })] : []), lane: { findings: [], pathsReviewed: allPaths(h) } });
    const verify = await h.collect();
    voteAll(verify, () => 'real');
    const out = await h.collect();
    return { h, out };
  }

  test('an uncertain finding is ADJUDICATE: listed, and the gate already treats it as open', async () => {
    const { out } = await uncertainRun();
    expect(out).toMatchObject({ ok: true, status: 'ADJUDICATE' });
    expect(out.adjudicate).toEqual([{ id: 'f1', why: expect.stringContaining('uncertain') }]);
    expect(out.gate.findings.open).toEqual(['f1']);
  });

  test('collect on a finished run is idempotent: the head is re-read (one host read and nothing else) and the stored result returned while it is unchanged', async () => {
    const { h, out } = await uncertainRun();
    const reads = h.ghReads.length;
    const again = await h.collect();
    expect(again).toEqual(JSON.parse(JSON.stringify(out)));
    expect(h.ghReads.slice(reads)).toEqual(['readPr']);
    expect(h.stateWrites).toHaveLength(1);
  });

  test('a finished run whose head moved is RUN_INVALIDATED and its stored mergeable answer is NOT returned; it is the answer again only for the head it reviewed (review of PR 264, P1)', async () => {
    const h = harness();
    h.reviews = { ok: true, reviews: [{ login: 'bob', authorType: 'User', state: 'APPROVED', commitSha: HEAD, submittedAt: '2026-01-01T00:00:00Z' }] };
    const { next } = await reviewRound(h);
    expect(next).toMatchObject({ status: 'DONE', gate: { mergeable: true } });
    h.head = MOVED;
    const out = await h.collect();
    expect(out).toMatchObject({ ok: false, status: 'RUN_INVALIDATED', reason: 'head-moved', expectedHead: HEAD, currentHead: MOVED });
    expect(JSON.stringify(out)).not.toContain('mergeable');
    expect(h.stateWrites).toHaveLength(1);
    h.head = HEAD;
    expect(await h.collect()).toMatchObject({ status: 'DONE', gate: { mergeable: true } });
  });

  test('a finished run whose head cannot be read, or whose PR is no longer open, gets no stored answer either', async () => {
    const h = harness();
    h.reviews = { ok: true, reviews: [{ login: 'bob', authorType: 'User', state: 'APPROVED', commitSha: HEAD, submittedAt: '2026-01-01T00:00:00Z' }] };
    await reviewRound(h);
    const good = h.deps.readPr;
    h.deps.readPr = async () => ({ ok: false, error: 'gh: rate limited' });
    const unreadable = await h.collect();
    expect(unreadable).toMatchObject({ ok: false, status: 'RUN_FAILED', reason: 'head-unreadable' });
    expect(JSON.stringify(unreadable)).not.toContain('mergeable');
    h.deps.readPr = good;
    h.pr.state = 'MERGED';
    const merged = await h.collect();
    expect(merged).toMatchObject({ ok: false, status: 'RUN_FAILED', reason: 'pr-not-open', prState: 'MERGED' });
    expect(JSON.stringify(merged)).not.toContain('mergeable');
    h.pr.state = 'OPEN';
    expect(await h.collect()).toMatchObject({ status: 'DONE', gate: { mergeable: true } });
  });

  test('an adjudication is applied only to findings that were listed', async () => {
    const { h } = await uncertainRun();
    expect(await h.collect({ adjudications: [{ id: 'nope', disposition: 'fix', reason: 'because' }] })).toMatchObject({ ok: false, reason: 'adjudication-refused', error: expect.stringContaining('not listed') });
    expect(await h.collect({ adjudications: [{ id: 'f1', disposition: 'closed', reason: 'because' }] })).toMatchObject({ reason: 'adjudication-refused' });
    expect(await h.collect({ adjudications: [{ id: 'f1', disposition: 'fix', reason: '' }] })).toMatchObject({ reason: 'adjudication-refused' });
    expect(await h.collect({ adjudications: [{ id: 'f1', disposition: 'fix', reason: 'a' }, { id: 'f1', disposition: 'fix', reason: 'b' }] })).toMatchObject({ reason: 'adjudication-refused' });
    expect(h.stateWrites).toHaveLength(1);
  });

  test('a security-lane finding cannot be adjudicated (it is not a listed ledger finding)', async () => {
    const h = harness();
    const m = await h.prepare();
    answerReview(m, { lane: { findings: [finding({ uncertain: true })], pathsReviewed: allPaths(h) } });
    const out = await h.collect();
    expect(out.status).toBe('DONE');
    expect(out.adjudicate).toBeUndefined();
    expect(await h.collect({ adjudications: [{ id: 's1', disposition: 'not-applicable', reason: 'nah' }] })).toMatchObject({ reason: 'adjudication-refused' });
  });

  test('deferring an Important finding does NOT stop it blocking: the gate ignores a review-side deferral; adjudicatedBy is recorded', async () => {
    const { h } = await uncertainRun('important');
    const out = await h.collect({ adjudications: [{ id: 'f1', disposition: 'deferred', reason: 'tracked in a follow-up' }] });
    expect(out.status).toBe('DONE'); // nothing left to adjudicate...
    expect(out.adjudicatedBy).toBe('orchestrator');
    expect(out.ledger[0]).toMatchObject({ disposition: 'deferred', adjudicatedBy: 'orchestrator', uncertain: false });
    // ... but the finding is still open at the gate
    expect(out.gate.mergeable).toBe(false);
    expect(out.gate.findings.open).toEqual(['f1']);
    expect(out.gate.blockers.map((b) => b.code)).toContain('open-important-finding');
    expect(out.reviewStatus.findingCounts.actionable).toBe(1);
    // the recomputed state report carries the decision
    expect(h.stateWrites).toHaveLength(2);
    expect(h.stateWrites[1].state).toMatchObject({ adjudicatedBy: 'orchestrator' });
  });

  test('adjudicating a Nit as deferred with a reason closes it (what isActionable allows), and the list empties', async () => {
    const { h, out } = await uncertainRun('nit');
    expect(out.status).toBe('ADJUDICATE');
    const done = await h.collect({ adjudications: [{ id: 'f1', disposition: 'deferred', reason: 'cosmetic' }] });
    expect(done.status).toBe('DONE');
    expect(done.adjudicate).toBeUndefined();
    expect(done.reviewStatus.findingCounts).toMatchObject({ actionable: 0, deferred: 1 });
    // and the stored answer is now the adjudicated one
    expect((await h.collect()).adjudicatedBy).toBe('orchestrator');
  });

  test('an adjudication of a moved head decides nothing: RUN_INVALIDATED and the stored answer stays', async () => {
    const { h, out } = await uncertainRun();
    h.head = MOVED;
    const answer = await h.collect({ adjudications: [{ id: 'f1', disposition: 'fix', reason: 'will fix' }] });
    expect(answer).toMatchObject({ ok: false, status: 'RUN_INVALIDATED' });
    h.head = HEAD;
    expect((await h.collect()).status).toBe(out.status);
  });
});

describe('AC3: nothing is edited, checked out or pushed', () => {
  const FORBIDDEN = /^(push|checkout|switch|reset|stash|commit|add|rebase|apply|merge|cherry-pick|revert|clean|rm|mv|restore|fetch|pull|tag|branch|update-ref|worktree)$/;

  test('every git call of a whole run is merge-base or rev-parse; every host call is a read', async () => {
    const h = harness();
    const m = await h.prepare();
    answerReview(m, { findingsFor: (n) => (n === 'reviewer-s1-a' ? [finding()] : []), lane: { findings: [], pathsReviewed: allPaths(h) } });
    const verify = await h.collect();
    voteAll(verify, () => 'real');
    await h.collect();
    expect(h.gitCalls.length).toBeGreaterThan(0);
    for (const args of h.gitCalls) {
      expect(['merge-base', 'rev-parse']).toContain(args[0]);
      expect(args[0]).not.toMatch(FORBIDDEN);
    }
    // the only host reads the logic itself makes
    expect(new Set(h.ghReads)).toEqual(new Set(['readPr', 'readReviews', 'readProtection']));
  });
});

describe('metrics and the acvv recorder', () => {
  test('metrics come from the call log and agent times: calls, rounds, agents, wait, orchestrator-only', async () => {
    const h = harness();
    let t = 1_000_000;
    h.deps.now = () => {
      t += 1000;
      return t;
    };
    const m = await h.prepare();
    // the agents arrive 5 s of (fake) wall time later; files carry real ctimes, so collect "now" is real
    answerReview(m, { lane: { findings: [], pathsReviewed: allPaths(h) } });
    const out = await h.collect({ now: Date.now() });
    expect(out.status).toBe('DONE');
    const x = out.metrics;
    expect(x).toMatchObject({ runnerCalls: 2, dispatchRounds: 1, agentsDispatched: 3 });
    expect(x.wallMs).toBeGreaterThan(0);
    expect(x.runnerMs).toBeGreaterThan(0);
    expect(x.runnerMs).toBeLessThanOrEqual(x.wallMs);
    expect(x.orchestratorOnlyMs).toBe(Math.max(0, x.wallMs - x.runnerMs - x.agentActiveMs));
    expect(Object.keys(x).sort()).toEqual(['agentActiveMs', 'agentsDispatched', 'dispatchRounds', 'orchestratorOnlyMs', 'runnerCalls', 'runnerMs', 'wallMs']);
  });

  test('computeMetrics and unionMs on a hand-made run', () => {
    expect(S.unionMs([[0, 10], [5, 20], [30, 40]])).toBe(30);
    expect(S.unionMs([])).toBe(0);
    const run = { calls: [{ call: 'prepare', startedAt: 0, endedAt: 100 }, { call: 'collect', startedAt: 9000, endedAt: 9100 }], waves: [{ status: 'collected', agents: [{ dispatchedAt: 100, arrivedAt: 5000, deadlineAt: 99999 }, { dispatchedAt: 100, arrivedAt: 8000, deadlineAt: 99999 }] }, { status: 'planned', agents: [{}] }] };
    expect(S.computeMetrics(run, 9100)).toEqual({ wallMs: 9100, runnerCalls: 2, dispatchRounds: 1, agentsDispatched: 2, runnerMs: 200, agentActiveMs: 7900, orchestratorOnlyMs: 1000 });
  });

  test('stage spans: precheck, prepare-head, one span per agent from dispatch to collection, and the gate', async () => {
    const h = harness();
    await reviewRound(h);
    const started = h.spans.filter((s) => s.type === 'start');
    expect(started.map((s) => s.name)).toEqual(['precheck', 'prepare-head', 'agent:reviewer-s1-a', 'agent:reviewer-s1-b', 'agent:security-lane', 'gate']);
    expect(started.filter((s) => s.kind === 'agent')).toHaveLength(3);
    expect(started.find((s) => s.name === 'gate').kind).toBe('gate');
    const ended = h.spans.filter((s) => s.type === 'end');
    expect(ended).toHaveLength(started.length);
    expect(h.readRun().waves[0].agents.every((a) => a.spanId !== null && a.spanId !== undefined)).toBe(true);
  });

  test('tracing never fails the run: a tracer that throws on everything changes nothing', async () => {
    const h = harness();
    h.deps.makeTracer = () => ({
      startSpan: () => {
        throw new Error('trace disk full');
      },
      endSpan: () => {
        throw new Error('trace disk full');
      },
    });
    const { next } = await reviewRound(h);
    expect(next.status).toBe('DONE');
    const noFactory = harness();
    noFactory.deps.makeTracer = () => {
      throw new Error('boom');
    };
    expect((await reviewRound(noFactory)).next.status).toBe('DONE');
  });
});

describe('failures that are reported, not hidden', () => {
  test('an unreadable PR, an unfetchable base and an unresolvable merge base are RUN_FAILED with a named reason', async () => {
    const a = harness();
    a.deps.readPr = async () => ({ ok: false, error: 'gh: not found' });
    expect(await a.prepare()).toMatchObject({ status: 'RUN_FAILED', reason: 'pr-unreadable' });
    const b = harness();
    b.deps.fetchRefs = async () => ({ ok: false, error: 'network' });
    expect(await b.prepare()).toMatchObject({ status: 'RUN_FAILED', reason: 'refs-unavailable' });
    const c = harness();
    c.deps.git = async () => ({ status: 1, stdout: '', stderr: 'fatal' });
    expect(await c.prepare()).toMatchObject({ status: 'RUN_FAILED', reason: 'base-unresolved' });
  });

  test('a prepare step that failed is RUN_FAILED and leaves no run behind, so the same run id can be retried', async () => {
    const h = harness({ prepareOverride: () => ({ ok: false, status: 'PREPARE_FAILED', reason: 'snapshot-failed', stage: 'snapshot', detail: 'git archive failed' }) });
    expect(await h.prepare()).toMatchObject({ status: 'RUN_FAILED', reason: 'prepare-failed', error: expect.stringContaining('snapshot-failed') });
    expect(fs.existsSync(path.join(h.runDir(), 'run.json'))).toBe(false);
  });

  test('collect on an unknown or unreadable run', async () => {
    const h = harness();
    expect(await h.collect({ runId: 'ghost' })).toMatchObject({ ok: false, status: 'RUN_FAILED', reason: 'run-not-found' });
    await h.prepare();
    fs.writeFileSync(path.join(h.runDir(), 'run.json'), '{ truncated');
    expect(await h.collect()).toMatchObject({ ok: false, reason: 'run-unreadable' });
  });

  test('a prepared directory for another head is refused', async () => {
    const h = harness({ prepareOverride: (o) => ({ ok: true, dir: '/x', headSha: 'e'.repeat(40), baseSha: o.baseSha, artifacts: {} }) });
    expect(await h.prepare()).toMatchObject({ status: 'RUN_FAILED' });
  });
});

describe('support helpers', () => {
  test('deriveKinds cites every changed path exactly once and never anything below Medium for code', () => {
    const kinds = S.deriveKinds(['README.md', 'src/a.js', 'docs/x.rst']);
    expect(kinds).toEqual([{ kind: 'docs', paths: ['README.md', 'docs/x.rst'] }, { kind: 'product', paths: ['src/a.js'] }]);
    expect(S.deriveKinds([])).toEqual([]);
    expect(S.deriveKinds('x')).toEqual([]);
  });

  test('planDepth: Medium is standard, 2 reviewers per slice, 3 verifiers; a Low waiver is quick with one reviewer and none', () => {
    const medium = S.planDepth({ tier: 'medium', effectiveTier: 'medium', waiver: { applies: false } });
    expect(medium.depth).toMatchObject({ mode: 'standard', reviewersPerSlice: 2, verifiersPerCandidate: 3 });
    const quick = S.planDepth({ tier: 'low', effectiveTier: 'low', waiver: { applies: true } });
    expect(quick.depth).toMatchObject({ mode: 'quick', reviewersPerSlice: 1, verifiersPerCandidate: 0 });
    const high = S.planDepth({ tier: 'high', effectiveTier: 'high', waiver: { applies: false } });
    expect(high.depth.mode).toBe('deep');
    expect(S.planDepth({ tier: 'nonsense', effectiveTier: 'nonsense' }).ok).toBe(false);
  });

  test('planVerifierPool never hands a verifier more than three candidates and never the raiser', () => {
    const candidates = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, source: 'reviewer-s1-a' }));
    const plan = S.planVerifierPool({ candidates, mode: 'standard', k: 3 });
    expect(plan.ok).toBe(true);
    expect(Math.max(...plan.agents.map((a) => a.candidates.length))).toBeLessThanOrEqual(3);
    expect(plan.assignments.every((a) => a.verifiers.length === 3 && !a.verifiers.includes('reviewer-s1-a'))).toBe(true);
    expect(S.planVerifierPool({ candidates: [], mode: 'standard', k: 3 }).ok).toBe(true);
  });

  test('chunk, locationFile and adjudicateList', () => {
    expect(S.chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(S.chunk([1, 2], 0)).toEqual([[1], [2]]);
    expect(S.locationFile('a/b.js:12-14')).toBe('a/b.js');
    expect(S.locationFile('a/b.js')).toBeNull();
    expect(S.adjudicateList([{ id: 1, uncertain: true }, { id: 2, disposition: 'adjudicate' }, { id: 3, verification: { outcome: 'disputed' } }, { id: 4 }, { id: 5, uncertain: true, adjudication: { by: 'orchestrator' } }]).map((x) => x.id)).toEqual([1, 2, 3]);
  });
});
