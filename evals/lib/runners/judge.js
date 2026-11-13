'use strict';

/**
 * Judge runner: asks a model to score a transcript against a rubric.
 * The judging model must differ from the model under test (resolveJudge refuses otherwise).
 */

const { spawnSync } = require('child_process');

const norm = (m) => String(m || '').trim().toLowerCase();

/**
 * Decide whether judged checks may run. `judgeModel` comes from --judge-model, else EVALS_JUDGE_MODEL.
 * Returns { model, refusal }: `refusal` is a message naming the conflict, or null when allowed.
 */
function resolveJudge({ judgeModel, model, env = process.env } = {}) {
  const chosen = judgeModel || env.EVALS_JUDGE_MODEL || null;
  if (!chosen) {
    return { model: null, refusal: 'no judge model configured: set --judge-model or EVALS_JUDGE_MODEL' };
  }
  if (model && norm(chosen) === norm(model)) {
    return { model: chosen, refusal: `judge model "${chosen}" is the model under test; the judge must be a different model` };
  }
  return { model: chosen, refusal: null };
}

function judgePrompt(rubric, transcript) {
  return [
    'You are grading the output of an AI agent against a rubric.',
    'Reply with only a JSON object: {"score": <number from 0 to 1>, "reason": "<one sentence>"}.',
    '',
    '## Rubric',
    rubric,
    '',
    '## Agent transcript (tail)',
    String(transcript || '').slice(-8000),
  ].join('\n');
}

/** First JSON object in `text` that carries a numeric score, or null. */
function parseScore(text) {
  const match = String(text || '').match(/\{[^{}]*\}/g) || [];
  for (const candidate of match) {
    try {
      const o = JSON.parse(candidate);
      if (typeof o.score === 'number' && o.score >= 0 && o.score <= 1) return { score: o.score, reason: String(o.reason || '') };
    } catch { /* next */ }
  }
  return null;
}

/** Run the judge model via the claude CLI. Returns { score, reason, costUsd } or { error, costUsd }. */
function runJudge(bin, { model, rubric, transcript, cwd, timeoutMs = 120000 }) {
  const args = ['-p', judgePrompt(rubric, transcript), '--output-format', 'json', '--no-session-persistence',
    '--max-turns', '1', '--permission-mode', 'plan', '--model', model];
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) return { error: `judge call failed: ${(r.error && r.error.message) || `exit ${r.status}`}`, costUsd: null };
  let text = r.stdout || '';
  let costUsd = null;
  try {
    const o = JSON.parse(text);
    if (typeof o.result === 'string') text = o.result;
    costUsd = o.total_cost_usd ?? o.cost_usd ?? null;
  } catch { /* plain text reply */ }
  const parsed = parseScore(text);
  return parsed ? { ...parsed, costUsd } : { error: 'judge reply had no JSON score between 0 and 1', costUsd };
}

module.exports = { resolveJudge, runJudge, parseScore, judgePrompt };
