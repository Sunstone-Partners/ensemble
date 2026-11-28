'use strict';

/**
 * TRD-017 (TRD-2026-d571763f): the `review` group -- the local review loop host.
 *
 * A table, like the `implement` group: the registry is the one place a verb becomes callable.
 * `options` exists so a test can register the same verb over a different runner executable; the
 * dispatcher never passes any.
 */

const { createSpec, spec } = require('../verbs/review-run');

/**
 * @param {{register: Function}} registry
 * @param {{cliPath?: string}} [options]
 * @returns {object[]} the registered specs
 */
function register(registry, options = {}) {
  return [registry.register(options.cliPath ? createSpec({ cliPath: options.cliPath }) : spec)];
}

module.exports = { group: 'review', register, verbs: [spec] };
