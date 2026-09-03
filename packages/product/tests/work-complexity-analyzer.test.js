'use strict';

const {
  WorkComplexityInputError,
  analyzeWorkComplexity,
  classificationForScore,
  renderAnalysisBlock
} = require('../lib/work-complexity-analyzer');

describe('work complexity analyzer', () => {
  test('returns structured result with bounded integer score and rationale', () => {
    const result = analyzeWorkComplexity('Add an analyze-complexity command for a new planning entrypoint.');
    expect(Number.isInteger(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThanOrEqual(10);
    expect(result).toEqual(expect.objectContaining({
      depth: expect.any(String),
      path: expect.any(Array),
      rationale: expect.any(String),
      uncertainty: expect.any(Array),
      overrideApplied: false,
      disabled: false
    }));
    expect(result.factors).toEqual(expect.objectContaining({
      scope: expect.objectContaining({ level: expect.any(String), evidence: expect.any(Array) }),
      dependencies: expect.objectContaining({ level: expect.any(String), evidence: expect.any(Array) }),
      risk: expect.objectContaining({ level: expect.any(String), evidence: expect.any(Array) }),
      teamSize: expect.objectContaining({ level: expect.any(String), evidence: expect.any(Array) })
    }));
  });

  test('empty input fails without selecting a path', () => {
    expect(() => analyzeWorkComplexity('   ')).toThrow(WorkComplexityInputError);
  });

  test('detects small isolated scope without model calls', () => {
    const result = analyzeWorkComplexity('Fix one isolated typo in a single command help message.');
    expect(result.factors.scope.level).toBe('low');
    expect(result.score).toBeLessThanOrEqual(3);
    expect(result.depth).toBe('Simple');
    expect(result.path).toEqual(['fix-issue']);
  });

  test('detects multi-workflow scope evidence', () => {
    const result = analyzeWorkComplexity('Add multiple workflows across packages for developer, PM, and operator roles.');
    expect(['medium', 'high']).toContain(result.factors.scope.level);
    expect(result.factors.scope.evidence.join(' ')).toMatch(/multiple workflows|multiple packages|multiple user roles/);
  });

  test('captures dependency evidence and avoids invented dependencies', () => {
    const rich = analyzeWorkComplexity('Integrate generated markdown artifacts with Foreman phases and multiple CLI commands.');
    expect(rich.factors.dependencies.level).toBe('high');
    expect(rich.factors.dependencies.evidence.join(' ')).toMatch(/generated artifacts|Foreman phases|command entrypoints/);

    const plain = analyzeWorkComplexity('Fix a typo in a label.');
    expect(['low', 'uncertain']).toContain(plain.factors.dependencies.level);
    expect(plain.factors.dependencies.evidence).toEqual([]);
  });

  test('detects risk, ambiguous risk, multi-team, and solo-maintainer signals', () => {
    const risky = analyzeWorkComplexity('Change production security automation that could cause data loss.');
    expect(risky.factors.risk.level).toBe('high');
    expect(risky.score).toBeGreaterThanOrEqual(7);

    const ambiguous = analyzeWorkComplexity('Maybe adjust a behavior where risk is unclear.');
    expect(ambiguous.uncertainty.join(' ')).toMatch(/risk|teamSize|dependencies/);

    const team = analyzeWorkComplexity('Coordinate PM review, QA approval, and cross-functional enterprise rollout.');
    expect(team.factors.teamSize.level).toBe('high');

    const solo = analyzeWorkComplexity('Solo maintainer fixes a small local display bug.');
    expect(solo.factors.teamSize.level).toBe('low');
  });

  test('maps score bands to exact paths', () => {
    expect(classificationForScore(1)).toMatchObject({ depth: 'Simple', path: ['fix-issue'] });
    expect(classificationForScore(3)).toMatchObject({ depth: 'Simple', path: ['fix-issue'] });
    expect(classificationForScore(4)).toMatchObject({ depth: 'Medium', path: ['create-prd', 'create-trd'] });
    expect(classificationForScore(6)).toMatchObject({ depth: 'Medium', path: ['create-prd', 'create-trd'] });
    expect(classificationForScore(7)).toMatchObject({ depth: 'Complex', path: ['create-prd', 'refine-prd', 'create-trd', 'refine-trd'] });
    expect(classificationForScore(10)).toMatchObject({ depth: 'Complex', path: ['create-prd', 'refine-prd', 'create-trd', 'refine-trd'] });
  });

  test('applies override and disable precedence with original classification audit', () => {
    const overridden = analyzeWorkComplexity({
      description: 'Fix a small isolated bug.',
      overrideDepth: 'complex',
      config: { defaultDepth: 'simple', autoComplexity: true }
    });
    expect(overridden.overrideApplied).toBe(true);
    expect(overridden.depth).toBe('Complex');
    expect(overridden.originalClassification).toMatchObject({ depth: 'Simple' });

    const disabledByFlag = analyzeWorkComplexity({
      description: 'Multiple production integrations across teams.',
      disableAuto: true,
      config: { autoComplexity: true, defaultDepth: 'simple' }
    });
    expect(disabledByFlag.disabled).toBe(true);
    expect(disabledByFlag.depth).toBe('Simple');

    const disabledByConfig = analyzeWorkComplexity({
      description: 'Multiple production integrations across teams.',
      config: { autoComplexity: false, defaultDepth: 'medium' }
    });
    expect(disabledByConfig.disabled).toBe(true);
    expect(disabledByConfig.depth).toBe('Medium');
  });

  test('renders route output before downstream planning can consume it', () => {
    const block = renderAnalysisBlock(analyzeWorkComplexity('Add a medium feature with CLI integration.'));
    expect(block).toContain('Score:');
    expect(block).toContain('Depth:');
    expect(block).toContain('Path:');
    expect(block).toContain('Rationale:');
  });

  test('PRD regression fixtures route simple and complex descriptions', () => {
    const simple = analyzeWorkComplexity('Simple bug description: fix a typo in one validation message.');
    expect(simple.score).toBeLessThanOrEqual(3);
    expect(simple.depth).toBe('Simple');
    expect(simple.path).toEqual(['fix-issue']);

    const complex = analyzeWorkComplexity('Complex initiative description: AI analyzes scope size, dependencies, risk factors, team size, routes multiple workflows across packages, writes Foreman artifacts, and requires PM and QA review before approval.');
    expect(complex.score).toBeGreaterThanOrEqual(7);
    expect(complex.depth).toBe('Complex');
    expect(complex.path).toEqual(['create-prd', 'refine-prd', 'create-trd', 'refine-trd']);
  });
});
