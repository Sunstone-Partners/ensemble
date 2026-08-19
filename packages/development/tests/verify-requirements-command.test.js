const fs = require('fs');
const path = require('path');

describe('verify-requirements command contract (v1.0.0 REQ->AC->code chain)', () => {
  const yamlPath = path.join(__dirname, '../commands/verify-requirements.yaml');

  test('required --trd argument and HALT on absence', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    expect(text).toMatch(/--trd <path>/);
    expect(text).toMatch(/ERROR: --trd <path> is required/);
  });

  test('--prd is optional (degrades gracefully when missing)', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    expect(text).toMatch(/--prd <path> \(optional\)/);
    expect(text).toMatch(/No PRD provided and TRD has no PRD reference/);
    expect(text).toMatch(/PRD_REQUIREMENTS = null/);
  });

  test('mode dispatch: auto|beads|checkbox|both are all accepted', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    expect(text).toMatch(/--mode auto|beads|checkbox|both/);
    expect(text).toMatch(/--mode beads/);
    expect(text).toMatch(/--mode checkbox/);
    expect(text).toMatch(/--mode both/);
  });

  test('--run-tests is opt-in (no recursion into CI test runs by default)', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    expect(text).toMatch(/--run-tests/);
    expect(text).toMatch(/--run-tests is opt-in/);
  });

  test('--no-write-report suppresses the markdown artifact', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    expect(text).toMatch(/--no-write-report/);
    expect(text).toMatch(/Skip if --no-write-report was passed/);
  });

  test('workflow has three phases: Preflight, Chain Build, Report', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    expect(text).toMatch(/- name: Preflight/);
    expect(text).toMatch(/- name: Chain Build/);
    expect(text).toMatch(/- name: Report/);
  });

  test('Chain Build phase has all seven required steps', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const chainStart = text.indexOf('- name: Chain Build');
    const chainEnd = text.indexOf('- name: Report');
    const block = text.slice(chainStart, chainEnd);
    expect(block).toMatch(/title: TRD Parse/);
    expect(block).toMatch(/title: PRD Requirement Loading/);
    expect(block).toMatch(/title: Task to REQ Index/);
    expect(block).toMatch(/title: Bead Track Evidence/);
    expect(block).toMatch(/title: Checkbox Track Evidence/);
    expect(block).toMatch(/title: Helper Invocation/);
    expect(block).toMatch(/title: Console Summary/);
  });

  test('Chain Build sources the deterministic TRD parser (never hand-parses)', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const chainStart = text.indexOf('- name: Chain Build');
    const chainEnd = text.indexOf('- name: Report');
    const block = text.slice(chainStart, chainEnd);
    expect(block).toContain('Run: node \\"$TRD_CLI\\" parse \\"$TRD_PATH\\"');
    expect(block).toMatch(/Authoritative TRD parse via trd-cli/);
    expect(block).toMatch(/hand-parsing breaks the chain at step 1/);
    expect(block).toMatch(/HARD FAILURE/);
  });

  test('Bead Track Evidence step runs in both/beads mode and is skipped in checkbox-only mode', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const chainStart = text.indexOf('- name: Chain Build');
    const chainEnd = text.indexOf('- name: Report');
    const block = text.slice(chainStart, chainEnd);
    expect(block).toMatch(/br list --status=open/);
    expect(block).toMatch(/br comment list/);
    expect(block).toMatch(/req-verified: REQ-NNN/);
    expect(block).toMatch(/If MODE does not include the beads leg: skip/);
  });

  test('Checkbox Track Evidence parses the TRD Master Task List and gathers git log evidence', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const chainStart = text.indexOf('- name: Chain Build');
    const chainEnd = text.indexOf('- name: Report');
    const block = text.slice(chainStart, chainEnd);
    expect(block).toMatch(/Master Task List/);
    expect(block).toMatch(/- \[ \] TRD-NNN/);
    expect(block).toMatch(/- \[x\] TRD-NNN/);
    expect(block).toMatch(/git log --all/);
    expect(block).toMatch(/feat\(<trd-slug>\): TRD-NNN/);
  });

  test('Helper Invocation delegates to verify-requirements-evidence.js with a structured JSON payload', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const helperStep = text.slice(text.indexOf('title: Helper Invocation'), text.indexOf('title: Console Summary'));
    expect(helperStep).toMatch(/verify-requirements-evidence\.js/);
    expect(helperStep).toMatch(/tool-path-resolution skill/);
    expect(helperStep).toMatch(/Run the helper with a JSON payload/);
    expect(helperStep).toMatch(/If the helper exits non-zero or returns malformed JSON/);
  });

  test('Console Summary prints per-REQ status icon and summary counts', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const chainStart = text.indexOf('- name: Chain Build');
    const chainEnd = text.indexOf('- name: Report');
    const block = text.slice(chainStart, chainEnd);
    expect(block).toMatch(/REQUIREMENT TRACEABILITY REPORT/);
    expect(block).toMatch(/VERIFIED/);
    expect(block).toMatch(/IN PROGRESS/);
    expect(block).toMatch(/NOT PLANNED/);
    expect(block).toMatch(/PARTIAL/);
    expect(block).toMatch(/MISSING/);
    expect(block).toMatch(/chain build: SUCCESS/);
  });

  test('Report phase writes docs/req-traceability/<slug>-<date>.md as the canonical deliverable', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const reportStart = text.indexOf('- name: Report');
    const block = text.slice(reportStart);
    expect(block).toMatch(/docs\/req-traceability/);
    expect(block).toMatch(/CHAIN COMPLETE/);
    expect(block).toMatch(/CHAIN PARTIAL/);
    expect(block).toMatch(/CHAIN BROKEN/);
    expect(block).toMatch(/mkdir -p/);
  });

  test('report never writes to the source tree (only to docs/req-traceability)', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const constraintsBlock = text.slice(text.indexOf('constraints:'), text.indexOf('mission:'));
    expect(constraintsBlock).toMatch(/NEVER writes to the source tree/);
    expect(constraintsBlock).toMatch(/NEVER modifies code/);
  });

  test('exit code 0 on chain build success even with PARTIAL/MISSING verdicts', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const exitBlock = text.slice(text.indexOf('title: Exit Code'));
    expect(exitBlock).toMatch(/exit 0: chain built successfully/);
    expect(exitBlock).toMatch(/exit 1: chain build failed/);
  });

  test('constraints list captures the no-side-effects contract', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const constraintsBlock = text.slice(text.indexOf('constraints:'), text.indexOf('mission:'));
    expect(constraintsBlock).toMatch(/NEVER modifies code/);
    expect(constraintsBlock).toMatch(/deterministic/);
    expect(constraintsBlock).toMatch(/Exit code 0 means the chain was built successfully/);
  });

  test('mission summary explains the REQ->AC->code chain', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const missionBlock = text.slice(text.indexOf('mission:'), text.indexOf('workflow:'));
    expect(missionBlock).toMatch(/straight-line chain from PRD requirements to actual code/i);
    expect(missionBlock).toMatch(/REQ-NNN/);
    expect(missionBlock).toMatch(/AC-NNN-M/);
    expect(missionBlock).toMatch(/targetFiles/);
    expect(missionBlock).toMatch(/commit evidence/);
  });

  test('works for both implement-trd (checkbox) and implement-trd-beads (beads)', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const missionBlock = text.slice(text.indexOf('mission:'), text.indexOf('workflow:'));
    expect(missionBlock).toMatch(/implement-trd-beads \(beads track\)/);
    expect(missionBlock).toMatch(/implement-trd\s*\(checkbox track\)/);
  });

  test('metadata and schema fields are valid', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    expect(text).toMatch(/version: 1\.0\.0/);
    expect(text).toMatch(/lastUpdated: "2026-08-19"/);
    expect(text).toMatch(/name: ensemble:verify-requirements/);
    expect(text).toMatch(/output_path: ensemble\/verify-requirements\.md/);
    expect(text).toMatch(/category: planning/);
  });
});

