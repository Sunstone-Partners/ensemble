'use strict';

/**
 * TRD-043-TEST: High-tier explainer offer (PRD scenario).
 *
 * Verifies TRD-043 (`lib/pr-review-explainer-offer.js` and the
 * `explainer-offer` subcommand of `lib/pr-review-cli.js`).
 * Validates PRD AC: AC-022-3 (REQ-022).
 *
 * The field-level behavior of `offerExplainers` is covered by
 * pr-review-explainer-offer.test.js (TRD-043), the skill wiring by
 * pr-review-explainer-skill.test.js, and AC-022-1/AC-022-2 by
 * pr-review-explainer-scenarios.test.js. None of it is re-stated here.
 *
 * This is the REQUIREMENT-level scenario, read exactly as AC-022-3 words it:
 * "Given a PR is High tier, When its review report is produced, Then it
 * offers an explainer for each touched sensitive module, and an explainer is
 * generated only if requested."
 *
 *   - the tier is produced by the REAL `classifyPaths` -> `assignTier` ->
 *     `effectiveTier` chain over the real changed paths of the PR, never a
 *     tier literal, so the scenario cannot pass against a shape the report
 *     would never carry;
 *   - the same payload is also pushed through the REAL CLI as a child
 *     process, because the review report reaches this decision through the
 *     `explainer-offer` subcommand, not through an in-process require;
 *   - every part carries the case that must be REFUSED: a PR that is not
 *     High offers nothing, and a High PR generates nothing until a person
 *     names a module.
 *
 * TRD Reference: docs/TRD/TRD-2026-70e784f2-code-review-process.md#trd-043-test
 */

const path = require('path');
const { spawnSync } = require('child_process');

const { offerExplainers } = require('../lib/pr-review-explainer-offer');
const { classifyPaths } = require('../lib/pr-review-paths');
const { assignTier, effectiveTier } = require('../lib/pr-review-tier');

const CLI = path.join(__dirname, '..', 'lib', 'pr-review-cli.js');
const BASE = 'e'.repeat(40);

/** The real CLI, as the review report invokes it. */
function viaCli(payload) {
  const result = spawnSync('node', [CLI, 'explainer-offer'], { input: JSON.stringify(payload), encoding: 'utf8' });
  return { status: result.status, out: JSON.parse(result.stdout) };
}

/** The real path classification + tier chain for one PR's changed files. */
function reviewOf(changedPaths, { kind = 'product' } = {}) {
  const paths = classifyPaths({ changedPaths, baseSha: BASE });
  const assignment = assignTier({ paths, kinds: [{ kind, paths: changedPaths }] });
  const tier = effectiveTier({ assignment, policy: { maintainerLogins: [] }, author: 'author-a' });
  return { paths, tier };
}

/** The decision as the report makes it: in-process AND through the CLI, which must agree. */
function offerFor({ paths, tier }, requested) {
  const payload = { tier, paths, ...(requested === undefined ? {} : { requested }) };
  const direct = offerExplainers(payload);
  const cli = viaCli(payload);
  expect(cli.status).toBe(0);
  expect(cli.out).toEqual(JSON.parse(JSON.stringify(direct)));
  return direct;
}

/** A High-tier PR: two files in one sensitive area, one in another, one ordinary file. */
const HIGH_PR = [
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  '.github/CODEOWNERS',
  'packages/development/lib/widget.js',
];

