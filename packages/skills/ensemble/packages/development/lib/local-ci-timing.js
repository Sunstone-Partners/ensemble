'use strict';

/**
 * Local CI gate speed and fidelity measurement (REQ-013, REQ-009).
 *
 * Pure functions plus one file read (checkEnablementReady with notePath).
 * No network. FAIL CLOSED: a missing figure is reported as missing, never as
 * zero or a guess; comparisons across different head SHAs are refused; a note
 * that is absent, still the unfilled template, or lacks a verdict does not
 * satisfy the enablement gate. No speed target is ever asserted.
 */

const fs = require('fs');

const VERDICTS = ['faster', 'slower', 'equal', 'unmeasured'];
const JOB_STATUSES = ['pass', 'fail', 'cannot-run'];
const NOT_PRESENT = 'not-present';
const TEMPLATE_MARKER = 'TEMPLATE-UNFILLED';

const SLOWER_SENTENCE =
  'The local gate is slower than hosted CI; the benefit for this repository comes from ' +
  'removing the bot-review wait, not from run time.';
const VERDICT_LINE_RE = /^Verdict: (faster|slower|equal|unmeasured)\s*$/m;

function fail(error) {
  return { ok: false, error };
}

/** Normalize one duration (ms). Returns {ms} or {ms:null,missing:true} or {error}. */
function figure(value, label) {
  if (value === undefined || value === null) return { ms: null, missing: true };
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return { error: `${label} must be a positive finite number of milliseconds or absent` };
  }
  return { ms: value, missing: false };
}

/**
 * Compare local against hosted. toleranceMs is REQUIRED and explicit: the
 * results are "equal" when they differ by no more than it.
 */
function verdict(localMs, hostedMs, toleranceMs) {
  if (typeof toleranceMs !== 'number' || !Number.isFinite(toleranceMs) || toleranceMs < 0) {
    return fail('toleranceMs must be a non-negative number');
  }
  for (const [k, v] of [['localMs', localMs], ['hostedMs', hostedMs]]) {
    if (v === undefined || v === null) return { ok: true, verdict: 'unmeasured' };
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      return fail(`${k} must be a positive finite number or absent`);
    }
  }
  const diff = localMs - hostedMs;
  let result = 'equal';
  if (diff > toleranceMs) result = 'slower';
  else if (diff < -toleranceMs) result = 'faster';
  return { ok: true, verdict: result };
}

/**
 * input: { headSha?, period?, basis?: 'cold'|'warm', toleranceMs,
 *          versions: { '<node>': { coldMs, warmMs, hostedMs } },
 *          local?: {headSha, jobs}, hosted?: {headSha, jobs} }
 * The overall verdict uses `basis` (default 'cold', the conservative one):
 * any unmeasured version => unmeasured; any slower => slower; otherwise any
 * faster => faster; otherwise equal.
 */
function recordTimings(input) {
  if (input === null || typeof input !== 'object') return fail('input must be an object');
  const { versions, toleranceMs, period } = input;
  const basis = input.basis === undefined ? 'cold' : input.basis;
  if (basis !== 'cold' && basis !== 'warm') return fail("basis must be 'cold' or 'warm'");
  if (versions === null || typeof versions !== 'object' || Array.isArray(versions)) {
    return fail('versions must be an object keyed by Node version');
  }
  const names = Object.keys(versions);
  if (names.length === 0) return fail('versions must name at least one Node version');

  const rows = [];
  for (const node of names) {
    const v = versions[node];
    if (v === null || typeof v !== 'object') return fail(`versions.${node} must be an object`);
    const cold = figure(v.coldMs, `${node} coldMs`);
    const warm = figure(v.warmMs, `${node} warmMs`);
    const hosted = figure(v.hostedMs, `${node} hostedMs`);
    for (const f of [cold, warm, hosted]) if (f.error) return fail(f.error);
    const local = basis === 'cold' ? cold : warm;
    const vr = verdict(local.ms, hosted.ms, toleranceMs);
    if (!vr.ok) return vr;
    const anyMissing = cold.missing || warm.missing || hosted.missing;
    rows.push({ node, cold, warm, hosted, verdict: anyMissing ? 'unmeasured' : vr.verdict });
  }

  let overall;
  if (rows.some((r) => r.verdict === 'unmeasured')) overall = 'unmeasured';
  else if (rows.some((r) => r.verdict === 'slower')) overall = 'slower';
  else if (rows.some((r) => r.verdict === 'faster')) overall = 'faster';
  else overall = 'equal';

  let gaps = null;
  if (input.local !== undefined || input.hosted !== undefined) {
    const g = fidelityGaps(input.local, input.hosted);
    if (!g.ok) return g;
    gaps = g.gaps;
  }

  return {
    ok: true,
    period: typeof period === 'string' ? period : null,
    basis,
    toleranceMs,
    rows,
    verdict: overall,
    gaps,
    headSha: gaps === null ? null : input.local.headSha,
  };
}

