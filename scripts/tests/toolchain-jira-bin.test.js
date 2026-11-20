'use strict';
/**
 * The `full` bundle must ship the `jira` command the Jira tracker adapter invokes.
 *
 * Reporter finding F4: `packages/infrastructure/skills/adapter-tracker-jira/adapter.yaml`
 * invokes a `jira` binary that the bundle does NOT ship -- the adapter's own notes say no
 * `jira` binary existed when it was written, and the skill documentation pointed at a
 * globally `npm link`ed private package. Every Jira tracker call therefore failed
 * `MISSING_BINARY: jira` in an installed plugin. Claude Code puts a plugin's `bin/`
 * directory on PATH, so the bundle ships `packages/full/bin/jira`.
 *
 * The command is a dependency-free Node script (global `fetch`, no npm deps) speaking Jira
 * Cloud REST v3 with basic auth from `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN`.
 * Every test here runs against a LOCAL http server (no real network) and asserts the exact
 * request the adapter's manifest expects plus the JSON output shape the adapter's `parse`
 * block consumes.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const { loadAdapter } = require('../../packages/development/lib/toolchain/adapters');
const { mapOutput } = require('../../packages/development/lib/toolchain/mapping');

const REPO_ROOT = path.join(__dirname, '..', '..');
const JIRA_BIN = path.join(REPO_ROOT, 'packages', 'full', 'bin', 'jira');
const MANIFEST = loadAdapter('jira', { projectRoot: REPO_ROOT }).manifest;

const ADF_PARAGRAPH = {
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body text' }] }]
};

function issueFixture(key, statusName) {
  return {
    id: '10001',
    key,
    self: `https://jira.example/rest/api/3/issue/10001`,
    fields: {
      summary: 'Fix login timeout bug',
      description: ADF_PARAGRAPH,
      issuetype: { name: 'Bug' },
      status: { name: statusName },
      priority: { name: 'High' },
      labels: ['backend', 'auth']
    }
  };
}

/** A local Jira stand-in: records every request and answers the REST routes the CLI uses. */
function startServer({ empty = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch (error) {
          body = raw;
        }
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const url = new URL(req.url, 'http://127.0.0.1');
      const json = (status, payload) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
        res.end(text);
      };

      if (empty) {
        json(404, { errorMessages: [`no stub route for ${req.method} ${url.pathname}`] });
        return;
      }
      if (req.method === 'GET' && /^\/rest\/api\/3\/issue\/[^/]+$/.test(url.pathname)) {
        json(200, issueFixture('VA-1', 'To Do'));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/rest/api/3/search/jql') {
        json(200, { issues: [issueFixture('VA-1', 'To Do'), issueFixture('VA-2', 'In Progress')], isLast: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/rest/api/3/issue') {
        json(201, { id: '10002', key: 'VA-2', self: 'https://jira.example/rest/api/3/issue/10002' });
        return;
      }
      if (req.method === 'GET' && /^\/rest\/api\/3\/issue\/[^/]+\/transitions$/.test(url.pathname)) {
        json(200, {
          transitions: [
            { id: '11', name: 'Start', to: { name: 'In Progress' } },
            { id: '21', name: 'Done', to: { name: 'Done' } }
          ]
        });
        return;
      }
      if (req.method === 'POST' && /^\/rest\/api\/3\/issue\/[^/]+\/transitions$/.test(url.pathname)) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'PUT' && /^\/rest\/api\/3\/issue\/[^/]+$/.test(url.pathname)) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'POST' && /^\/rest\/api\/3\/issue\/[^/]+\/comment$/.test(url.pathname)) {
        json(201, { id: '10010', body: ADF_PARAGRAPH, author: { displayName: 'Ada' } });
        return;
      }
      if (req.method === 'GET' && /^\/rest\/api\/3\/issue\/[^/]+\/comment$/.test(url.pathname)) {
        json(200, { comments: [{ id: '10010', body: ADF_PARAGRAPH, author: { displayName: 'Ada' } }] });
        return;
      }
      json(404, { errorMessages: [`no stub route for ${req.method} ${url.pathname}`] });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        requests,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close(done);
          })
      });
    });
  });
}

