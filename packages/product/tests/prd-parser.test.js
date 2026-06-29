'use strict';

const fs = require('fs');
const path = require('path');
const { parsePRD } = require('../lib/prd-parser');

const SAMPLE = fs.readFileSync(
  path.join(__dirname, 'fixtures/PRD-sample.md'),
  'utf8'
);

describe('parsePRD', () => {
  const prd = parsePRD(SAMPLE);

  test('extracts frontmatter (micro-uuid document id, version, status)', () => {
    expect(prd.documentId).toBe('PRD-2026-a1b2c3d4');
    expect(prd.version).toBe('1.2.0');
    expect(prd.status).toBe('Draft');
    expect(prd.date).toBe('2026-06-29');
  });

  test('extracts both requirements with id, title, MoSCoW and complexity', () => {
    expect(prd.reqs.map((r) => r.id)).toEqual(['REQ-001', 'REQ-002']);
    const req1 = prd.reqs[0];
    expect(req1.title).toBe('User Authentication');
    expect(req1.moscow).toBe('Must');
    expect(req1.complexity).toBe('Medium');
  });

  test('collects ACs under their owning requirement only', () => {
    expect(prd.reqs[0].acs.map((a) => a.id)).toEqual(['AC-001-1', 'AC-001-2']);
    expect(prd.reqs[1].acs.map((a) => a.id)).toEqual([
      'AC-002-1',
      'AC-002-2',
      'AC-002-3',
    ]);
  });

  test('accepts both bold and plain AC marker forms', () => {
    // AC-001-1 is bold (**AC-001-1:**), AC-002-1 is plain (AC-002-1:)
    const ac1 = prd.reqs[0].acs[0];
    const ac2 = prd.reqs[1].acs[0];
    expect(ac1.given).toBeTruthy();
    expect(ac2.given).toBeTruthy();
  });

  test('splits a single AC sentence into Given/When/Then clauses', () => {
    const ac = prd.reqs[0].acs[0]; // AC-001-1
    expect(ac.given).toBe('a user with valid credentials');
    expect(ac.when).toBe('they submit the login form');
    expect(ac.then).toBe('they are authenticated and see the dashboard');
    expect(ac.needsClarification).toBe(false);
  });

  test('keeps natural-prose "and" inside the Then clause (no over-splitting)', () => {
    const ac = parsePRD(
      '### REQ-009: x\n- AC-009-1: Given a path, when it runs, then a, b, and c happen.\n'
    ).reqs[0].acs[0];
    expect(ac.then).toBe('a, b, and c happen');
  });

  test('flags free-form ACs (no Given/When/Then) as needing clarification', () => {
    const ac = prd.reqs[1].acs[1]; // AC-002-2 (free-form)
    expect(ac.given).toBeNull();
    expect(ac.needsClarification).toBe(true);
    expect(ac.raw).toContain('password complexity');
  });

  test('flags ACs carrying an inline [NEEDS CLARIFICATION] marker', () => {
    const ac = prd.reqs[1].acs[2]; // AC-002-3
    expect(ac.needsClarification).toBe(true);
  });

  test('parses sequence-style document ids too', () => {
    const seq = parsePRD('---\ndocument_id: PRD-2026-023\nversion: 1.0.0\n---\n# x\n');
    expect(seq.documentId).toBe('PRD-2026-023');
  });
});
