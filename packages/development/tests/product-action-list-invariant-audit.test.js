/**
 * Audit-proof test for TRD-006 / TRD-006-TEST (REQ-003).
 *
 * A prior wave audited every product-wide dispatcher command and found
 * prd.yaml, trd.yaml, and issue.yaml's Dispatch step 1 already comply with
 * the shared no-arg/unrecognized-action invariant -- no source fix was
 * needed. (feature.yaml's own compliance with this same invariant is
 * proven separately by feature-command.test.js, TRD-002/TRD-002-TEST.)
 *
 * This file is that audit's own dedicated proof: it asserts, against the
 * real YAML source, that all three specialist commands print the keyword
 * table and HALT with no side effect on both a no-arg and an unrecognized
 * first token.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function actionsText(step) {
  return (step.actions || []).join('\n');
}

function dispatchStepOf(yamlRelPath) {
  const yamlPath = path.join(__dirname, '..', '..', '..', yamlRelPath);
  const commandYaml = yaml.load(fs.readFileSync(yamlPath, 'utf-8'));
  const dispatchPhase = commandYaml.workflow.phases.find((p) => p.name === 'Dispatch');
  return dispatchPhase.steps.find((s) => s.order === 1);
}

const COMMANDS = [
  { name: 'ensemble-prd', yamlRelPath: 'packages/product/commands/prd.yaml' },
  { name: 'ensemble-trd', yamlRelPath: 'packages/development/commands/trd.yaml' },
  { name: 'ensemble-issue', yamlRelPath: 'packages/development/commands/issue.yaml' },
];

describe('Product-wide action-list invariant audit (TRD-006)', () => {
  describe.each(COMMANDS)('$name', ({ yamlRelPath }) => {
    let dispatchStep;

    beforeAll(() => {
      dispatchStep = dispatchStepOf(yamlRelPath);
    });

    test('no-arg prints the keyword table and halts with no side effect', () => {
      const text = actionsText(dispatchStep);
      expect(text).toMatch(
        /If the first token matches no keyword, or \$ARGUMENTS is empty: print the keyword table below \(keyword \+ one-line description\) and HALT without side effects\./,
      );
    });

    test('unrecognized action prints the keyword table and halts with no side effect', () => {
      // Same sentence covers both branches -- "matches no keyword" is the
      // unrecognized-action case, "or $ARGUMENTS is empty" the no-arg case,
      // both resolving to the identical print-table-and-HALT action.
      const text = actionsText(dispatchStep);
      expect(text).toMatch(/matches no keyword.*print the keyword table below.*HALT without side effects/s);
    });

    test('the matched-keyword path performs no fallback/table-printing side effect of its own', () => {
      const text = actionsText(dispatchStep);
      expect(text).toContain(
        "If the first token matches a keyword below: read and follow that subcommand's own generated command file for this runtime (see the Subcommands section this file renders), passing the remaining argument text through unmodified. Do not re-implement its phases here.",
      );
    });
  });
});