/**
 * Spawn the shipped command. Asynchronous on purpose: `spawnSync` would block this
 * process' event loop, so the local HTTP server below could never answer the child.
 */
function runCli(args, { baseUrl, extraEnv = {}, stripEnv = [] } = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  for (const key of stripEnv) delete env[key];
  Object.assign(env, extraEnv);
  if (baseUrl) env.JIRA_BASE_URL = baseUrl;
  return new Promise((resolve) => {
    const child = spawn(JIRA_BIN, args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function authorizedEnv(baseUrl) {
  return {
    baseUrl,
    extraEnv: { JIRA_EMAIL: 'ada@example.com', JIRA_API_TOKEN: 'secret-token', JIRA_PROJECT_KEY: 'VA' }
  };
}

describe('the full bundle ships the jira command', () => {
  test('packages/full/bin/jira exists, is executable and is a node script', () => {
    expect(fs.existsSync(JIRA_BIN)).toBe(true);
    const stat = fs.statSync(JIRA_BIN);
    expect(stat.mode & 0o111).toBeGreaterThan(0);
    expect(stat.mode & 0o777).toBe(0o755);
    const source = fs.readFileSync(JIRA_BIN, 'utf8');
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  test('the shipped command needs no npm dependency beyond node builtins', () => {
    const source = fs.readFileSync(JIRA_BIN, 'utf8');
    const specifiers = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]);
    const builtins = new Set(require('module').builtinModules);
    for (const specifier of specifiers) {
      const bare = specifier.replace(/^node:/, '');
      expect(builtins.has(bare)).toBe(true);
    }
  });

  test('jira --version succeeds without any configuration (the adapter health check runs it)', async () => {
    const result = await runCli(['--version'], { stripEnv: ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'] });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^jira /);
  });
});

describe('the shipped jira command speaks the adapter contract', () => {
  let server;

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  beforeEach(() => {
    server.requests.length = 0;
  });

  test('issues read GETs the issue and prints the flat issue object the adapter parses', async () => {
    const result = await runCli(['issues', 'read', 'VA-1'], authorizedEnv(server.baseUrl));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    const request = server.requests[0];
    expect(request.method).toBe('GET');
    expect(request.url).toBe('/rest/api/3/issue/VA-1');
    expect(request.headers.authorization).toMatch(/^Basic /);

    const parsed = mapOutput(result.stdout, MANIFEST.capabilities['tracker.show'].parse);
    expect(parsed).toMatchObject({
      id: 'VA-1',
      title: 'Fix login timeout bug',
      description: 'Body text',
      type: 'Bug',
      status: 'open',
      priority: 'High',
      labels: ['backend', 'auth']
    });
  });

  test('the legacy ATLASSIAN_* names work as fallbacks so an existing setup keeps working', async () => {
    // The adapter manifest used to declare only the ATLASSIAN_* names; a setup
    // that already exports them must not lose its credentials.
    const result = await runCli(['issues', 'read', 'VA-1'], {
      extraEnv: {
        ATLASSIAN_SITE_URL: server.baseUrl,
        ATLASSIAN_EMAIL: 'ada@example.com',
        ATLASSIAN_AUTH_TOKEN: 'secret-token'
      }
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    const request = server.requests[0];
    expect(request.url).toBe('/rest/api/3/issue/VA-1');
    expect(request.headers.authorization).toMatch(/^Basic /);

    const parsed = mapOutput(result.stdout, MANIFEST.capabilities['tracker.show'].parse);
    expect(parsed).toMatchObject({ id: 'VA-1', status: 'open' });
  });

  test('issues list queries jql and prints the bare array the adapter parses', async () => {
    const result = await runCli(['issues', 'list', '--limit', '2', '--project', 'VA'], authorizedEnv(server.baseUrl));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    const request = server.requests[0];
    expect(request.method).toBe('GET');
    expect(request.url).toContain('/rest/api/3/search/jql?');
    expect(decodeURIComponent(request.url)).toContain('project = "VA"');
    expect(decodeURIComponent(request.url)).toContain('maxResults=2');

    const parsed = mapOutput(result.stdout, MANIFEST.capabilities['tracker.list'].parse);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({ id: 'VA-1', title: 'Fix login timeout bug' });
  });

  test('issues create POSTs the issue and prints the created key', async () => {
    const result = await runCli(
      ['issues', 'create', 'Fix login timeout bug', '--type', 'Bug', '--description', 'Body text'],
      authorizedEnv(server.baseUrl)
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    const request = server.requests[0];
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/rest/api/3/issue');
    expect(request.body.fields.summary).toBe('Fix login timeout bug');
    expect(request.body.fields.issuetype).toEqual({ name: 'Bug' });
    expect(request.body.fields.project).toEqual({ key: 'VA' });
    expect(request.body.fields.description.type).toBe('doc');

    const parsed = mapOutput(result.stdout, MANIFEST.capabilities['tracker.create'].parse);
    expect(parsed.id).toBe('VA-2');
  });

  test('issues update --summary edits the issue and prints its flat object', async () => {
    const result = await runCli(['issues', 'update', 'VA-1', '--summary', 'New summary'], authorizedEnv(server.baseUrl));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    const update = server.requests[0];
    expect(update.method).toBe('PUT');
    expect(update.url).toBe('/rest/api/3/issue/VA-1');
    expect(update.body.fields.summary).toBe('New summary');

    const parsed = mapOutput(result.stdout, MANIFEST.capabilities['tracker.update'].parse);
    expect(parsed.id).toBe('VA-1');
  });

  test('issues update --status transitions the issue and prints the new status', async () => {
    const result = await runCli(['issues', 'update', 'VA-1', '--status', 'In Progress'], authorizedEnv(server.baseUrl));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    const [transitionList, transition, reread] = server.requests;
    expect(transitionList.method).toBe('GET');
    expect(transitionList.url).toBe('/rest/api/3/issue/VA-1/transitions');
    expect(transition.method).toBe('POST');
    expect(transition.url).toBe('/rest/api/3/issue/VA-1/transitions');
    expect(transition.body).toEqual({ transition: { id: '11' } });
    expect(reread.method).toBe('GET');

    const parsed = mapOutput(result.stdout, MANIFEST.capabilities['tracker.set-status'].parse);
    expect(parsed.id).toBe('VA-1');
    expect(parsed.status).toBe('in_progress');
  });

  test('comments create POSTs the comment and prints the comment id', async () => {
    const result = await runCli(['comments', 'create', 'VA-1', '--body', 'Looks good'], authorizedEnv(server.baseUrl));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    const request = server.requests[0];
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/rest/api/3/issue/VA-1/comment');
    expect(request.body.body.type).toBe('doc');

    const parsed = mapOutput(result.stdout, MANIFEST.capabilities['tracker.comment'].parse);
    expect(parsed.id).toBe('10010');
  });

  test('comments list GETs the comments and prints the bare array the adapter parses', async () => {
    const result = await runCli(['comments', 'list', 'VA-1'], authorizedEnv(server.baseUrl));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    const request = server.requests[0];
    expect(request.method).toBe('GET');
    expect(request.url).toContain('/rest/api/3/issue/VA-1/comment');

    const parsed = mapOutput(result.stdout, MANIFEST.capabilities['tracker.comments'].parse);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].id).toBe('10010');
  });
});

describe('the shipped jira command fails loudly and clearly', () => {
  test('missing configuration prints one stderr line and exits non-zero', async () => {
    const result = await runCli(['issues', 'read', 'VA-1'], { stripEnv: ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'] });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    const lines = result.stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/JIRA_BASE_URL/);
    expect(lines[0]).toMatch(/JIRA_EMAIL/);
    expect(lines[0]).toMatch(/JIRA_API_TOKEN/);
  });

  test('an HTTP error prints one stderr line and exits non-zero', async () => {
    const server = await startServer({ empty: true });
    try {
      const result = await runCli(['issues', 'read', 'VA-1'], {
        baseUrl: server.baseUrl,
        extraEnv: { JIRA_EMAIL: 'ada@example.com', JIRA_API_TOKEN: 'secret-token' }
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      const lines = result.stderr.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/HTTP 404/);
    } finally {
      await server.close();
    }
  });
});
