'use strict';

/**
 * Estimate-vs-actual for closed beads. Used by /ensemble:retro.
 *
 * Estimate: the hour estimate create-trd puts in task text: `(Nh)` or `(Est: Nh)`;
 * the title is searched before the description. Actual: closed_at - created_at
 * (br 0.6.0 has no started_at). Open beads and beads without a valid closed
 * timestamp are excluded; closed beads without an estimate only bump
 * summary.withoutEstimate.
 *
 * CLI: node lib/estimate-actual.js --issues-json <file>   (br list --all --json shape, or a bare array)
 */

const fs = require('fs');

const HOURS_MS = 3600 * 1000;
const ESTIMATE_RE = /\(\s*(?:est(?:imate)?\s*:?\s*)?(\d+(?:\.\d+)?)\s*h\b/i;

function extractEstimateHours(issue) {
  for (const text of [issue.title, issue.description]) {
    const m = ESTIMATE_RE.exec(text || '');
    if (m) return Number(m[1]);
  }
  return null;
}

function actualHours(issue) {
  if (issue.status !== 'closed') return null;
  const start = Date.parse(issue.created_at);
  const end = Date.parse(issue.closed_at);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return (end - start) / HOURS_MS;
}

/** Nearest-rank percentile of a numeric array (p in 0..100); null when empty. */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function round(n, digits = 2) {
  return n === null ? null : Number(n.toFixed(digits));
}

function computeEstimateActual(issues) {
  const beads = [];
  let withoutEstimate = 0;
  for (const issue of issues || []) {
    const actualH = actualHours(issue);
    if (actualH === null) continue;
    const estimateH = extractEstimateHours(issue);
    if (estimateH === null || estimateH <= 0) {
      withoutEstimate += 1;
      continue;
    }
    beads.push({
      id: issue.id,
      estimateH,
      actualH: round(actualH),
      ratio: round(actualH / estimateH),
    });
  }
  const ratios = beads.map((b) => b.ratio);
  return {
    beads,
    summary: {
      count: beads.length,
      medianRatio: percentile(ratios, 50),
      p90Ratio: percentile(ratios, 90),
      withoutEstimate,
    },
  };
}

function parseIssues(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  return Array.isArray(data) ? data : data.issues || [];
}

function main(argv) {
  const i = argv.indexOf('--issues-json');
  if (i === -1 || !argv[i + 1]) {
    process.stderr.write('usage: node estimate-actual.js --issues-json <file>\n');
    return 2;
  }
  const result = computeEstimateActual(parseIssues(fs.readFileSync(argv[i + 1], 'utf8')));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}

module.exports = { extractEstimateHours, actualHours, percentile, computeEstimateActual, parseIssues, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
