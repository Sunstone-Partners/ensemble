#!/usr/bin/env node
'use strict';

/**
 * review-precheck-cli.js -- the entry point and the real deps for `pr-review-precheck.js` (kata 4ev6).
 *
 *   node review-precheck-cli.js < payload.json
 *   payload: { repo: "owner/name", pr: 234, repoRoot: "/path/to/clone", dryRun?: true, tier?: <pr-review-cli tier record> }
 *
 * Prints ONE JSON object on stdout (the precheck result, token-shaped strings redacted) and exits 0, or 1 when the
 * result is `ok:false`. `dryRun` posts no comment and starts the gate in ITS dry-run mode (no commit status is
 * published), under a separate start marker so a later real run is not blocked by it.
 *
 * Shell-outs live here, never in the pure module: `gh` and `git` run as argv arrays (never a shell) with the
 * maintainer's own login, and every value that reaches argv was validated first. This module reads and writes only
 * under `<repoRoot>/.ensemble/pr-review/` (start markers, gate input and log) -- the directory the review state
 * reports already use and that .gitignore already excludes.
 *
 * Why not the host adapter: `host.yaml` has no PR-comment, commit-status-list or branch-protection capability, and the
 * GitHub adapter's command allowlist is a fixed TRD-036 list (no `api` REST). Adding capabilities to every host
 * adapter is a separate change; until then this is GitHub-only, like local-ci-status.js and local-ci-cli.js's `prInfo`,
 * and says so (`readPr` fails closed on a repository `gh` cannot reach).
 */

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const { runPrecheck, COMMENT_MARKER } = require('./pr-review-precheck');
const { redact } = require('./local-ci-status');

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_STDIN_BYTES = 1024 * 1024;
const PAYLOAD_KEYS = ['repo', 'pr', 'repoRoot', 'dryRun', 'tier'];
const STATE_SUBDIR = path.join('.ensemble', 'pr-review');
const GH_TIMEOUT_MS = 60000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';

/** Default process runner: argv array, never a shell. Resolves `{status, stdout, stderr}`; never rejects. */
function defaultRun(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      if (!err) return resolve({ status: 0, stdout, stderr: stderr || '' });
      resolve({ status: typeof err.code === 'number' ? err.code : 127, stdout: stdout || '', stderr: stderr || String(err.message) });
    });
  });
}

const tail = (text) => String(text || '').trim().slice(0, 300);

/** `--paginate --slurp` yields an array of pages; flatten one level. */
function flattenPages(stdout) {
  const pages = JSON.parse(stdout);
  if (!Array.isArray(pages)) throw new Error('not an array');
  return pages.flatMap((p) => (Array.isArray(p) ? p : [p]));
}

/**
 * Build the real deps for one PR. `run`, `spawnProcess`, `now` and `gateScript` are injectable so the
 * claim-and-start path can be exercised against a real filesystem without a real gate or network.
 */
