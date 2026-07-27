const fs = require('fs');
const path = require('path');

const BUNDLED_DEVELOPMENT_LIB_FILES = [
  'trd-cli.js',
  'trd-parser.js',
  'scaffold-planner.js',
  'phase-tracker.js',
  'pr-strategy.js',
  'workstream-planner.js',
  'cross-trd-deps.js',
  'workstream-status.js',
  'workstream-trd.js',
  'beads-refine-cli.js',
  'beads-scope.js',
  'beads-findings.js',
  'beads-repair-plan.js',
  'beads-repair-verify.js',
];

describe('ensemble-full bundled development CLIs', () => {
  test('bundles trd-cli and its helper modules for installed command runtime', () => {
    const libDir = path.join(__dirname, '..', 'lib');
    for (const file of BUNDLED_DEVELOPMENT_LIB_FILES) {
      expect(fs.existsSync(path.join(libDir, file))).toBe(true);
    }
    expect(() => require('../lib/trd-cli')).not.toThrow();
  });
});

describe('ensemble-full bundled files stay in sync with packages/development/lib', () => {
  // packages/full vendors these files (a standalone, self-contained plugin
  // bundle rather than an npm dependency on ensemble-development) with no
  // automated sync -- packages/full/lib/trd-parser.js drifted 4 commits
  // behind its packages/development source (missing the TRD dependency-graph
  // feature, a workstream fix, foundational-TRD capabilities, and a CRLF fix)
  // before anyone noticed. Every other bundled file happened to stay in sync
  // by hand; this test is the guard against that being luck rather than a
  // guarantee, for this file or any other in the bundled set.
  const devLibDir = path.join(__dirname, '..', '..', 'development', 'lib');
  const fullLibDir = path.join(__dirname, '..', 'lib');

  test.each(BUNDLED_DEVELOPMENT_LIB_FILES)('%s is byte-identical to packages/development/lib', (file) => {
    const devContent = fs.readFileSync(path.join(devLibDir, file), 'utf8');
    const fullContent = fs.readFileSync(path.join(fullLibDir, file), 'utf8');
    expect(fullContent).toBe(devContent);
  });
});
