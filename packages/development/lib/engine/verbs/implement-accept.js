'use strict';

/**
 * TRD-016 (TRD-2026-d571763f): `ensemble implement accept --step <id> --result-file <path>`,
 * the resume half of a hand-off. All of the validation lives in `handoff.js`; this verb is its
 * entry point and declares what `--describe` publishes.
 */

const { acceptResult } = require('../handoff');
const { ROLES } = require('../roles');

function handler(call) {
  return acceptResult(call, { resultFile: call.input['result-file'], step: call.input.step });
}

const spec = {
  exitCodes: [0, 1, 2, 3, 5],
  group: 'implement',
  handler,
  inputSchema: {
    additionalProperties: false,
    properties: {
      'result-file': { 'x-path': true, type: 'string' },
      step: { type: 'string' },
    },
    required: ['result-file', 'step'],
    type: 'object',
  },
  name: 'accept',
  outputSchema: {
    additionalProperties: false,
    properties: {
      ACCEPTED: { type: 'boolean' },
      HEAD: { type: 'string' },
      RECORD_PATH: { type: 'string' },
      RESULT: { type: 'object' },
      RESULT_SHA256: { type: 'string' },
      ROLE: { enum: Object.keys(ROLES).sort(), type: 'string' },
      STEP: { type: 'string' },
    },
    required: [],
    type: 'object',
  },
  policyKeys: [],
  sideEffect: 'write',
  summary: 'validate a model result file against its role and record it',
};

module.exports = { spec };
