const { normalizeGraph, resolveScope, subtreeIds } = require('../lib/beads-scope');

describe('beads-scope', () => {
  const issues = [
    { id: 'e1', title: '[trd:demo] Epic', issue_type: 'epic', status: 'open' },
    { id: 's1', title: '[trd:demo:pr:1] PR 1', issue_type: 'feature', status: 'open' },
    { id: 't1', title: '[trd:demo:task:TRD-001] Task', description: 'Satisfies: REQ-001\nPRD ACs: AC-001-1', issue_type: 'task', status: 'open' },
  ];

  test('normalizes TRD hierarchy from title prefixes', () => {
    const graph = normalizeGraph(issues);
    expect(graph.byId.get('t1').metadata.sourceReqs).toEqual(['REQ-001']);
    expect(subtreeIds(graph, 'e1').has('s1')).toBe(true);
  });

  test('resolves unique slug scope', () => {
    const scope = resolveScope(issues, 'demo');
    expect(scope.ok).toBe(true);
    expect(scope.root.id).toBe('e1');
  });

  test('reports ambiguous scope', () => {
    const scope = resolveScope([...issues, { id: 'e2', title: '[trd:demo-two] Epic', issue_type: 'epic', status: 'open' }], 'demo');
    expect(scope.ok).toBe(false);
    expect(scope.error).toBe('Ambiguous scope');
  });

  test('supports project mode warning', () => {
    const scope = resolveScope(issues, '', { scope: 'project' });
    expect(scope.ok).toBe(true);
    expect(scope.mode).toBe('project');
    expect(scope.warning).toContain('Project scope');
  });
});
