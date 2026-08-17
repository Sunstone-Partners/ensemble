'use strict';

const fs = require('fs');
const path = require('path');

describe('validate-git-town.sh remediation text (TRD-005)', () => {
  const scriptPath = path.join(
    __dirname,
    '..',
    'skills',
    'git-town',
    'scripts',
    'validate-git-town.sh'
  );
  const contents = fs.readFileSync(scriptPath, 'utf8');

  test('no longer references the nonexistent "git town config setup" command', () => {
    expect(contents).not.toContain('git town config setup');
  });
});

describe('git-town SKILL.md remediation text (TRD-006)', () => {
  const skillPath = path.join(__dirname, '..', 'skills', 'git-town', 'SKILL.md');
  const contents = fs.readFileSync(skillPath, 'utf8');

  test('no longer references the nonexistent "git town config set-main-branch main" command anywhere in the file', () => {
    expect(contents).not.toContain('git town config set-main-branch main');
  });
});
