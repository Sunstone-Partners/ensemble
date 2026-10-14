/**
 * TRD-017-TEST: Issue dispatch completeness (REQ-003, REQ-019).
 *
 * Verifies TRD-017: `packages/development/commands/issue.yaml`'s
 * `dispatch.subcommands[]` declares `resume`/`status`/`abandon` alongside
 * `fix`/`list`, and that the no-arg/unrecognized-action fallback (shared
 * invariant audited product-wide by TRD-006/TRD-006-TEST) still lists all
 * five keywords.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function actionsText(step) {
  return (step.actions || []).join('\n');
}

describe('Issue dispatch completeness (TRD-017)', () => {
  let commandYaml;
  let dispatchStep;

  beforeAll(() => {
    const yamlPath = path.join(__dirname, '..', 'commands', 'issue.yaml');
    commandYaml = yaml.load(fs.readFileSync(yamlPath, 'utf-8'));
    const dispatchPhase = commandYaml.workflow.phases.find((p) => p.name === 'Dispatch');
    dispatchStep = dispatchPhase.steps.find((s) => s.order === 1);
  });

  describe('dispatch.subcommands[] declares all five keywords', () => {
    test('fix/list/resume/status/abandon are present', () => {
      const subcommands = commandYaml.dispatch.subcommands;
      expect(subcommands.map((s) => s.keyword)).toEqual(['fix', 'list', 'resume', 'status', 'abandon']);
    });

    test('resume/status/abandon each reference the fix-issue sibling command', () => {
      const subcommands = commandYaml.dispatch.subcommands;
      const byKeyword = Object.fromEntries(subcommands.map((s) => [s.keyword, s]));
      expect(byKeyword.resume.ref).toBe('fix-issue');
      expect(byKeyword.status.ref).toBe('fix-issue');
      expect(byKeyword.abandon.ref).toBe('fix-issue');
    });

    test('fix still references fix-issue and list still references list-issue (unchanged)', () => {
      const subcommands = commandYaml.dispatch.subcommands;
      const byKeyword = Object.fromEntries(subcommands.map((s) => [s.keyword, s]));
      expect(byKeyword.fix.ref).toBe('fix-issue');
      expect(byKeyword.list.ref).toBe('list-issue');
    });
  });

  describe('Dispatch step constructs the correct fix-issue invocation per new keyword', () => {
    test('resume forwards the bare no-flags invocation', () => {
      expect(actionsText(dispatchStep)).toContain(
        'keyword `resume` with no remaining text: construct the bare invocation `/ensemble:fix-issue` with no flags',
      );
    });

    test('status forwards the --status invocation', () => {
      expect(actionsText(dispatchStep)).toContain(
        'keyword `status` with no remaining text: construct the invocation `/ensemble:fix-issue --status`',
      );
    });

    test('abandon forwards the --abandon invocation with optional reason', () => {
      expect(actionsText(dispatchStep)).toContain(
        'keyword `abandon`: the remaining text, if any, is an optional reason -- construct the invocation `/ensemble:fix-issue --abandon <remaining text>`',
      );
    });
  });

  describe('Test AC: no/unrecognized action lists all five actions', () => {
    test('Given ensemble-issue with no or an unrecognized action, the fallback prints fix/list/resume/status/abandon and HALTs with no side effects', () => {
      const text = actionsText(dispatchStep);
      expect(text).toMatch(
        /If the first token matches no keyword, or \$ARGUMENTS is empty: print the keyword table below \(keyword \+ one-line description\) and HALT without side effects\./,
      );
      // The keyword table referenced by that fallback is rendered from
      // dispatch.subcommands[] itself (see generate-codex.test.js /
      // command-transformer.test.js for the renderer's own proof) -- this
      // asserts the source list it renders from is now complete.
      expect(commandYaml.dispatch.subcommands.map((s) => s.keyword)).toEqual([
        'fix',
        'list',
        'resume',
        'status',
        'abandon',
      ]);
    });

    test('the matched-keyword fallback path (fix/list) still performs no table-printing side effect of its own', () => {
      expect(actionsText(dispatchStep)).toContain(
        "If the first token matches a keyword below: read and follow that subcommand's own generated command file for this runtime (see the Subcommands section this file renders), passing the remaining argument text through unmodified. Do not re-implement its phases here.",
      );
    });
  });
});