function checkResults(side, name) {
  if (side === null || typeof side !== 'object') return `${name} results must be an object`;
  if (typeof side.headSha !== 'string' || side.headSha.trim() === '') {
    return `${name}.headSha must be a non-empty string`;
  }
  if (side.jobs === null || typeof side.jobs !== 'object' || Array.isArray(side.jobs)) {
    return `${name}.jobs must be an object of job name to status`;
  }
  for (const [job, status] of Object.entries(side.jobs)) {
    if (!JOB_STATUSES.includes(status)) {
      return `${name}.jobs.${job} must be one of ${JOB_STATUSES.join(', ')}`;
    }
  }
  return null;
}

/**
 * local/hosted: { headSha, jobs: { '<job>': 'pass'|'fail'|'cannot-run' } }.
 * A job absent from one side is 'not-present'. A gap is any job that passes on
 * one side and fails, cannot run, or is not present on the other.
 */
function fidelityGaps(local, hosted) {
  const bad = checkResults(local, 'local') || checkResults(hosted, 'hosted');
  if (bad) return fail(bad);
  if (local.headSha !== hosted.headSha) {
    return fail(
      `cannot compare results for different head commits: local ${local.headSha} vs hosted ${hosted.headSha}`
    );
  }
  const jobs = [...new Set([...Object.keys(local.jobs), ...Object.keys(hosted.jobs)])].sort();
  const gaps = [];
  for (const job of jobs) {
    const l = Object.prototype.hasOwnProperty.call(local.jobs, job) ? local.jobs[job] : NOT_PRESENT;
    const h = Object.prototype.hasOwnProperty.call(hosted.jobs, job) ? hosted.jobs[job] : NOT_PRESENT;
    if ((l === 'pass') !== (h === 'pass')) gaps.push({ job, local: l, hosted: h });
  }
  return { ok: true, gaps };
}

function fmt(f) {
  return f.missing ? 'MISSING' : `${(f.ms / 1000).toFixed(1)}s`;
}

/** Render the measurement note text. Accepts the result of recordTimings. */
function renderNote(comparison) {
  if (!comparison || comparison.ok !== true || !Array.isArray(comparison.rows)) {
    return fail('comparison must be a successful recordTimings result');
  }
  const lines = [];
  lines.push('# Local CI Gate - Speed and Fidelity Measurement');
  lines.push('');
  if (comparison.period) lines.push(`Period: ${comparison.period}`);
  if (comparison.headSha) lines.push(`Head commit compared: ${comparison.headSha}`);
  lines.push(`Basis for verdict: ${comparison.basis} local run vs hosted; equal means within ${comparison.toleranceMs} ms.`);
  lines.push('');
  lines.push('| Node | Local cold | Local warm | Hosted | Verdict |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of comparison.rows) {
    lines.push(`| ${r.node} | ${fmt(r.cold)} | ${fmt(r.warm)} | ${fmt(r.hosted)} | ${r.verdict} |`);
  }
  lines.push('');
  lines.push(`Verdict: ${comparison.verdict}`);
  lines.push('');
  if (comparison.verdict === 'slower') lines.push(SLOWER_SENTENCE);
  else if (comparison.verdict === 'unmeasured') {
    lines.push('Speed comparison is NOT measured: at least one figure is missing.');
  } else if (comparison.verdict === 'equal') {
    lines.push('Local and hosted run times are equal within the stated tolerance; no run-time speedup is claimed.');
  } else {
    lines.push('Local was faster on the measured run times; no target is asserted.');
  }
  lines.push('');
  lines.push('## Fidelity gaps');
  if (comparison.gaps === null) lines.push('Not assessed: no local and hosted results were supplied.');
  else if (comparison.gaps.length === 0) lines.push('None: every job agrees between local and hosted.');
  else for (const g of comparison.gaps) lines.push(`- ${g.job}: local ${g.local}, hosted ${g.hosted}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Runbook gate check. input: { notePath } or { note }.
 * ok only for a filled note that states faster, slower or equal (a slower note
 * must also carry the bot-review-wait statement).
 */
function checkEnablementReady(input) {
  if (input === null || typeof input !== 'object') return { ok: false, reason: 'input must be an object' };
  let text = input.note;
  if (text === undefined) {
    if (typeof input.notePath !== 'string' || input.notePath === '') {
      return { ok: false, reason: 'no measurement note: provide notePath or note' };
    }
    try {
      text = fs.readFileSync(input.notePath, 'utf8');
    } catch (e) {
      return { ok: false, reason: `no measurement note at ${input.notePath}` };
    }
  }
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: 'measurement note is empty' };
  }
  if (text.includes(TEMPLATE_MARKER)) {
    return { ok: false, reason: 'measurement note is still the unfilled template' };
  }
  const m = VERDICT_LINE_RE.exec(text);
  if (!m) return { ok: false, reason: 'measurement note does not state a verdict' };
  if (m[1] === 'unmeasured') {
    return { ok: false, reason: 'measurement note states the comparison is unmeasured' };
  }
  if (m[1] === 'slower' && !text.includes('removing the bot-review wait')) {
    return { ok: false, reason: 'slower verdict must state the benefit comes from removing the bot-review wait' };
  }
  return { ok: true, verdict: m[1] };
}

module.exports = {
  VERDICTS,
  TEMPLATE_MARKER,
  SLOWER_SENTENCE,
  verdict,
  recordTimings,
  fidelityGaps,
  renderNote,
  checkEnablementReady,
};
