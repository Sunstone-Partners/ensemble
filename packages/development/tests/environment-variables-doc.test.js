'use strict';

const fs = require('fs');
const path = require('path');

describe('docs/guides/environment-variables.md (TRD-007)', () => {
  const docPath = path.join(__dirname, '..', '..', '..', 'docs', 'guides', 'environment-variables.md');
  const contents = fs.readFileSync(docPath, 'utf8');

  test('documents ENSEMBLE_BRANCHING_STRATEGY as a table row header', () => {
    expect(contents).toMatch(/\|\s*`ENSEMBLE_BRANCHING_STRATEGY`\s*\|/);
  });

  test('documents ENSEMBLE_PR_BACKEND as a table row header', () => {
    expect(contents).toMatch(/\|\s*`ENSEMBLE_PR_BACKEND`\s*\|/);
  });
});
