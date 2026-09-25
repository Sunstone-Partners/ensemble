#!/usr/bin/env node
'use strict';

/*
PostToolUse Test Failure Observer.

Watches Bash tool invocations for failing test runs. When one is detected it
appends a single record to an append-only learning log and surfaces a hint that
asks the agent to classify the failure as a PATTERN (systemic, rule-worthy) or a
ONE-OFF (unique bug) before continuing. It never edits the constitution itself;
durable guardrails reach docs/standards/constitution.md only via a reviewed
proposal (see the pr-merge "Constitution Learning Capture" precedent).

Stdin contract (same shape as permitter.js):
    { tool_name, tool_input: { command }, tool_response | tool_result | output,
      session_id, cwd }

Every failure mode exits 0 so a broken observer can never block a tool call.
Debug output goes to stderr only when ENSEMBLE_BEHAVIORS_DEBUG === '1'.
*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_DIR = '.ensemble';
const LOG_FILE = 'learning-log.jsonl';
const ENVELOPE_DIR = '.ensemble/events';
const ENVELOPE_FILE = 'incoming.jsonl';

const TEST_COMMAND_RE =
  /(npm|pnpm|yarn)\s+(run\s+)?test\b|\bjest\b|\bvitest\b|\bpytest\b|\bgo test\b|\bcargo test\b|\bmvn test\b|\bdotnet test\b|\brspec\b|\bmix test\b/;

const FAILURE_RE =
  /\b\d+\s+failing\b|\b\d+\s+failed\b|\bFAIL\b|\bFAILED\b|AssertionError|\u2715/;

function debug(message) {
  if (process.env.ENSEMBLE_BEHAVIORS_DEBUG === '1') {
    console.error(`[BEHAVIORS DEBUG] ${message}`);
  }
}

function extractResult(hookData) {
  let result = hookData.tool_response;
  if (result === undefined) result = hookData.tool_result;
  if (result === undefined) result = hookData.output;
  if (result === undefined) result = JSON.stringify(hookData);
  if (typeof result !== 'string') result = JSON.stringify(result);
  return result;
}

function readLastLine(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    if (!lines.length) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

function appendRecord(record, cwd) {
  const dir = path.join(cwd, LOG_DIR);
  const file = path.join(dir, LOG_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
  return file;
}

// AC-023 (TRD-013): alongside the learning-log record, emit a normalized
// envelope to the behavior event bus (append-only JSONL). The observer stays
// as transport; Events.Local / Matcher can now consume canonical envelopes.
function appendEnvelope(event, cwd) {
  const dir = path.join(cwd, ENVELOPE_DIR);
  const file = path.join(dir, ENVELOPE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(event) + '\n');
  return file;
}

function toEnvelope(record) {
  return {
    schema_version: 1,
    event_id: crypto.randomUUID(),
    event_type: 'test.failed',
    source: 'local',
    subject_id: record.command,
    actor: { type: 'ci', id: record.session_id },
    payload: {
      command: record.command,
      exit_code: record.exit_code,
      excerpt: record.excerpt,
      session_id: record.session_id,
      cwd: record.cwd,
    },
    occurred_at: record.ts,
    emitted_at: new Date().toISOString(),
    causal_parent: null,
  };
}

function emit(hookData, cwd) {
  const command = String((hookData.tool_input && hookData.tool_input.command) || hookData.command || '');
  const result = extractResult(hookData);
  // Only Bash (tool_name or the legacy `tool` field).
  const toolName = hookData.tool_name || hookData.tool;
  if (toolName !== 'Bash') return;

  // Only test-runner commands.
  if (!TEST_COMMAND_RE.test(command)) return;

  // Only failures.
  const m = result.match(FAILURE_RE);
  if (!m) return;

  const matchIndex = m.index !== undefined ? m.index : result.search(FAILURE_RE);
  const excerpt = result.slice(matchIndex, matchIndex + 500);
  const record = {
    ts: new Date().toISOString(),
    kind: 'test_failure',
    command,
    exit_code:
      hookData.tool_input && typeof hookData.tool_input.exit_code === 'number'
        ? hookData.tool_input.exit_code
        : typeof hookData.exit_code === 'number'
          ? hookData.exit_code
          : null,
    excerpt,
    session_id: hookData.session_id || null,
    cwd,
  };

  // Dedupe: skip if the previous record has the same command + excerpt.
  const dir = path.join(cwd, LOG_DIR);
  const file = path.join(dir, LOG_FILE);
  const last = readLastLine(file);
  let appended = false;
  if (last && last.command === record.command && last.excerpt === record.excerpt) {
    debug('duplicate record, skipping append');
  } else {
    appendRecord(record, cwd);
    try {
      appendEnvelope(toEnvelope(record), cwd);
    } catch (e) {
      debug(`envelope emit failed: ${e.message}`);
    }
    appended = true;
  }

  const additionalContext =
    'A test run failed and was recorded to .ensemble/learning-log.jsonl. ' +
    'Before moving on, classify this failure: PATTERN (a systemic, repeatable mistake ' +
    'worth a durable rule) or ONE-OFF (a unique bug with no generalizable lesson). ' +
    'Only if PATTERN, propose one guardrail for docs/standards/constitution.md as a ' +
    'reviewed change - never edit the constitution silently.';

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext,
      },
    }) + '\n',
  );
  if (appended) debug(`recorded failure: ${command}`);
}

function main(rawInput) {
  if (process.env.ENSEMBLE_BEHAVIORS_DISABLE === '1') {
    process.exit(0);
  }

  let hookData;
  try {
    hookData = JSON.parse(rawInput);
  } catch (e) {
    debug(`unparseable stdin: ${e.message}`);
    process.exit(0);
  }
  if (!hookData || typeof hookData !== 'object') process.exit(0);

  const cwd = hookData.cwd || process.cwd();
  try {
    emit(hookData, cwd);
  } catch (e) {
    debug(`emit error: ${e.message}`);
  }
  process.exit(0);
}

if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  process.stdin.on('end', () => main(data));
  process.stdin.on('error', (err) => {
    debug(`stdin error: ${err.message}`);
    process.exit(0);
  });
}

module.exports = { emit, main, extractResult, readLastLine, TEST_COMMAND_RE, FAILURE_RE };
