/**
 * Unit tests for TRD-013 / TRD-013-TEST (REQ-013): feature.yaml's shallow
 * pass-through of the concurrency refusal.
 *
 * A second concurrent `feature new` in the same project must surface
 * new-feature's own existing `RUN_ALREADY_ACTIVE` refusal unchanged --
 * feature.yaml adds zero new lock/stage-machine logic of its own. The
 * refusal's own content (message wording, lock semantics) is new-feature's
 * responsibility and is covered by new-feature-command.test.js
 * (AC-008-1) -- this file only proves feature.yaml's dispatcher doesn't
 * re-implement, intercept, or swallow it.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function actionsText(step) {
  return (step.actions || []).join('\n');
}

describe('Feature dispatcher concurrency pass-through (TRD-013)', () => {
  let dispatchStep;

  const yamlPath = path.join(__dirname, '..', 'commands', 'feature.yaml');

  beforeAll(() => {
    const commandYaml = yaml.load(fs.readFileSync(yamlPath, 'utf-8'));
    const dispatchPhase = commandYaml.workflow.phases.find((p) => p.name === 'Dispatch');
    dispatchStep = dispatchPhase.steps.find((s) => s.order === 1);
  });

  test('Scenario: a second concurrent `feature new` forwards RUN_ALREADY_ACTIVE unmodified, not re-implemented or swallowed', () => {
    const text = actionsText(dispatchStep);
    expect(text).toContain(
      'a second concurrent `new` while a run is already active is never detected or reported by this dispatcher',
    );
    expect(text).toContain(
      "it forwards the identical invocation into new-feature's own entry logic, which surfaces its own existing `RUN_ALREADY_ACTIVE` refusal unchanged (REQ-013)",
    );
    expect(text).toContain('naming the existing run exactly as a direct `/ensemble:new-feature` invocation would');
  });

  test('feature.yaml performs zero new lock/stage-machine logic: no RunIndexStore access and no concurrency vocabulary of its own', () => {
    const fullYamlText = fs.readFileSync(yamlPath, 'utf-8');
    // "RUN_ALREADY_ACTIVE" is mentioned only inside the pass-through
    // sentence above, naming new-feature's own code -- feature.yaml must
    // not define any additional active-run bookkeeping fields/constraints.
    expect(fullYamlText).not.toMatch(/RunIndexStore\.(createRun|mutate|findActive)/);
    expect(fullYamlText).not.toMatch(/active\.lock/);
    expect(commandYamlHasNoConstraints(fullYamlText)).toBe(true);
  });

  function commandYamlHasNoConstraints(fullYamlText) {
    const parsed = yaml.load(fullYamlText);
    return parsed.constraints === undefined;
  }
});
