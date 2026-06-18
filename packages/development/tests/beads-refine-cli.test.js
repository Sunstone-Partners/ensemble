const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cli = path.join(__dirname, '../lib/beads-refine-cli.js');

function tmpJson(value) {
  const file = path.join(os.tmpdir(), `beads-refine-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

describe('beads-refine-cli', () => {
  test('analyze returns findings and repair plan as JSON', () => {
    const issues = tmpJson([{ id: 't1', title: '[trd:x:task:TRD-001] Task', issue_type: 'task', status: 'open' }]);
    const res = spawnSync('node', [cli, 'analyze', '--issues-json', issues], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.findingsSummary.count).toBeGreaterThan(0);
    expect(out.repairPlan.ok).toBe(true);
  });

  test('verify exits nonzero on invalid json input', () => {
    const file = path.join(os.tmpdir(), `beads-refine-bad-${Date.now()}.json`);
    fs.writeFileSync(file, '{not-valid-json');
    const res = spawnSync('node', [cli, 'verify', '--issues-json', file, '--verify', '{"kind":"status_is"}'], { encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(JSON.parse(res.stdout).error).toBeDefined();
  });
});
