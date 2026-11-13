'use strict';

/**
 * Per-skill report: with-skill pass rate, baseline pass rate, their difference (uplift) and the reliability verdict.
 *   - Uplift is a number. No pass or fail is applied to it (PRD AC-014-2); the reliability verdict is a separate line
 *     about the with-skill arm against its bar.
 *   - An incomplete eval (a run not executed, a run whose isolation could not be verified, an aborted baseline) is
 *     marked INCOMPLETE and gets no rate, no uplift and no verdict. Such runs are never counted as passes or fails.
 *   - The uplift is always labelled with its granularity, taken from the runtime: Claude "package-level (skills share a
 *     package)", Pi "skill-level". The two are different quantities and are never presented as comparable.
 */

const results = require('./results');

const pct = (passes, runs) => `${Math.round((100 * passes) / runs)}%`;
const signed = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;

function armRow(a) {
  return a && Number.isInteger(a.runs) ? { passes: a.passes, runs: a.runs } : null;
}

/** Why an eval-level result cannot be scored (empty array when it can). */
function incompleteReasons(e) {
  const why = [];
  if (e.abort) return [`baseline arm aborted: ${e.abort}`];
  if (!e.withSkill || !e.baseline) why.push('an arm has no result');
  if (e.outcome === 'incomplete' || e.reliable === null || e.reliable === undefined) why.push('the eval did not finish');
  for (const [name, a] of [['with-skill', e.withSkill], ['baseline', e.baseline]]) {
    if (!a) continue;
    if (a.notRun > 0) why.push(`${name}: ${a.notRun} planned run(s) did not execute`);
    if (a.unverifiable > 0) why.push(`${name}: ${a.unverifiable} run(s) unverifiable (isolation could not be confirmed)`);
    if (!(a.runs > 0)) why.push(`${name}: no executed run`);
  }
  return [...new Set(why)];
}

/** One report row from an eval-level result (arms.summarizeEval output). */
function rowFromEval(e) {
  const granularity = results.granularityFor(e.runtime); // unknown runtime: named error
  const reasons = incompleteReasons(e);
  const base = {
    skill: e.skill, evalId: e.id, runtime: e.runtime, granularity, label: results.GRANULARITY_LABELS[granularity],
    repeats: e.repeats, bar: e.bar,
    executed: { withSkill: armRow(e.withSkill), baseline: armRow(e.baseline) },
  };
  if (reasons.length) {
    return { ...base, status: e.abort ? 'aborted' : 'incomplete', reasons, withSkill: null, baseline: null, uplift: null, reliable: null };
  }
  return {
    ...base, status: 'complete', reasons: [],
    withSkill: armRow(e.withSkill), baseline: armRow(e.baseline),
    uplift: e.withSkill.passes / e.withSkill.runs - e.baseline.passes / e.baseline.runs,
    reliable: e.reliable,
  };
}

/** One report row from a committed baseline summary (always complete: an incomplete eval is never stored). */
function rowFromBaseline(b) {
  return {
    skill: b.skill, evalId: b.skill, runtime: b.runtime, granularity: b.granularity, label: results.GRANULARITY_LABELS[b.granularity],
    repeats: b.repeats, bar: b.bar, status: 'complete', reasons: [], source: 'committed baseline', recordedAt: b.recordedAt,
    executed: { withSkill: armRow(b.withSkill), baseline: armRow(b.baseline) },
    withSkill: armRow(b.withSkill), baseline: armRow(b.baseline),
    uplift: b.withSkill.passes / b.withSkill.runs - b.baseline.passes / b.baseline.runs,
    reliable: b.reliable,
  };
}

const byKey = (a, b) => (a.skill + a.runtime + a.evalId < b.skill + b.runtime + b.evalId ? -1 : 1);

/** `{ rows }` from eval-level results (only skill evals with arms; legacy single-arm results have no uplift). */
function buildReport(evalResults) {
  const rows = evalResults.filter((e) => e && e.arms).map(rowFromEval).sort(byKey);
  return { rows, granularities: [...new Set(rows.map((r) => r.granularity))].sort() };
}

/** `{ rows }` from the committed summaries under `baselinesDir` (a corrupt file throws). */
function buildReportFromBaselines(baselinesDir) {
  const rows = results.loadAllBaselines(baselinesDir).map(rowFromBaseline).sort(byKey);
  return { rows, granularities: [...new Set(rows.map((r) => r.granularity))].sort() };
}

/** Report text. Uplift lines carry the granularity label and nothing that reads as a verdict. */
function formatReport(report) {
  const out = [];
  for (const r of report.rows) {
    out.push(`skill ${r.skill} [${r.runtime}]${r.source ? ` (${r.source}, recorded ${r.recordedAt})` : ''}`);
    if (r.status !== 'complete') {
      out.push(`  ${r.status === 'aborted' ? 'ABORTED' : 'INCOMPLETE'}: no score`);
      for (const why of r.reasons) out.push(`    ${why}`);
      const ex = r.executed;
      out.push(`    runs executed: with-skill ${ex.withSkill ? `${ex.withSkill.runs}/${r.repeats}` : 'n/a'}, baseline ${ex.baseline ? `${ex.baseline.runs}/${r.repeats}` : 'n/a'}`);
      continue;
    }
    out.push(`  with-skill rate ${r.withSkill.passes}/${r.withSkill.runs} (${pct(r.withSkill.passes, r.withSkill.runs)}); baseline rate ${r.baseline.passes}/${r.baseline.runs} (${pct(r.baseline.passes, r.baseline.runs)})`);
    out.push(`  uplift ${signed(r.uplift)} (${r.label})`);
    out.push(`  reliability: ${r.reliable ? 'reliable' : 'NOT reliable'} (with-skill bar ${r.bar} of ${r.repeats})`);
  }
  if (report.granularities.length > 1) {
    out.push('note: package-level and skill-level uplift are different quantities and are not comparable with each other.');
  }
  return out.join('\n');
}

module.exports = { buildReport, buildReportFromBaselines, formatReport, rowFromEval, rowFromBaseline, incompleteReasons };
