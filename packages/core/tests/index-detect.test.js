/**
 * Regression test: index.js detect() must instantiate FrameworkDetector with `new`
 * (it previously called the class as a function and threw
 * "Class constructor FrameworkDetector cannot be invoked without 'new'").
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../lib/index');

describe('core index detect()', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-core-detect-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('detects a framework from a project directory', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' } })
    );

    const result = await core.detect(projectDir);

    expect(result).toEqual(
      expect.objectContaining({
        confidence: expect.any(Number),
        alternates: expect.any(Array),
        details: expect.any(Object),
      })
    );
    // The package.json signal proves the detector actually ran against the project.
    expect(result.details.react.packageJson.matches).toBe(2);
  });

  it('forwards options such as a manual framework override', async () => {
    const result = await core.detect(projectDir, { framework: 'react' });

    expect(result.primary).toBe('react');
  });

  it('returns a null primary for an empty project', async () => {
    const result = await core.detect(projectDir);

    expect(result.primary).toBeNull();
  });
});
