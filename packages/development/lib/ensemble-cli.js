#!/usr/bin/env node
'use strict';

/**
 * TRD-002 (TRD-2026-d571763f): the `ensemble` entry point.
 *
 * `main(argv, ctx)` is the whole dispatcher and it is pure with respect to the process: it
 * returns `{ envelope, exitCode }` and never calls `process.exit`, so every behaviour below is
 * testable in process (Constitution Rule 6 -- the behaviour is reachable from the entry point,
 * and only the entry guard at the bottom touches the process).
 *
 * The flow is: parse argv -> refuse a bad flag -> `--describe` -> `--help` -> look the verb up
 * -> dispatch. A verb that is not registered is refused with the nearest known verbs; it is
 * never guessed at.
 */

const { parseArgv } = require('./engine/argv');
const { describe, nearestVerbs, renderGroupHelp, renderVerbHelp } = require('./engine/describe');
const { buildEnvelope, exitCodeFor, internal, invalidInput } = require('./engine/envelope');
const { createRegistry } = require('./engine/registry');

/**
 * The engine's registry. Groups are registered here and nowhere else, so `--describe` and the
 * dispatcher can never disagree about what exists.
 * @returns {object} a fresh registry
 */
function buildRegistry() {
  return createRegistry();
}

function result(envelope, exitCode) {
  return { envelope, exitCode };
}

function envelopeResult(envelope) {
  return result(envelope, exitCodeFor(envelope.status));
}

/**
 * @param {string[]} argv the arguments after the program name
 * @param {{cwd?: string, env?: object, registry?: object, stdout?: object, stderr?: object}} [ctx]
 * @returns {{envelope: object|null, exitCode: number}}
 */
function main(argv, ctx = {}) {
  const stdout = ctx.stdout || process.stdout;
  const stderr = ctx.stderr || process.stderr;
  const streams = { stderr, stdout };
  const registry = ctx.registry || buildRegistry();

  const parsed = parseArgv(argv);
  const label = [parsed.group, parsed.verb].filter(Boolean).join(' ') || 'ensemble';

  if (parsed.error) {
    return envelopeResult(
      invalidInput(label, parsed.error.code, parsed.error.message)
    );
  }

  if (parsed.describe) {
    let data;
    try {
      data = describe(registry);
    } catch (error) {
      if (error && error.status) {
        return envelopeResult(
          buildEnvelope({
            error: { code: error.code, message: error.message },
            ok: false,
            status: error.status,
            verb: 'ensemble --describe',
          })
        );
      }
      return envelopeResult(internal('ensemble --describe', error, streams));
    }
    return envelopeResult(
      buildEnvelope({ data, ok: true, status: 'OK', verb: 'ensemble --describe' })
    );
  }

  if (parsed.help) {
    if (parsed.group && parsed.verb && registry.get(parsed.group, parsed.verb)) {
      stdout.write(renderVerbHelp(registry, parsed.group, parsed.verb));
      return result(null, 0);
    }
    if (parsed.group && registry.groups().includes(parsed.group)) {
      stdout.write(renderGroupHelp(registry, parsed.group));
      return result(null, 0);
    }
    stdout.write(renderRootHelp(registry));
    return result(null, 0);
  }

  if (!parsed.group || !parsed.verb) {
    stdout.write(renderRootHelp(registry));
    return result(null, 0);
  }

  const spec = registry.get(parsed.group, parsed.verb);
  if (!spec) {
    const nearest = nearestVerbs(registry, parsed.group, parsed.verb);
    const suffix = nearest.length === 0 ? 'no verbs are registered' : `did you mean: ${nearest.join(', ')}`;
    return envelopeResult(
      invalidInput(label, 'UNKNOWN_VERB', `unknown verb '${label}'; ${suffix}`)
    );
  }

  const call = {
    cwd: ctx.cwd || process.cwd(),
    env: ctx.env || process.env,
    globals: parsed.globals,
    rest: parsed.rest,
    stderr,
    stdout,
    verb: label,
  };

  try {
    const value = spec.handler(call);
    return envelopeResult(
      buildEnvelope({ data: value, ok: true, status: 'OK', verb: label })
    );
  } catch (error) {
    if (error && error.status) {
      return envelopeResult(
        buildEnvelope({
          error: { code: error.code, message: error.message },
          ok: false,
          status: error.status,
          verb: label,
        })
      );
    }
    return envelopeResult(internal(label, error, streams));
  }
}

/**
 * @param {object} registry
 * @returns {string} top-level help, generated from the registry
 */
function renderRootHelp(registry) {
  const lines = ['ensemble <group> <verb> [flags]', '', 'Groups:'];
  for (const group of registry.groups()) {
    const names = registry.verbs(group).map(spec => spec.name);
    lines.push(`  ${group} -- ${names.join(', ')}`);
  }
  if (registry.groups().length === 0) lines.push('  (none registered)');
  lines.push('', 'Run `ensemble --describe` for the machine-readable registry.');
  return `${lines.join('\n')}\n`;
}

if (require.main === module) {
  const { envelope, exitCode } = main(process.argv.slice(2));
  if (envelope) process.stdout.write(`${JSON.stringify(envelope)}\n`);
  process.exitCode = exitCode;
}

module.exports = { buildRegistry, main };
