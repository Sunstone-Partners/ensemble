'use strict';

/**
 * verify-requirements-evidence.js
 *
 * Deterministic REQ->AC->code chain builder for /ensemble:verify-requirements.
 * This module is a pure data transformer: it takes pre-collected inputs from
 * the YAML command (already-parsed TRD, already-collected beads/checkbox
 * evidence from the parent shell), builds the chain, runs tests if asked,
 * and emits a single JSON report. No LLM judgement, no side effects beyond
 * reading files and shelling out to git/node/jest/br.
 *
 * CLI:
 *   node verify-requirements-evidence.js < input.json > output.json
 *   echo '<json>' | node verify-requirements-evidence.js
 *
 * Input JSON shape:
 *   {
 *     trd_path: string,
 *     trd_slug: string,
 *     prd_path: string | null,
 *     mode: 'auto' | 'beads' | 'checkbox' | 'both',
 *     mode_effective: 'beads' | 'checkbox' | 'both',
 *     parsed_trd_json: <full output of `trd-cli parse`>,
 *     checkbox_evidence: { [task_id: string]: { complete: bool, file_evidence: [{path, commit_sha, commit_date}], commit_evidence: [{sha, subject, date}] } },
 *     beads_evidence: { [task_id: string]: { status, verdict, req_satisfied, acs_proven, qa_agent, commit_sha } },
 *     helper_options: { run_tests: bool, cwd: string }
 *   }
 *
 * Output JSON shape:
 *   { ok: true, chain: [...], summary: {...}, verdict: 'COMPLETE' | 'PARTIAL' | 'BROKEN' }
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function main() {
  const inputText = fs.readFileSync(0, 'utf8');
  let input;
  try {
    input = JSON.parse(inputText);
  } catch (e) {
    process.stderr.write(`ERROR: input is not valid JSON: ${e.message}\n`);
    process.exit(1);
  }

  const result = buildChain(input);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) {
    process.exit(1);
  }
}

function buildChain(input) {
  const tasksById = (input.parsed_trd_json && input.parsed_trd_json.trd && input.parsed_trd_json.trd.tasksById) || {};
  const prdReqs = input.prd_requirements || null; // optional, may be null when PRD missing

  // 1. Build REQ -> impl tasks index.
  const implByReq = {};
  for (const [taskId, task] of Object.entries(tasksById)) {
    if (task.isTest) continue;
    for (const req of (task.satisfies || [])) {
      if (!/^REQ-\d+$/.test(req)) continue;
      (implByReq[req] = implByReq[req] || []).push(taskId);
    }
  }

  // 2. REQ -> test tasks index.
  const testByReq = {};
  for (const [taskId, task] of Object.entries(tasksById)) {
    if (!task.isTest) continue;
    for (const req of (task.satisfies || [])) {
      if (!/^REQ-\d+$/.test(req)) continue;
      (testByReq[req] = testByReq[req] || []).push(taskId);
    }
  }

  // 3. Per-REQ chain assembly.
  const chain = [];
  const reqUniverse = new Set();
  if (prdReqs) {
    Object.keys(prdReqs).forEach(r => reqUniverse.add(r));
  }
  Object.keys(implByReq).forEach(r => reqUniverse.add(r));
  Object.keys(testByReq).forEach(r => reqUniverse.add(r));

  for (const req of [...reqUniverse].sort()) {
    const prdReq = prdReqs ? prdReqs[req] : null;
    const implIds = implByReq[req] || [];
    const testIds = testByReq[req] || [];

    // Pick primary impl: first impl that has any file evidence on disk.
    let primaryImpl = null;
    let primaryImplEvidence = null;
    for (const id of implIds) {
      const ev = (input.checkbox_evidence && input.checkbox_evidence[id]) || null;
      if (ev && ev.file_evidence && ev.file_evidence.length > 0) {
        primaryImpl = id;
        primaryImplEvidence = ev;
        break;
      }
    }
    if (!primaryImpl && implIds.length > 0) {
      primaryImpl = implIds[0];
      primaryImplEvidence = (input.checkbox_evidence && input.checkbox_evidence[primaryImpl]) || null;
    }

    // Pick primary test (paired -TEST task via convention or via verifies).
    let primaryTest = null;
    if (primaryImpl) {
      const convention = `${primaryImpl}-TEST`;
      if (testIds.includes(convention)) {
        primaryTest = convention;
      } else if (testIds.length > 0) {
        primaryTest = testIds[0];
      }
    } else if (testIds.length > 0) {
      primaryTest = testIds[0];
    }
    const primaryTestEvidence = primaryTest ? (input.beads_evidence && input.beads_evidence[primaryTest]) || (input.checkbox_evidence && input.checkbox_evidence[primaryTest]) : null;
    // Test execution (opt-in via --run-tests).
    let testResult = 'not_run';
    if (input.helper_options && input.helper_options.run_tests && primaryTest) {
      const taskObj = tasksById[primaryTest] || {};
      const testFiles = (taskObj.targetFiles || []).filter(p => /\.(test|spec)\.[jt]sx?$|__tests__\//.test(p));
      if (testFiles.length === 0) {
        testResult = 'no_test_files_declared';
      } else {
        try {
          execFileSync('npx', ['jest', '--listTests', ...testFiles], { cwd: input.helper_options.cwd || process.cwd(), stdio: 'ignore' });
          execFileSync('npx', ['jest', ...testFiles, '--silent'], { cwd: input.helper_options.cwd || process.cwd(), stdio: 'ignore' });
          testResult = 'pass';
        } catch (e) {
          testResult = 'fail';
        }
      }
    }

    // Verdict derivation.
    let verdict;
    let statusIcon;
    if (!prdReq && !primaryImpl) {
      verdict = 'orphan'; // REQ exists in TRD but not in PRD and no impl
      statusIcon = 'ORPHAN';
    } else if (primaryImpl && primaryImplEvidence && primaryImplEvidence.complete && testResult === 'pass') {
      verdict = 'verified';
      statusIcon = 'VERIFIED';
    } else if (primaryImpl && (!primaryImplEvidence || !primaryImplEvidence.complete)) {
      verdict = 'in_progress';
      statusIcon = 'IN PROGRESS';
    } else if (primaryImpl && primaryImplEvidence && primaryImplEvidence.complete && (!primaryTest || testResult === 'fail' || testResult === 'not_run')) {
      verdict = 'partial';
      statusIcon = 'PARTIAL';
    } else if (primaryImpl && primaryImplEvidence && primaryImplEvidence.file_evidence && primaryImplEvidence.file_evidence.some(f => !f.exists)) {
      verdict = 'missing_file';
      statusIcon = 'MISSING FILE';
    } else if (!primaryImpl) {
      verdict = 'not_planned';
      statusIcon = 'NOT PLANNED';
    } else {
      verdict = 'unknown';
      statusIcon = 'UNKNOWN';
    }

    chain.push({
      req_id: req,
      prd_description: prdReq ? prdReq.description : null,
      prd_acs: prdReq ? prdReq.acs : null,
      impl_task_ids: implIds,
      primary_impl_task_id: primaryImpl,
      test_task_ids: testIds,
      primary_test_task_id: primaryTest,
      target_files: primaryImplEvidence && primaryImplEvidence.file_evidence ? primaryImplEvidence.file_evidence.map(f => f.path) : [],
      commit_evidence: primaryImplEvidence && primaryImplEvidence.commit_evidence ? primaryImplEvidence.commit_evidence : [],
      bead_status: primaryTestEvidence && primaryTestEvidence.status || null,
      bead_verdict: primaryTestEvidence && primaryTestEvidence.verdict || null,
      test_result: testResult,
      verdict,
      status_icon: statusIcon,
    });
  }

  // 4. Summary counts.
  const summary = { total: chain.length };
  for (const row of chain) {
    summary[row.verdict] = (summary[row.verdict] || 0) + 1;
  }

  // 5. Overall verdict.
  let overall;
  if (chain.length === 0) {
    overall = 'EMPTY';
  } else if (summary.verified === chain.length) {
    overall = 'COMPLETE';
  } else if (summary.in_progress > 0 || summary.partial > 0 || summary.missing_file > 0) {
    overall = 'PARTIAL';
  } else if (summary.not_planned === chain.length) {
    overall = 'NO_CHAIN';
  } else {
    overall = 'PARTIAL';
  }

  return {
    ok: true,
    chain,
    summary,
    verdict: overall,
    input_meta: {
      trd_slug: input.trd_slug,
      mode_effective: input.mode_effective,
      generated_at: new Date().toISOString(),
    },
  };
}

if (require.main === module) {
  main();
}

module.exports = { buildChain };
