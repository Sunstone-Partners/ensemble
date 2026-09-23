#!/usr/bin/env node
'use strict';

/*
Tests for the PostToolUse test-failure observer (Step 5 of the
Ensemble-as-Behaviors plan). The observer records failing test runs to an
append-only .ensemble/learning-log.jsonl and hints the agent to classify
PATTERN vs ONE-OFF. It never edits any constitution file.
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OBSERVER = path.join(__dirname, '..', 'hooks', 'test-failure-observer.js');
const { emit, extractResult } = require('../hooks/test-failure-observer.js');

function tmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'observer-test-'));
}

function logPath(cwd) {
  return path.join(cwd, '.ensemble', 'learning-log.jsonl');
}

function readLog(cwd) {
  try {
    return fs
      .readFileSync(logPath(cwd), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return null;
  }
}

function runHook(payload, env = {}) {
  // Explicit env option — the same contract a stdio-launched hook gets.
  // (Jest-worker process.env mutation does not reliably propagate to
  // execFileSync children in this sandbox; see phrases.test.js precedent.)
  return execFileSync(process.execPath, [OBSERVER], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}

describe('test-failure observer (unit)', () => {
  test('failing test run appends one test_failure record', () => {
    const cwd = tmpCwd();
    const stdout = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
    try {
      emit(
        {
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          tool_response: 'Tests: 3 failed, 10 passed',
          session_id: 't1',
        },
        cwd,
      );
    } finally {
      process.stdout.write = orig;
    }
    const rows = readLog(cwd);
    expect(rows).not.toBeNull();
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('test_failure');
    expect(rows[0].command).toBe('npm test');
    expect(rows[0].excerpt).toContain('failed');
    expect(rows[0].session_id).toBe('t1');
    expect(typeof rows[0].ts).toBe('string');
    const out = JSON.parse(stdout.join(''));
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('PATTERN');
    expect(out.hookSpecificOutput.additionalContext).toContain('ONE-OFF');
  });

  test('repeated identical failure dedupes to one row', () => {
    const cwd = tmpCwd();
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      const payload = {
        tool_name: 'Bash',
        tool_input: { command: 'pytest tests/' },
        tool_response: '2 failed, 5 passed',
      };
      emit(payload, cwd);
      emit(payload, cwd);
    } finally {
      process.stdout.write = orig;
    }
    expect(readLog(cwd).length).toBe(1);
  });

  test('different failure after same command appends second row', () => {
    const cwd = tmpCwd();
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      emit({ tool_name: 'Bash', tool_input: { command: 'jest' }, tool_response: '1 failing' }, cwd);
      emit({ tool_name: 'Bash', tool_input: { command: 'jest' }, tool_response: '2 failing' }, cwd);
    } finally {
      process.stdout.write = orig;
    }
    expect(readLog(cwd).length).toBe(2);
  });

  test('non-test command never records', () => {
    const cwd = tmpCwd();
    emit({ tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_response: 'FAILED to list' }, cwd);
    expect(readLog(cwd)).toBeNull();
  });

  test('non-Bash tool never records', () => {
    const cwd = tmpCwd();
    emit({ tool_name: 'Edit', tool_input: { command: 'npm test' }, tool_response: '3 failed' }, cwd);
    expect(readLog(cwd)).toBeNull();
  });

  test('passing test run records nothing and prints nothing', () => {
    const cwd = tmpCwd();
    const stdout = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
    try {
      emit({ tool_name: 'Bash', tool_input: { command: 'mix test' }, tool_response: '12 tests, 0 failures' }, cwd);
    } finally {
      process.stdout.write = orig;
    }
    expect(readLog(cwd)).toBeNull();
    expect(stdout.join('')).toBe('');
  });

  test('extractResult falls back through tool_response/tool_result/output', () => {
    expect(extractResult({ tool_response: 'a' })).toBe('a');
    expect(extractResult({ tool_result: 'b' })).toBe('b');
    expect(extractResult({ output: 'c' })).toBe('c');
    expect(extractResult({ other: 1 })).toBe(JSON.stringify({ other: 1 }));
    expect(extractResult({ tool_response: { x: 1 } })).toBe('{"x":1}');
  });

  test('observer never modifies constitution files', () => {
    const cwd = tmpCwd();
    const doc = path.join(cwd, 'docs', 'standards', 'constitution.md');
    fs.mkdirSync(path.dirname(doc), { recursive: true });
    fs.writeFileSync(doc, '# Constitution\n');
    const before = fs.readFileSync(doc, 'utf8');
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      emit({ tool_name: 'Bash', tool_input: { command: 'go test ./...' }, tool_response: '--- FAIL: TestX\nFAIL\n' }, cwd);
    } finally {
      process.stdout.write = orig;
    }
    expect(fs.readFileSync(doc, 'utf8')).toBe(before);
  });
});

describe('test-failure observer (stdin contract)', () => {
  test('failing payload from stdin: one row + PostToolUse output, exit 0', () => {
    const cwd = tmpCwd();
    const out = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: 'Tests: 3 failed, 10 passed',
      session_id: 't1',
      cwd,
    });
    const rows = readLog(cwd);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('test_failure');
    const parsed = JSON.parse(out.trim());
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('PATTERN');
  });

  test('rerun of same failure dedupes to one row', () => {
    const cwd = tmpCwd();
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: 'Tests: 3 failed, 10 passed',
      session_id: 't1',
      cwd,
    };
    runHook(payload);
    runHook(payload);
    expect(readLog(cwd).length).toBe(1);
  });

  test('passing payload exits 0 and creates no .ensemble dir', () => {
    const cwd = tmpCwd();
    const out = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cargo test' },
      tool_response: 'test result: ok. 5 passed',
      cwd,
    });
    expect(out.trim()).toBe('');
    expect(fs.existsSync(path.join(cwd, '.ensemble'))).toBe(false);
  });

  test('malformed stdin exits 0 silently', () => {
    const out = runHook('not json {{{');
    expect(out.trim()).toBe('');
  });

  test('ENSEMBLE_BEHAVIORS_DISABLE=1 writes nothing', () => {
    const cwd = tmpCwd();
    const out = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: 'Tests: 9 failed, 0 passed',
        cwd,
      },
      { ENSEMBLE_BEHAVIORS_DISABLE: '1' },
    );
    expect(out.trim()).toBe('');
    expect(readLog(cwd)).toBeNull();
  });
});