function makeDeps({ repo, pr, repoRoot, run = defaultRun, spawnProcess = spawn, now = () => new Date(), gateScript = path.join(__dirname, 'local-ci-cli.js') }) {
  const root = path.resolve(repoRoot);
  const stateDir = path.join(root, STATE_SUBDIR);
  const git = (args) => run('git', args, { cwd: root });
  const gh = (args) => run('gh', args, { cwd: root });
  const ghJson = async (args, flatten) => {
    const r = await gh(args);
    if (r.status !== 0) return { ok: false, error: `gh ${args[0]} ${args[1] || ''} failed: ${tail(r.stderr) || `exit ${r.status}`}` };
    try {
      return { ok: true, data: flatten ? flattenPages(r.stdout) : JSON.parse(r.stdout) };
    } catch (e) {
      return { ok: false, error: `gh ${args[0]} returned output that is not JSON (${e.message})` };
    }
  };
  const markerPath = (headSha, dryRun) => path.join(stateDir, `precheck-pr-${pr}-${headSha}${dryRun ? '.dry' : ''}.gate.json`);

  // `origin/<base>` must be fresh before the base-ref config/policy are read and before the gate runs (it refuses a
  // stale or absent remote-tracking ref). Fetched once per run.
  let baseFetch = null;
  const fetchBase = (baseRefName) => {
    if (baseFetch === null) {
      baseFetch = BRANCH_RE.test(String(baseRefName))
        ? git(['fetch', '--quiet', 'origin', baseRefName]).then((r) => (r.status === 0 ? { ok: true } : { ok: false, error: `git fetch origin ${baseRefName} failed: ${tail(r.stderr)}` }))
        : Promise.resolve({ ok: false, error: 'the base branch name is not usable' });
    }
    return baseFetch;
  };
  let viewer = null;
  const viewerLogin = () => {
    if (viewer === null) {
      viewer = ghJson(['api', 'user']).then((r) => (r.ok && isText(r.data && r.data.login) ? { ok: true, login: r.data.login } : { ok: false, error: r.error || 'gh api user returned no login' }));
    }
    return viewer;
  };

  return {
    async readPr() {
      const r = await ghJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,baseRefName,state,body,author']);
      if (!r.ok) return r;
      const d = r.data;
      if (!isObject(d) || !BRANCH_RE.test(String(d.baseRefName))) return { ok: false, error: 'gh pr view returned no usable base branch' };
      return { ok: true, headSha: d.headRefOid, baseRefName: d.baseRefName, state: d.state, body: typeof d.body === 'string' ? d.body : '', author: isObject(d.author) ? d.author.login : undefined };
    },

    async readReviews() {
      const r = await ghJson(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr}/reviews?per_page=100`], true);
      if (!r.ok) return r;
      return {
        ok: true,
        reviews: r.data.map((x) => ({
          login: isObject(x.user) ? x.user.login : undefined,
          authorType: isObject(x.user) ? x.user.type : undefined,
          state: x.state,
          commitSha: x.commit_id,
          submittedAt: x.submitted_at,
        })),
      };
    },

    async readHeadTree(headSha) {
      const r = await ghJson(['api', `repos/${repo}/git/commits/${headSha}`]);
      return r.ok && isObject(r.data.tree) ? { ok: true, treeSha: r.data.tree.sha } : { ok: false, error: r.error || 'no tree in the commit' };
    },

    async readProtection(baseRefName) {
      if (!BRANCH_RE.test(String(baseRefName))) return { ok: false, error: 'the base branch name is not usable' };
      const r = await gh(['api', `repos/${repo}/branches/${baseRefName}/protection`]);
      if (r.status === 0) {
        try {
          return { ok: true, protection: JSON.parse(r.stdout) };
        } catch (_e) {
          return { ok: false, error: 'branch protection answered with output that is not JSON' };
        }
      }
      // Only GitHub's exact "Branch not protected" 404 says there is no rule. Any other failure (no admin access,
      // missing branch, rate limit, network) is an unreadable answer: `unknown`, never `absent` or `enforced`.
      let message = '';
      try {
        message = JSON.parse(r.stdout).message;
      } catch (_e) {
        message = '';
      }
      if (message === 'Branch not protected' && /HTTP 404/.test(r.stderr)) return { ok: true, notProtected: true };
      return { ok: false, error: tail(r.stderr) || `exit ${r.status}` };
    },

    async readStatuses(headSha) {
      const r = await ghJson(['api', '--paginate', '--slurp', `repos/${repo}/commits/${headSha}/statuses?per_page=100`], true);
      if (!r.ok) return r;
      // The list is for exactly this ref; bind each entry to it so a status can never be read for another commit.
      return { ok: true, statuses: r.data.map((s) => ({ context: s.context, state: s.state, description: s.description, sha: headSha })) };
    },

    async readGateConfig(baseRefName) {
      const f = await fetchBase(baseRefName);
      if (!f.ok) return f;
      // The status context comes ONLY from the config committed at the base ref (the gate's own trust rule).
      const rev = await git(['rev-parse', '--verify', '--end-of-options', `refs/remotes/origin/${baseRefName}^{commit}`]);
      const baseSha = String(rev.stdout || '').trim();
      if (rev.status !== 0 || !SHA_RE.test(baseSha)) return { ok: false, error: `origin/${baseRefName} does not resolve to a commit in ${root}` };
      const shown = await git(['show', `${baseSha}:.ensemble/local-ci.yaml`]);
      if (shown.status !== 0) return { ok: false, error: `no .ensemble/local-ci.yaml at origin/${baseRefName}: local CI is not configured for this base` };
      let cfg;
      try {
        cfg = require('./local-ci-config').validateConfig(shown.stdout);
      } catch (e) {
        return { ok: false, error: `the local-ci config could not be validated: ${e.message}` };
      }
      if (!cfg || cfg.ok !== true || !cfg.approvalSet || !isText(cfg.approvalSet.statusContext)) {
        return { ok: false, error: `unusable .ensemble/local-ci.yaml at origin/${baseRefName}: ${((cfg && cfg.problems) || ['invalid']).join('; ').slice(0, 300)}` };
      }
      return { ok: true, statusContext: cfg.approvalSet.statusContext };
    },

    async readPolicy(baseRefName) {
      const f = await fetchBase(baseRefName);
      if (!f.ok) return f;
      const rev = await git(['rev-parse', '--verify', '--end-of-options', `refs/remotes/origin/${baseRefName}^{commit}`]);
      const baseSha = String(rev.stdout || '').trim();
      if (rev.status !== 0 || !SHA_RE.test(baseSha)) return { ok: false, error: 'the base commit could not be resolved' };
      // A missing REVIEW.md is the documented "no policy file" case (strict defaults), not a read failure.
      const has = await git(['cat-file', '-e', `${baseSha}:REVIEW.md`]);
      let text;
      if (has.status === 0) {
        const shown = await git(['show', `${baseSha}:REVIEW.md`]);
        if (shown.status !== 0) return { ok: false, error: `git show REVIEW.md failed: ${tail(shown.stderr)}` };
        text = shown.stdout;
      }
      const loaded = require('./pr-review-policy').loadPolicy({ text, baseSha, sourceSha: baseSha });
      return loaded.ok === true ? { ok: true, policy: loaded.policy } : { ok: false, error: `policy not usable: ${loaded.reason}` };
    },

    /** Atomic create-once marker: exactly one concurrent caller gets `claimed:true` for a head. Not a queue or lock. */
    claimGateStart({ headSha, dryRun }) {
      fs.mkdirSync(stateDir, { recursive: true });
      const file = markerPath(headSha, dryRun);
      let fd;
      try {
        fd = fs.openSync(file, 'wx');
      } catch (e) {
        if (e.code !== 'EEXIST') return { claimed: false, error: e.message };
        let existing = {};
        try {
          existing = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (_e) {
          existing = {};
        }
        let alive = null;
        if (Number.isInteger(existing.pid)) {
          try {
            process.kill(existing.pid, 0);
            alive = true;
          } catch (err) {
            alive = err.code === 'EPERM';
          }
        }
        return { claimed: false, existing: { pid: existing.pid, startedAt: existing.startedAt, alive } };
      }
      fs.writeSync(fd, JSON.stringify({ headSha, claimedAt: now().toISOString() }));
      fs.closeSync(fd);
      return { claimed: true };
    },

    releaseGateStart({ headSha, dryRun }) {
      fs.rmSync(markerPath(headSha, dryRun), { force: true });
    },

    /** Start the existing `local-ci-cli.js gate` detached, its input from a file and its output to a log. */
    async startGate({ headSha, baseRefName, dryRun }) {
      const f = await fetchBase(baseRefName);
      if (!f.ok) return f;
      // The gate checks the base/head relationship in THIS clone before it clones the head itself, so the head
      // commit must be present locally. GitHub serves a commit by sha; the PR's own ref is the fallback.
      if (!SHA_RE.test(headSha)) return { ok: false, error: 'the head commit is not a full sha' };
      let got = await git(['fetch', '--quiet', 'origin', headSha]);
      if (got.status !== 0) got = await git(['fetch', '--quiet', 'origin', `refs/pull/${pr}/head`]);
      if (got.status !== 0) return { ok: false, error: `git fetch of the PR head ${headSha} failed: ${tail(got.stderr)}` };
      const stem = path.join(stateDir, `precheck-pr-${pr}-${headSha}${dryRun ? '.dry' : ''}.gate`);
      const input = `${stem}-input.json`;
      const logPath = `${stem}.log`;
      const payload = { repoRoot: root, headSha, baseRef: `origin/${baseRefName}`, repo, pr, ...(dryRun ? { dryRun: true } : {}) };
      let inFd;
      let outFd;
      try {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(input, JSON.stringify(payload));
        inFd = fs.openSync(input, 'r');
        outFd = fs.openSync(logPath, 'a');
        const child = spawnProcess(process.execPath, [gateScript, 'gate'], { cwd: root, detached: true, stdio: [inFd, outFd, outFd] });
        const spawnError = await new Promise((resolve) => {
          child.once('error', (e) => resolve(e));
          // `spawn` reports failure asynchronously; a child with a pid has started.
          setImmediate(() => resolve(null));
        });
        if (spawnError || !Number.isInteger(child.pid)) return { ok: false, error: `could not start the gate: ${spawnError ? spawnError.message : 'no pid'}` };
        child.unref();
        const startedAt = now().toISOString();
        fs.writeFileSync(markerPath(headSha, dryRun), JSON.stringify({ headSha, pid: child.pid, startedAt, logPath }));
        return { ok: true, pid: child.pid, logPath, startedAt };
      } catch (e) {
        return { ok: false, error: `could not start the gate: ${e.message}` };
      } finally {
        if (inFd !== undefined) fs.closeSync(inFd);
        if (outFd !== undefined) fs.closeSync(outFd);
      }
    },

    /** Our one comment on this PR: carries the marker AND was written by the login `gh` is using now. */
    async findComment() {
      const who = await viewerLogin();
      if (!who.ok) return { ok: false, error: who.error };
      const r = await ghJson(['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/comments?per_page=100`], true);
      if (!r.ok) return r;
      const mine = r.data.filter((c) => isObject(c) && typeof c.body === 'string' && c.body.startsWith(COMMENT_MARKER) && isObject(c.user) && String(c.user.login).toLowerCase() === who.login.toLowerCase());
      // If something earlier left more than one, update the oldest and never add another.
      mine.sort((a, b) => a.id - b.id);
      return { ok: true, comment: mine.length > 0 ? { id: mine[0].id, body: mine[0].body } : null };
    },

    async postComment(body) {
      const r = await ghJson(['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '-f', `body=${body}`]);
      return r.ok ? { ok: true, id: r.data.id, url: r.data.html_url } : r;
    },

    async updateComment(id, body) {
      if (!Number.isInteger(id)) return { ok: false, error: 'the existing comment has no usable id' };
      const r = await ghJson(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${id}`, '-f', `body=${body}`]);
      return r.ok ? { ok: true, id: r.data.id, url: r.data.html_url } : r;
    },
  };
}

function validatePayload(payload) {
  if (!isObject(payload)) throw new Error('payload must be a JSON object');
  const unknown = Object.keys(payload).filter((k) => !PAYLOAD_KEYS.includes(k));
  if (unknown.length > 0) throw new Error(`unknown payload key(s) ${unknown.join(', ')}; allowed: ${PAYLOAD_KEYS.join(', ')}`);
  if (typeof payload.repo !== 'string' || !REPO_RE.test(payload.repo) || payload.repo.length > 140 || payload.repo.startsWith('-') || payload.repo.startsWith('.')) throw new Error('repo is missing or malformed (owner/name)');
  if (!Number.isInteger(payload.pr) || payload.pr < 1 || payload.pr > 2147483647) throw new Error('pr is missing or not a positive integer');
  if (!isText(payload.repoRoot)) throw new Error('repoRoot is missing');
  if (payload.dryRun !== undefined && typeof payload.dryRun !== 'boolean') throw new Error('dryRun must be a boolean');
  if (payload.tier !== undefined && !isObject(payload.tier)) throw new Error('tier must be a pr-review-cli tier record');
  return payload;
}

function readStdinJson(fd = 0) {
  const chunks = [];
  let total = 0;
  const buf = Buffer.alloc(64 * 1024);
  for (;;) {
    let n;
    try {
      n = fs.readSync(fd, buf, 0, buf.length, null);
    } catch (err) {
      if (err.code === 'EAGAIN') continue;
      if (err.code === 'EOF') break;
      throw err;
    }
    if (n === 0) break;
    total += n;
    if (total > MAX_STDIN_BYTES) throw new Error(`payload exceeds ${MAX_STDIN_BYTES} bytes`);
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Entry point: resolves to the exit code. `injected` may replace `readJson`, `write` and `deps`. */
async function main(injected) {
  const io = { readJson: readStdinJson, write: (s) => process.stdout.write(s), ...(injected || {}) };
  const emit = (value) => io.write(`${JSON.stringify(redact(value))}\n`);
  let payload;
  try {
    payload = validatePayload(io.readJson());
  } catch (err) {
    emit({ ok: false, error: err.message });
    return 1;
  }
  try {
    const deps = (injected && injected.deps) || makeDeps(payload);
    const result = await runPrecheck({ dryRun: payload.dryRun, tier: payload.tier }, deps);
    emit(result);
    return result.ok === false ? 1 : 0;
  } catch (err) {
    emit({ ok: false, error: err && err.message ? err.message : String(err) });
    return 1;
  }
}

module.exports = { main, makeDeps, validatePayload, STATE_SUBDIR };

if (require.main === module) {
  main().then((code) => process.exit(code));
}
