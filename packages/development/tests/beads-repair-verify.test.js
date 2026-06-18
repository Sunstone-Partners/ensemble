const { verifyRepair } = require('../lib/beads-repair-verify');

describe('beads-repair-verify', () => {
  test('verifies dependency exists', () => {
    const result = verifyRepair([{ id: 'a', title: 'A', dependencies: ['b'] }], { kind: 'dependency_exists', source: 'a', target: 'b' });
    expect(result.ok).toBe(true);
  });

  test('fails with observed values when dependency missing', () => {
    const result = verifyRepair([{ id: 'a', title: 'A', dependencies: [] }], { kind: 'dependency_exists', source: 'a', target: 'b' });
    expect(result.ok).toBe(false);
    expect(result.observed).toEqual([]);
  });

  test('verifies comment contains expected text', () => {
    const result = verifyRepair([{ id: 'a', title: 'A', comments: ['hello refine-beads'] }], { kind: 'comment_contains', beadId: 'a', text: 'refine-beads' });
    expect(result.ok).toBe(true);
  });
});
