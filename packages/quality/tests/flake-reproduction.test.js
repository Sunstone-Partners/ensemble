'use strict';

/**
 * Structural and behavioural checks for the flake-reproduction skill
 * (PRD-2026-bd69b524 REQ-034, REQ-035). Each check can fail: the capture loop is run against
 * commands whose failures are scripted, and the file checks read the shipped sources.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SKILL_DIR = path.join(REPO, 'packages', 'quality', 'skills', 'flake-reproduction');
const SKILL = path.join(SKILL_DIR, 'SKILL.md');
const LOOP = path.join(SKILL_DIR, 'capture-loop.sh');

const read = (p) => fs.readFileSync(p, 'utf8');

describe('flake-reproduction skill sources', () => {
  const text = read(SKILL);

  test('frontmatter parses and names the directory', () => {
    const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
    expect(match).not.toBeNull();
    const meta = yaml.load(match[1]);
    expect(meta.name).toBe('flake-reproduction');
    expect(typeof meta.description).toBe('string');
    expect(meta.description.length).toBeGreaterThan(40);
  });

  test('brief names the private database, the handle replay, the run-count rule and the time box (AC-035-1)', () => {
    expect(text).toMatch(/private database/i);
    expect(text).toMatch(/replay the logged handle/i);
    expect(text).toMatch(/3\/p/);
    expect(text).toMatch(/time box/i);
    expect(text).toMatch(/park the bead/i);
  });

  test('forbids retry, quarantine, skip, wider timeout and weaker assertion (REQ-033)', () => {
    for (const word of ['retrying', 'quarantining', 'skipping', 'widening a timeout', 'weakening an assertion']) {
      expect(text).toContain(word);
    }
  });

  test('run-count table matches 3/p rounded up', () => {
    const rows = [...text.matchAll(/^\s*\| ([\d.]+)% \| (\d+) \|$/gm)];
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const [, pct, n] of rows) {
      const p = Number(pct) / 100;
      expect(Number(n)).toBe(Math.ceil(Math.log(0.05) / Math.log(1 - p)));
    }
  });

  test('every file named in the Files section exists', () => {
    const files = [...text.slice(text.indexOf('## Files')).matchAll(/^- `([^`/ ][^`]*?)`/gm)].map((m) => m[1]);
    expect(files).toEqual(expect.arrayContaining(['red-run-record.md', 'capture-loop.sh']));
    for (const f of files) expect(fs.existsSync(path.join(SKILL_DIR, f))).toBe(true);
  });

  test('stack-specific mechanics stay out of the neutral rules', () => {
    const rules = text.slice(0, text.indexOf('## Files')); // the Files index may name the example recipe
    for (const word of ['mix ', 'ExUnit', 'Foreman', 'Elixir']) expect(rules).not.toContain(word);
  });
});

describe('stack recipes', () => {
  const load = (f) => yaml.load(read(path.join(SKILL_DIR, 'recipes', f)));

  test('the worked example fills every field of the template', () => {
    const template = load('stack-template.yaml');
    const example = load('elixir-mix.yaml');
    expect(Object.keys(example).sort()).toEqual(Object.keys(template).sort());
    for (const key of ['ci_command', 'private_database', 'bounded_pool', 'deterministic_order']) {
      expect(String(example[key]).length).toBeGreaterThan(10);
    }
    expect(example.partition.replay_command).toMatch(/--seed N/);
    expect(example.hygiene_guards[0].name).toBe('ProjectionLeakGuard');
  });

  test('commands stay data: no inline code spans, so the provider-reference lint reads them as data', () => {
    for (const f of ['stack-template.yaml', 'elixir-mix.yaml']) expect(read(path.join(SKILL_DIR, 'recipes', f))).not.toContain('`');
  });
});

describe('red-run record (REQ-034)', () => {
  const record = read(path.join(SKILL_DIR, 'red-run-record.md'));

  test('JSON template parses and carries the REQ-034 fields', () => {
    const json = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(record)[1]);
    for (const key of ['run', 'job', 'commit', 'class', 'failing_tests', 'first_error', 'handle', 'partition', 'replay_command', 'log', 'replay_result', 'cause', 'fix_pr']) {
      expect(json).toHaveProperty(key);
    }
    expect(json.handle).toHaveProperty('kind');
    expect(json.handle).toHaveProperty('value');
    expect(json.cause).toHaveProperty('status');
  });

  test('allows a re-run only for an infrastructure failure, only as a recorded operator action', () => {
    const json = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(record)[1]);
    expect(json).toHaveProperty('infra_rerun');
    expect(record).toMatch(/Infrastructure re-run \(infrastructure only\)/);
    expect(record).toMatch(/recorded operator action/);
    expect(record).toMatch(/never automate|never automatic/i);
    expect(record).toMatch(/after the test command started is never re-run/);
    expect(record).toMatch(/may be set only when `class` is `infrastructure`/);
    const skill = read(SKILL);
    expect(skill).toMatch(/only as a recorded operator action/);
    expect(skill).toMatch(/never re-run a job that failed after the test command started/);
    expect(skill).toMatch(/Never automate it/);
  });

  test('defines the three classes and names the guard for guard-only', () => {
    for (const cls of ['failing-test', 'guard-only', 'infrastructure']) expect(record).toContain(cls);
    expect(record).toMatch(/Guard \(guard-only only\)/);
  });
});

describe('reachability from the shipped entry points (REQ-044)', () => {
  test('ensemble-full mirrors the skill by symlink', () => {
    const link = path.join(REPO, 'packages', 'full', 'skills', 'flake-reproduction');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(SKILL_DIR));
  });

  test('the Pi copy ships the skill and every file it references', () => {
    const pi = path.join(REPO, 'packages', 'pi', 'skills', 'flake-reproduction');
    for (const f of ['SKILL.md', 'red-run-record.md', 'capture-loop.sh', 'recipes/elixir-mix.yaml', 'recipes/stack-template.yaml']) {
      expect(fs.existsSync(path.join(pi, f))).toBe(true);
    }
  });

  test('deep-debugger keeps the 3-attempt stop for every non-flaky failure', () => {
    const src = read(path.join(REPO, 'packages/quality/agents/deep-debugger.yaml')).replace(/\s+/g, ' ');
    const original = 'If it cannot be reproduced after 3 attempts, stop and escalate with what was tried.';
    expect(src).toContain(original);
    const after = src.slice(src.indexOf(original) + original.length);
    const addition = after.slice(0, after.indexOf('- priority'));
    expect(addition).toMatch(/Only for an intermittent, partition-dependent or order-dependent failure/);
    expect(addition).toMatch(/Every other failure keeps the 3-attempt limit above/);
    expect(addition).toMatch(/Never add a retry, quarantine, skip, wider timeout or weaker assertion/);
  });

  test('deep-debugger loads the skill for flaky failures, in source and in each generated copy', () => {
    const copies = [
      'packages/quality/agents/deep-debugger.yaml',
      'packages/quality/agents/deep-debugger.md',
      'packages/pi/agents/deep-debugger.md',
      'packages/codex/.codex/agents/deep-debugger.toml',
    ];
    for (const c of copies) expect(read(path.join(REPO, c))).toContain('flake-reproduction');
  });
});

describe('capture-loop.sh', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flake-loop-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (env, args) =>
    spawnSync('bash', [LOOP, '--', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, OUT_DIR: 'out', ...env } });

  // Fails on every third invocation and prints a two-line "log" containing a seed.
  const everyThird = () => {
    const counter = path.join(dir, 'counter');
    return [
      'sh',
      '-c',
      'n=$(($(cat "$0" 2>/dev/null || echo 0)+1)); echo $n > "$0"; echo "seed: $n"; echo "full output line"; [ $((n % 3)) -ne 0 ]',
      counter,
    ];
  };

  test('keeps the full output of every failing run, stops at STOP_AFTER and exits 1', () => {
    const r = run({ RUNS: '50', STOP_AFTER: '2' }, everyThird());
    expect(r.status).toBe(1);
    expect(fs.readdirSync(path.join(dir, 'out')).sort()).toEqual(['fail-3.log', 'fail-6.log', 'runs.tsv']);
    expect(read(path.join(dir, 'out', 'fail-3.log'))).toBe('seed: 3\nfull output line\n');
    expect(read(path.join(dir, 'out', 'fail-6.log'))).toContain('seed: 6');
    const rows = read(path.join(dir, 'out', 'runs.tsv')).trim().split('\n');
    expect(rows).toHaveLength(7); // header + 6 runs
    expect(rows[3].split('\t').slice(0, 2)).toEqual(['3', '1']);
    expect(r.stdout).toMatch(/runs: 6 {2}failures: 2/);
  });

  test('stops at the run bound with no failure, says it is not proof, exits 0', () => {
    const r = run({ RUNS: '4', STOP_AFTER: '2' }, ['true']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/runs: 4 {2}failures: 0/);
    expect(r.stdout).toMatch(/does not show the test is fixed/);
    expect(fs.readdirSync(path.join(dir, 'out'))).toEqual(['runs.tsv']);
  });

  test('never retries: a failing command is run once per run', () => {
    const counter = path.join(dir, 'c2');
    const r = run({ RUNS: '1', STOP_AFTER: '1' }, ['sh', '-c', 'echo x >> "$0"; exit 1', counter]);
    expect(r.status).toBe(1);
    expect(read(counter).trim().split('\n')).toHaveLength(1);
  });

  test('refuses more burners than half the logical cores and bad input', () => {
    const cores = Number(spawnSync('getconf', ['_NPROCESSORS_ONLN'], { encoding: 'utf8' }).stdout) || 2;
    expect(run({ BURNERS: String(Math.floor(cores / 2) + 1) }, ['true']).status).toBe(2);
    expect(run({ RUNS: 'abc' }, ['true']).status).toBe(2);
    expect(run({ RUNS: '0' }, ['true']).status).toBe(2);
    expect(spawnSync('bash', [LOOP], { cwd: dir }).status).toBe(2);
  });

  test('holds the burners while running and leaves none behind', () => {
    const cores = Number(spawnSync('getconf', ['_NPROCESSORS_ONLN'], { encoding: 'utf8' }).stdout) || 2;
    if (cores < 2) return;
    const seen = path.join(dir, 'burners');
    const r = run({ RUNS: '1', BURNERS: '1' }, ['sh', '-c', 'pgrep -P $PPID | grep -vx $$ > "$0"', seen]);
    expect(r.status).toBe(0);
    const pids = read(seen).trim().split('\n').filter(Boolean);
    expect(pids.length).toBeGreaterThanOrEqual(1); // the burner existed during the run
    for (const pid of pids) expect(spawnSync('kill', ['-0', pid]).status).not.toBe(0);
  });
});
