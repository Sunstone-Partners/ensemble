'use strict';

/**
 * TRD-043: Implementation AC tests for the High-tier explainer offer
 * (packages/development/lib/pr-review-explainer-offer.js) and its
 * `explainer-offer` CLI subcommand.
 *
 * The PRD scenario for AC-022-3 belongs to TRD-043-TEST and is not
 * anticipated here; the explainer skill's own behavior is TRD-036.
 *
 * TRD Reference: docs/TRD/TRD-2026-70e784f2-code-review-process.md#trd-043
 */

const { offerExplainers } = require('../lib/pr-review-explainer-offer');
const { HANDLERS, main } = require('../lib/pr-review-cli');
const { classifyPaths } = require('../lib/pr-review-paths');

const BASE = 'f'.repeat(40);

/** A `classifyPaths` result over the given changed paths, built the way the skill builds it. */
const classify = (changedPaths) => classifyPaths({ changedPaths, baseSha: BASE });

const tier = (word) => ({ ok: true, tier: word, effectiveTier: word, humansRequired: 1, refusals: [], reasons: [], warnings: [] });

const moduleNames = (result) => result.modules.map((entry) => entry.module);

describe('TRD-043 AC-1: a High-tier report offers an explainer per touched sensitive module', () => {
  const sensitivePaths = classify([
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
    'packages/development/lib/pr-review-gate.js',
    'docs/README.md',
  ]);

  test('one offer per sensitive module, each naming the paths that made it sensitive', () => {
    const result = offerExplainers({ tier: tier('high'), paths: sensitivePaths });

    expect(result.ok).toBe(true);
    expect(result.offered).toBe(true);
    expect(moduleNames(result).length).toBeGreaterThan(0);
    for (const entry of result.modules) {
      expect(entry.paths.length).toBeGreaterThan(0);
      expect(typeof entry.module).toBe('string');
    }
    const offeredPaths = result.modules.flatMap((entry) => entry.paths);
    expect(offeredPaths).toEqual(expect.arrayContaining(['.github/workflows/ci.yml', '.github/workflows/release.yml']));
    expect(offeredPaths).not.toContain('docs/README.md');
  });

  test('the two workflow files collapse into the one module that matched them', () => {
    const result = offerExplainers({ tier: tier('high'), paths: sensitivePaths });
    const workflows = result.modules.find((entry) => entry.paths.includes('.github/workflows/ci.yml'));

    expect(workflows.paths).toEqual(['.github/workflows/ci.yml', '.github/workflows/release.yml']);
    expect(workflows.source).toBe('default');
  });

  test('an offer alone generates nothing: generate is empty until a person asks', () => {
    const result = offerExplainers({ tier: tier('high'), paths: sensitivePaths });

    expect(result.generate).toEqual([]);
    expect(result.accepted).toEqual([]);
  });

  test('an accepted offer names exactly the requested module to generate', () => {
    const offered = offerExplainers({ tier: tier('high'), paths: sensitivePaths });
    const wanted = moduleNames(offered)[0];

    const result = offerExplainers({ tier: tier('high'), paths: sensitivePaths, requested: [wanted] });

    expect(result.accepted).toEqual([wanted]);
    expect(result.generate).toEqual([wanted]);
  });

  test('a request naming a path inside an offered module accepts that module', () => {
    const result = offerExplainers({
      tier: tier('high'),
      paths: sensitivePaths,
      requested: ['.github/workflows/release.yml'],
    });

    expect(result.generate).toEqual([expect.stringContaining('.github/workflows')]);
    expect(result.unknownRequested).toEqual([]);
  });

  test('a request for something never offered generates nothing and is named', () => {
    const result = offerExplainers({ tier: tier('high'), paths: sensitivePaths, requested: ['docs/README.md'] });

    expect(result.generate).toEqual([]);
    expect(result.unknownRequested).toEqual(['docs/README.md']);
  });

  test('a High-tier PR that touched nothing sensitive offers nothing', () => {
    const result = offerExplainers({ tier: tier('high'), paths: classify(['docs/README.md']) });

    expect(result.ok).toBe(true);
    expect(result.offered).toBe(false);
    expect(result.modules).toEqual([]);
    expect(result.reason).toBe('no-sensitive-modules-touched');
  });
});

