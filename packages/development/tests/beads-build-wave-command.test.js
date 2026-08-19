const fs = require('fs');
const path = require('path');

describe('beads-build-wave command contract (v1.2.0 wave-runner primitive)', () => {
  const yamlPath = path.join(__dirname, '../commands/beads-build-wave.yaml');

  test('metadata declares the single-wave primitive contract', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    expect(text).toMatch(/name: ensemble:beads-build-wave/);
    expect(text).toMatch(/Single-wave primitive/);
    expect(text).toMatch(/non-recursive/);
  });

  test('required --epic argument and HALT on absence', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const block = text.slice(
      text.indexOf('title: Argument Parsing'),
      text.indexOf('title: Tool Availability Check')
    );
    expect(block).toMatch(/--epic <id> sets ROOT_EPIC_ID/);
    expect(block).toMatch(/ERROR: --epic <id> is required/);
  });

  test('bv is required (no br ready fallback)', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    expect(text).toMatch(/bv \(beads_viewer\) is required/);
    expect(text).toMatch(/exit 1/);
  });
  test('workflow is exactly two phases: Preflight + Execute (no Quality Gate, no Completion)', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    expect(text).toMatch(/- name: Preflight/);
    expect(text).toMatch(/- name: Execute/);
    expect(text).not.toMatch(/- name: Quality Gate/);
    expect(text).not.toMatch(/- name: Completion/);
  });

  test('Execute phase has exactly one step: Single-Wave Dispatch', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const execBlock = text.slice(
      text.indexOf('- name: Execute'),
      text.indexOf('expectedInput:')
    );
    expect(execBlock).toMatch(/title: Single-Wave Dispatch/);
    expect(execBlock).toMatch(/Step 1 \(sync\): run br sync --flush-only/);
    expect(execBlock).toMatch(/Step 5 \(concurrent dispatch\)/);
    expect(execBlock).toMatch(/Step 6 \(barrier\)/);
    expect(execBlock).toMatch(/Step 8 \(build summary\)/);
  });

  test('no-recursion contract: command must NOT call itself or sibling wave-runners', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const execBlock = text.slice(
      text.indexOf('- name: Execute'),
      text.indexOf('expectedInput:')
    );
    expect(execBlock).toMatch(/Does NOT loop/);
    expect(execBlock).toMatch(/Does NOT call itself recursively/);
    expect(execBlock).toMatch(/Does NOT invoke any sibling wave-runner subagent/);
  });

  test('JSON summary schema is documented and is the only output', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const execBlock = text.slice(
      text.indexOf('- name: Execute'),
      text.indexOf('expectedInput:')
    );
    expect(execBlock).toMatch(/remaining_scoped_count/);
    expect(execBlock).toMatch(/terminal_state/);
    expect(execBlock).toMatch(/next_action_hint/);
    expect(execBlock).toMatch(/LAST line of stdout/);
    expect(execBlock).toMatch(/the summary is the contract/);
  });

  test('payload per track includes goal, scope, team_roles, track_beads, lifecycle_contract', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    expect(text).toMatch(/track_beads/);
    expect(text).toMatch(/lifecycle_contract/);
    expect(text).toMatch(/quality_loop/);
    expect(text).toMatch(/pm_clarification_guard/);
  });

  test('cross-platform: works with Task() on claude/pi/codex/opencode (mentioned in mission)', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    expect(text).toMatch(/claude\/pi\/codex\/opencode/);
    expect(text).toMatch(/universal Task\(\) primitive/);
  });
});

describe('beads-build v1.2.0 wave-loop contract', () => {
  const yamlPath = path.join(__dirname, '../commands/beads-build.yaml');

  test('Execute phase step 1 is now the two-tier Wave Loop (was inline Track Orchestrator)', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const execStart = text.indexOf('- name: Execute');
    const execEnd = text.indexOf('title: Debug Loop');
    expect(execStart).toBeGreaterThan(-1);
    expect(execEnd).toBeGreaterThan(execStart);
    const execBlock = text.slice(execStart, execEnd);
    expect(execBlock).toMatch(/title: Wave Loop \(single-wave subagent dispatch\)/);
    expect(execBlock).not.toMatch(/title: Track Orchestrator \(bv --robot-plan scheduler \+ track dispatch\)/);
  });

  test('Wave Loop body dispatches Task() to a wave-runner (not bv --robot-plan inline)', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const execStart = text.indexOf('- name: Execute');
    const execEnd = text.indexOf('title: Debug Loop');
    const execBlock = text.slice(execStart, execEnd);
    expect(execBlock).toMatch(/Task\(subagent_type=<resolved-from-AGENT_ALIAS_MAP-beads-build-wave>/);
    expect(execBlock).toMatch(/does NOT call bv --robot-plan/);
    expect(execBlock).toMatch(/Two-tier non-recursive dispatch loop/);
  });

  test('Wave Loop reads JSON summary line and decides based on terminal_state', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const execStart = text.indexOf('- name: Execute');
    const execEnd = text.indexOf('title: Debug Loop');
    const execBlock = text.slice(execStart, execEnd);
    expect(execBlock).toMatch(/terminal_state == "complete"/);
    expect(execBlock).toMatch(/terminal_state == "blocked"/);
    expect(execBlock).toMatch(/terminal_state == "in_progress"/);
    expect(execBlock).toMatch(/next_action_hint == "dispatch_another_wave"/);
  });

  test('Cross-platform constraint acknowledged (Codex max_depth=1)', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const execStart = text.indexOf('- name: Execute');
    const execEnd = text.indexOf('title: Debug Loop');
    const execBlock = text.slice(execStart, execEnd);
    expect(execBlock).toMatch(/Codex's max_depth=1 constraint/);
  });

  test('metadata version bumped to 1.2.0', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    expect(text).toMatch(/version: 1\.2\.0/);
    expect(text).toMatch(/lastUpdated: "2026-08-19"/);
  });

  test('mission summary explains the two-tier loop architecture', () => {
    const text = fs.readFileSync(yamlPath, 'utf8');
    const missionBlock = text.slice(
      text.indexOf('mission:'),
      text.indexOf('workflow:')
    );
    expect(missionBlock).toMatch(/two-tier non-recursive dispatch\s+loop/i);
    expect(missionBlock).toMatch(/beads-build-wave/);
    expect(missionBlock).toMatch(/max_depth=1/);
  });
});
