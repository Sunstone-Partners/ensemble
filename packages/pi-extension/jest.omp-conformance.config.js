/**
 * OMP host conformance (TRD-031): `npm run test:omp-conformance`.
 *
 * Its own config, and so its own report, because its evidence is a real
 * `omp` process rather than Pi's fake host surface. The default `jest` run
 * never matches `*.conformance.ts`, so a green Pi run cannot stand in for it.
 */
const base = require("./jest.config.js");

module.exports = {
  ...base,
  testMatch: ["<rootDir>/tests/omp-conformance/**/*.conformance.ts"],
  testTimeout: 120000,
};
