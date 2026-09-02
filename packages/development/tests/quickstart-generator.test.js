'use strict';

const {
  collectAcceptanceCriteria,
  buildScenarios,
  validateCoverage,
  renderQuickstart,
  buildQuickstart,
} = require('../lib/quickstart-generator');

function fixtureParsedTrd() {
  return {
    title: 'TRD Fixture',
    phases: [
      { n: 1, taskIds: ['TRD-001', 'TRD-002'] },
    ],
    tasksById: {
      'TRD-001': {
        id: 'TRD-001',
        satisfies: ['REQ-001'],
        validatesAcs: ['AC-001-1', 'AC-001-2'],
        description: '- [ ] **TRD-001** Implement artifact generation (2h)',
      },
      'TRD-002': {
        id: 'TRD-002',
        satisfies: ['REQ-002'],
        validatesAcs: ['AC-002-1', 'AC-001-1'],
        description: '- [ ] **TRD-002** Implement coverage validation (2h)',
      },
    },
    prdContext: {
      acs: {
        'AC-001-1': {
          id: 'AC-001-1',
          reqId: 'REQ-001',
          given: 'a completed implementation run',
          when: 'the completion phase executes',
          then: 'quickstart.md is written before success is reported',
          text: 'Given a completed implementation run, when the completion phase executes, then quickstart.md is written before success is reported.',
        },
        'AC-001-2': {
          id: 'AC-001-2',
          reqId: 'REQ-001',
          given: 'artifact generation fails',
          when: 'final reporting starts',
          then: 'the command reports failure and does not claim success',
          text: 'Given artifact generation fails, when final reporting starts, then the command reports failure and does not claim success.',
        },
        'AC-002-1': {
          id: 'AC-002-1',
          reqId: 'REQ-002',
          given: 'a parser output with AC ids',
          when: 'collection runs',
          then: 'every AC keeps source metadata',
          text: 'Given a parser output with AC ids, when collection runs, then every AC keeps source metadata.',
        },
      },
    },
  };
}

describe('quickstart generator AC collection', () => {
  test('preserves source ids, metadata, and deterministic parser order', () => {
    const first = collectAcceptanceCriteria(fixtureParsedTrd());
    const second = collectAcceptanceCriteria(fixtureParsedTrd());

    expect(first.map((ac) => ac.acId)).toEqual(['AC-001-1', 'AC-001-2', 'AC-002-1']);
    expect(second).toEqual(first);
    expect(first[0]).toMatchObject({
      acId: 'AC-001-1',
      relatedTrdTaskId: 'TRD-001',
      relatedReqIds: ['REQ-001', 'REQ-002'],
      order: 1,
    });
    expect(first[0].relatedTrdTaskIds).toEqual(['TRD-001', 'TRD-002']);
    expect(first[0].sourceDescription).toContain('quickstart.md is written');
  });
});

describe('quickstart generator scenario rendering', () => {
  test('renders checkbox fields, setup/actions/expected result, and traceability metadata', () => {
    const acSources = collectAcceptanceCriteria(fixtureParsedTrd());
    const scenarios = buildScenarios(acSources);
    const coverage = validateCoverage(acSources, scenarios);
    const markdown = renderQuickstart({
      parsedTrd: fixtureParsedTrd(),
      trdPath: 'docs/TRD/fixture.md',
      scenarios,
      coverage,
    });

    expect(markdown).toContain('- [ ] Execute scenario');
    expect(markdown).toContain('- [ ] Pass');
    expect(markdown).toContain('**Setup / Preconditions:** a completed implementation run');
    expect(markdown).toContain('1. the completion phase executes');
    expect(markdown).toContain('**Expected result:** quickstart.md is written before success is reported');
    expect(markdown).toContain('**Source AC:** `AC-001-1`');
    expect(markdown).toContain('**TRD task:** `TRD-001`');
    expect(markdown).toContain('**Related REQs:** `REQ-001`');
  });

  test('keeps vague AC scenarios with a specific clarification marker', () => {
    const scenarios = buildScenarios([
      {
        acId: 'AC-009-1',
        relatedTrdTaskId: 'TRD-009',
        relatedTrdTaskIds: ['TRD-009'],
        relatedReqIds: ['REQ-009'],
        sourceDescription: 'Given weak context, when it runs, then success.',
        given: 'weak context',
        when: 'it runs',
        then: '',
      },
    ]);

    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].clarification).toBe('[NEEDS CLARIFICATION: What observable result proves this AC passed?]');
    const coverage = validateCoverage([{ acId: 'AC-009-1' }], scenarios);
    expect(coverage.clarificationCount).toBe(1);
  });
});

describe('quickstart generator coverage validation', () => {
  test('reports missing scenario ids and reports 100 percent for full coverage', () => {
    const acSources = [{ acId: 'AC-001-1' }, { acId: 'AC-001-2' }];
    const missing = validateCoverage(acSources, [{ sourceAcId: 'AC-001-1' }]);
    expect(missing.ok).toBe(false);
    expect(missing.unmappedAcIds).toEqual(['AC-001-2']);
    expect(missing.coveragePercent).toBe(50);

    const full = validateCoverage(acSources, [
      { sourceAcId: 'AC-001-1' },
      { sourceAcId: 'AC-001-2' },
    ]);
    expect(full.ok).toBe(true);
    expect(full.coveragePercent).toBe(100);
    expect(full.unmappedAcIds).toEqual([]);
  });

  test('blocks zero parsed ACs', () => {
    expect(() => validateCoverage([], [])).toThrow(/No parsed acceptance criteria found/);
    expect(() => buildQuickstart({ tasksById: {}, phases: [] }, { trdPath: 'x.md' })).toThrow(/No parsed acceptance criteria found/);
  });

  test('top-level summary includes required coverage fields', () => {
    const built = buildQuickstart(fixtureParsedTrd(), { trdPath: 'fixture.md' });
    expect(built.coverage).toMatchObject({
      parsedAcCount: 3,
      scenarioCount: 3,
      mappedAcCount: 3,
      unmappedAcIds: [],
      clarificationCount: 0,
      coveragePercent: 100,
    });
    expect(built.markdown).toContain('| Parsed AC count | 3 |');
    expect(built.markdown).toContain('| Scenario count | 3 |');
    expect(built.markdown).toContain('| Unmapped AC count | 0 |');
    expect(built.markdown).toContain('| Clarification count | 0 |');
    expect(built.markdown).toContain('| Coverage percentage | 100% |');
  });
});