describe('TRD-043 AC-2: a PR that is not High tier is offered no explainer', () => {
  const sensitivePaths = classify(['.github/workflows/ci.yml']);

  test.each(['low', 'medium'])('tier %s offers nothing and generates nothing', (word) => {
    const result = offerExplainers({ tier: tier(word), paths: sensitivePaths, requested: ['.github/workflows'] });

    expect(result.offered).toBe(false);
    expect(result.modules).toEqual([]);
    expect(result.generate).toEqual([]);
    expect(result.reason).toBe('not-high-tier');
  });

  test('the effective tier decides, not the assigned one (a Low treated as Medium is still not High)', () => {
    const result = offerExplainers({
      tier: { ok: true, tier: 'high', effectiveTier: 'medium', refusals: [], reasons: [], warnings: [] },
      paths: sensitivePaths,
    });

    expect(result.offered).toBe(false);
  });

  test('a bare tier word is read like a tier result', () => {
    expect(offerExplainers({ tier: 'high', paths: sensitivePaths }).offered).toBe(true);
    expect(offerExplainers({ tier: 'medium', paths: sensitivePaths }).offered).toBe(false);
  });
});

describe('TRD-043: unreadable input never offers and never generates', () => {
  test.each([undefined, null, 'high', 42, []])('a hostile payload (%p) answers ok:false with a reason', (payload) => {
    const result = offerExplainers(payload);

    expect(result.ok).toBe(false);
    expect(result.offered).toBe(false);
    expect(result.generate).toEqual([]);
    expect(typeof result.reason).toBe('string');
  });

  test('an unreadable tier offers nothing and names why', () => {
    const result = offerExplainers({ tier: { ok: false }, paths: classify(['.github/workflows/ci.yml']) });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unreadable-tier');
    expect(result.generate).toEqual([]);
  });

  test('a path classification that was refused is never read as "nothing sensitive"', () => {
    const result = offerExplainers({ tier: tier('high'), paths: { ok: false, reason: 'invalid-input' } });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unreadable-paths');
    expect(result.modules).toEqual([]);
  });

  test('a requested list that is not an array is refused, not silently ignored', () => {
    const result = offerExplainers({ tier: tier('high'), paths: classify(['.github/workflows/ci.yml']), requested: 'ci' });

    expect(result.ok).toBe(false);
    expect(result.generate).toEqual([]);
  });
});

describe('TRD-043: the offer is reachable through the pr-review CLI', () => {
  test('`explainer-offer` is registered as a handler', () => {
    expect(Object.prototype.hasOwnProperty.call(HANDLERS, 'explainer-offer')).toBe(true);
    expect(typeof HANDLERS['explainer-offer']).toBe('function');
  });

  test('the handler delegates to the module verbatim', () => {
    const payload = { tier: tier('high'), paths: classify(['.github/workflows/ci.yml']) };
    expect(HANDLERS['explainer-offer'](payload)).toEqual(offerExplainers(payload));
  });

  test('both usage strings name the subcommand', () => {
    const source = require('fs').readFileSync(require.resolve('../lib/pr-review-cli.js'), 'utf-8');
    const usageLines = source.split('\n').filter((line) => line.includes('Usage: pr-review-cli') || line.includes('Usage: node pr-review-cli.js'));

    expect(usageLines.length).toBe(2);
    for (const line of usageLines) expect(line).toContain('explainer-offer');
  });

  test('an unknown subcommand still fails, so the dispatcher was not loosened', () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(main(['explainer'])).toBe(1);
    } finally {
      write.mockRestore();
    }
  });
});
