const { buildRepairPlan, renderSummary } = require('../lib/beads-repair-plan');

describe('beads-repair-plan', () => {
  test('creates comment fix for traceability findings', () => {
    const plan = buildRepairPlan([{ id: 'finding-001', type: 'traceability', beadIds: ['b1'], recommendation: 'Add metadata' }]);
    expect(plan.summary.executable).toBe(1);
    expect(plan.fixes[0].commands[0]).toContain('br comments add b1');
    expect(plan.fixes[0].verify.kind).toBe('comment_contains');
  });

  test('requires manual resolution for cycles', () => {
    const plan = buildRepairPlan([{ id: 'finding-001', type: 'cycle', beadIds: ['a', 'b'], requiresUserResolution: true }]);
    expect(plan.fixes[0].skipped).toBe(true);
    expect(plan.fixes[0].options).toContain('reverse selected edge');
  });

  test('does not auto-close duplicates', () => {
    const plan = buildRepairPlan([{ id: 'finding-001', type: 'duplicate', beadIds: ['a', 'b'] }]);
    expect(plan.fixes[0].commands).toHaveLength(0);
    expect(plan.fixes[0].options).toContain('leave unchanged');
  });

  test('renders changed dependency edges in summary', () => {
    const summary = renderSummary({ applied: [{ verify: { kind: 'dependency_exists', source: 'a', target: 'b' } }], findings: [{}] });
    expect(summary.changedDependencyEdges).toEqual(['a -> b']);
  });
});
