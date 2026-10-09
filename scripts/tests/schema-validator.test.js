'use strict';
/**
 * Tests for validateCommandSchema's dispatch.subcommands ref-exists semantic
 * check (mirrors the existing workflow.phases[].steps[].delegation.agent
 * exists check). See local://dispatcher-command-design.md.
 */

const { validateCommandSchema } = require('../lib/schema-validator');

function baseCommand(dispatch) {
  return {
    metadata: {
      name: 'ensemble:issue',
      description: 'Dispatch to an issue-management subcommand by keyword',
      version: '1.0.0',
      lastUpdated: '2026-10-05',
      category: 'implementation'
    },
    mission: { summary: 'Thin routing layer over issue-related subcommands.' },
    dispatch,
    workflow: {
      phases: [
        {
          name: 'Dispatch',
          order: 1,
          steps: [
            {
              order: 1,
              title: 'Route by first argument token',
              description: 'Parse $ARGUMENTS and hand off to the matching sibling command',
              actions: ['Parse $ARGUMENTS.']
            }
          ]
        }
      ]
    }
  };
}

describe('validateCommandSchema — dispatch.subcommands ref-exists check', () => {
  test('passes when every subcommand ref is a known command name', () => {
    const commandNames = new Set(['fix-issue', 'list-issue']);
    expect(() =>
      validateCommandSchema(
        baseCommand({
          subcommands: [
            { keyword: 'fix', ref: 'fix-issue', description: 'd' },
            { keyword: 'list', ref: 'list-issue', description: 'd' }
          ]
        }),
        '/repo/packages/development/commands/issue.yaml',
        new Set(),
        commandNames
      )
    ).not.toThrow();
  });

  test('throws with the unresolved ref named when a subcommand ref is unknown', () => {
    const commandNames = new Set(['fix-issue']);
    expect(() =>
      validateCommandSchema(
        baseCommand({
          subcommands: [{ keyword: 'fix', ref: 'does-not-exist', description: 'd' }]
        }),
        '/repo/packages/development/commands/issue.yaml',
        new Set(),
        commandNames
      )
    ).toThrow(/Referenced command 'does-not-exist' not found in command ecosystem/);
  });

  test('skips the ref-exists check entirely when commandNames is not supplied (empty set)', () => {
    // Mirrors the delegation.agent-exists check's own opt-out semantics:
    // an empty/omitted set means "the caller didn't wire this up", not
    // "every ref is invalid" -- must not produce false positives for call
    // sites that don't pass commandNames.
    expect(() =>
      validateCommandSchema(
        baseCommand({
          subcommands: [{ keyword: 'fix', ref: 'does-not-exist', description: 'd' }]
        }),
        '/repo/packages/development/commands/issue.yaml'
      )
    ).not.toThrow();
  });

  test('a command with no dispatch field is unaffected by the check', () => {
    const plain = baseCommand(undefined);
    delete plain.dispatch;
    expect(() =>
      validateCommandSchema(plain, '/repo/packages/development/commands/fix-issue.yaml', new Set(), new Set(['fix-issue']))
    ).not.toThrow();
  });
});