describe('Scenario AC-022-3: a High-tier PR offers an explainer for each touched sensitive module', () => {
  test('the report of a High PR offers one explainer per touched sensitive module, and no explainer for ordinary files', () => {
    const review = reviewOf(HIGH_PR);
    expect(review.tier.effectiveTier).toBe('high');

    const offer = offerFor(review);

    expect(offer.ok).toBe(true);
    expect(offer.offered).toBe(true);
    expect(offer.tier).toBe('high');

    // One offer per sensitive MODULE, not per file: the two workflow files
    // are one module, and the ordinary library file is offered nothing.
    const modules = offer.modules.map((entry) => entry.module);
    expect(new Set(modules).size).toBe(modules.length);
    expect(offer.modules.length).toBeGreaterThan(0);

    const offeredPaths = offer.modules.flatMap((entry) => entry.paths);
    for (const sensitive of review.paths.sensitive) {
      expect([sensitive, offeredPaths.includes(sensitive)]).toEqual([sensitive, true]);
    }
    expect(offeredPaths).not.toContain('packages/development/lib/widget.js');

    const workflows = offer.modules.find((entry) => entry.paths.includes('.github/workflows/ci.yml'));
    expect(workflows.paths).toEqual(expect.arrayContaining(['.github/workflows/ci.yml', '.github/workflows/release.yml']));
  });

  test('the case that must be refused: the same report for a PR that is not High offers nothing', () => {
    const review = reviewOf(['docs/guide.md'], { kind: 'docs' });
    expect(review.tier.effectiveTier).not.toBe('high');

    const offer = offerFor(review);

    expect(offer.offered).toBe(false);
    expect(offer.modules).toEqual([]);
    expect(offer.reason).toBe('not-high-tier');
  });

  test('a High PR that touched no sensitive module offers nothing either: the tier alone is not the trigger', () => {
    const paths = classifyPaths({ changedPaths: ['packages/development/lib/widget.js'], baseSha: BASE });
    const offer = offerFor({ paths, tier: 'high' });

    expect(offer.offered).toBe(false);
    expect(offer.reason).toBe('no-sensitive-modules-touched');
  });
});

describe('Scenario AC-022-3 (second half): an explainer is generated only if requested', () => {
  const review = () => reviewOf(HIGH_PR);

  test('the report is produced and nobody has asked yet: the offer stands and nothing is generated', () => {
    const offer = offerFor(review());

    expect(offer.offered).toBe(true);
    expect(offer.accepted).toEqual([]);
    expect(offer.generate).toEqual([]);
    expect(offer.reason).toBe('offered-awaiting-request');
  });

  test('a person asks for one of the offered modules: exactly that one is generated, and no other', () => {
    const base = offerFor(review());
    const wanted = base.modules[0].module;

    const offer = offerFor(review(), [wanted]);

    expect(offer.accepted).toEqual([wanted]);
    expect(offer.generate).toEqual([wanted]);
    expect(offer.unknownRequested).toEqual([]);
    expect(offer.generate.length).toBeLessThan(base.modules.length || 2);
  });

  test('a person asks by the file they touched: the module that file belongs to is generated once', () => {
    const offer = offerFor(review(), ['.github/workflows/ci.yml', '.github/workflows/release.yml']);

    expect(offer.generate).toHaveLength(1);
    expect(offer.accepted).toEqual(offer.generate);
  });

  test('the case that must be refused: a request for something that was never offered generates nothing and is named', () => {
    const offer = offerFor(review(), ['packages/development/lib/widget.js']);

    expect(offer.generate).toEqual([]);
    expect(offer.accepted).toEqual([]);
    expect(offer.unknownRequested).toEqual(['packages/development/lib/widget.js']);
  });

  test('the second case that must be refused: a request on a non-High PR generates nothing', () => {
    const offer = offerFor(reviewOf(['docs/guide.md'], { kind: 'docs' }), ['docs/guide.md']);

    expect(offer.offered).toBe(false);
    expect(offer.generate).toEqual([]);
    expect(offer.warnings).toContain('request-outside-offer');
  });

  test('an unreadable tier offers and generates nothing, named as such: it is never read as "no sensitive modules"', () => {
    const { paths } = reviewOf(HIGH_PR);
    const { status, out } = viaCli({ tier: { ok: false, reason: 'unreadable' }, paths, requested: ['.github/workflows/ci.yml'] });

    expect(status).toBe(0);
    expect(out.ok).toBe(false);
    expect(out.offered).toBe(false);
    expect(out.generate).toEqual([]);
    expect(out.reason).toBe('unreadable-tier');
  });
});
