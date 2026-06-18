const { normalizeGraph } = require('../lib/beads-scope');
const { detectFindings, summarizeFindings } = require('../lib/beads-findings');

describe('beads-findings', () => {
  test('parses bv cycles as user-resolution findings', () => {
    const findings = detectFindings([], { bvData: { Cycles: [['a', 'b', 'a']] } });
    expect(findings[0]).toMatchObject({ type: 'cycle', severity: 'critical', requiresUserResolution: true, source: 'bv' });
  });

  test('detects missing traceability and AC metadata', () => {
    const graph = normalizeGraph([{ id: 't1', title: '[trd:x:task:TRD-001] Task', issue_type: 'task', status: 'open' }]);
    const findings = detectFindings(graph);
    expect(findings.some((f) => f.type === 'traceability')).toBe(true);
  });

  test('detects PR boundary direction mismatch', () => {
    const graph = normalizeGraph([
      { id: 'p', title: '[trd:x:pr:1] PR 1', issue_type: 'feature' },
      { id: 'a', title: '[trd:x:task:TRD-001] A', description: 'PR 1\nSatisfies: REQ-001\nAC-001-1', issue_type: 'task', dependencies: ['b', { id: 'p', dependency_type: 'parent-child' }] },
      { id: 'b', title: '[trd:x:task:TRD-002] B', description: 'PR 2\nSatisfies: REQ-001\nAC-001-1', issue_type: 'task' },
    ]);
    const findings = detectFindings(graph);
    expect(findings.some((f) => f.type === 'pr_boundary' && f.requiresUserResolution)).toBe(true);
  });

  test('summarizes findings by type and severity', () => {
    const summary = summarizeFindings([{ type: 'cycle', severity: 'critical', requiresUserResolution: true }]);
    expect(summary).toEqual({ count: 1, byType: { cycle: 1 }, bySeverity: { critical: 1 }, requiresUserResolution: 1 });
  });
});