describe('verify-requirements-evidence helper contract', () => {
  const helperPath = path.join(__dirname, '../lib/verify-requirements-evidence.js');
  // eslint-disable-next-line global-require
  const { buildChain } = require(helperPath);

  test('builds the REQ->AC->code chain for a complete beads+checkbox scenario', () => {
    const out = buildChain({
      trd_slug: 'smoke-complete',
      mode_effective: 'both',
      parsed_trd_json: {
        trd: {
          tasksById: {
            'TRD-001': { id: 'TRD-001', isTest: false, satisfies: ['REQ-001'], validatesAcs: [], targetFiles: ['src/foo.js'] },
            'TRD-001-TEST': { id: 'TRD-001-TEST', isTest: true, satisfies: ['REQ-001'], validatesAcs: ['AC-001-1'], targetFiles: ['src/foo.test.js'] },
          },
        },
      },
      prd_requirements: { 'REQ-001': { description: 'Foo works', acs: ['AC-001-1'] } },
      checkbox_evidence: {
        'TRD-001': { complete: true, file_evidence: [{ path: 'src/foo.js', exists: true, commit_sha: 'abc', commit_date: '2026-08-19' }], commit_evidence: [{ sha: 'abc', subject: 'feat(smoke): TRD-001', date: '2026-08-19' }] },
        'TRD-001-TEST': { complete: true, file_evidence: [{ path: 'src/foo.test.js', exists: true }], commit_evidence: [] },
      },
      beads_evidence: { 'TRD-001-TEST': { status: 'closed', verdict: 'passed', req_satisfied: 'REQ-001', acs_proven: ['AC-001-1'], qa_agent: 'qa-agent' } },
      helper_options: { run_tests: false },
    });
    expect(out.ok).toBe(true);
    expect(out.chain.length).toBe(1);
    expect(out.chain[0].req_id).toBe('REQ-001');
    expect(out.chain[0].primary_impl_task_id).toBe('TRD-001');
    expect(out.chain[0].primary_test_task_id).toBe('TRD-001-TEST');
    expect(out.chain[0].target_files).toEqual(['src/foo.js']);
    expect(out.chain[0].bead_status).toBe('closed');
    expect(out.chain[0].bead_verdict).toBe('passed');
  });

  test('handles a missing PRD by deriving the REQ universe from TRD satisfies', () => {
    const out = buildChain({
      trd_slug: 'smoke-no-prd',
      mode_effective: 'checkbox',
      parsed_trd_json: { trd: { tasksById: { 'TRD-001': { id: 'TRD-001', isTest: false, satisfies: ['REQ-001'], targetFiles: [] } } } },
      prd_requirements: null,
      checkbox_evidence: { 'TRD-001': { complete: true, file_evidence: [], commit_evidence: [] } },
      beads_evidence: {},
      helper_options: { run_tests: false },
    });
    expect(out.ok).toBe(true);
    expect(out.chain.length).toBe(1);
    expect(out.chain[0].prd_description).toBe(null);
    expect(out.chain[0].req_id).toBe('REQ-001');
  });

  test('flags NOT PLANNED when no impl task satisfies the PRD REQ', () => {
    const out = buildChain({
      trd_slug: 'smoke-unplanned',
      mode_effective: 'checkbox',
      parsed_trd_json: { trd: { tasksById: {} } },
      prd_requirements: { 'REQ-200': { description: 'Unplanned', acs: [] } },
      checkbox_evidence: {},
      beads_evidence: {},
      helper_options: { run_tests: false },
    });
    expect(out.chain[0].verdict).toBe('not_planned');
  });

  test('overall verdict is PARTIAL when at least one REQ is not verified', () => {
    const out = buildChain({
      trd_slug: 'smoke-mixed',
      mode_effective: 'checkbox',
      parsed_trd_json: { trd: { tasksById: { 'TRD-A': { id: 'TRD-A', isTest: false, satisfies: ['REQ-A'], targetFiles: [] } } } },
      prd_requirements: { 'REQ-A': { description: 'A', acs: [] }, 'REQ-B': { description: 'B', acs: [] } },
      checkbox_evidence: { 'TRD-A': { complete: false, file_evidence: [], commit_evidence: [] } },
      beads_evidence: {},
      helper_options: { run_tests: false },
    });
    expect(['PARTIAL', 'NO_CHAIN']).toContain(out.verdict);
  });
});
