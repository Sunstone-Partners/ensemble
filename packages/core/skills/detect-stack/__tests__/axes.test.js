/**
 * Behaviour of the framework, test and tooling axes of detect-stack against
 * real directory trees (the cloud axis has its own suite in cloud.test.js).
 *
 * Expected confidences are written out from the weights in patterns/*.json so
 * that an accidental change to a weight, threshold or boost fails here. The
 * merge must not change scoring.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { detect, detectionCache } = require('../detect-stack');

const created = [];

/** Create a throwaway project directory containing { relativePath: content }. */
function makeProject(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-stack-axes-'));
  created.push(dir);
  for (const [relativePath, content] of Object.entries(files)) {
    const file = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

afterAll(() => {
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const names = list => list.map(entry => entry.name);

// ---------------------------------------------------------------------------
// framework
// ---------------------------------------------------------------------------

const FRAMEWORK_PROJECTS = {
  react: {
    'package.json': { name: 'web', dependencies: { react: '^18.2.0', 'react-dom': '^18.2.0' } },
    'public/index.html': '<div id="root"></div>',
    'src/App.tsx': [
      "import React, { useState, useEffect } from 'react';",
      'export default function App() {',
      '  const [n, setN] = useState(0);',
      '  useEffect(() => {}, []);',
      '  return <div>{n}</div>;',
      '}'
    ].join('\n'),
    'src/index.tsx': [
      "import { createRoot } from 'react-dom/client';",
      "import App from './App';",
      "createRoot(document.getElementById('root')).render(<App />);"
    ].join('\n')
  },
  nestjs: {
    'package.json': {
      dependencies: { '@nestjs/core': '^10', '@nestjs/common': '^10', '@nestjs/platform-express': '^10' },
      devDependencies: { '@nestjs/cli': '^10' }
    },
    'nest-cli.json': { collection: '@nestjs/schematics', sourceRoot: 'src' },
    'tsconfig.json': '{}',
    'src/main.ts': "import { NestFactory } from '@nestjs/core';\n",
    'src/app.module.ts': "import { Module } from '@nestjs/common';\n@Module({})\nexport class AppModule {}\n",
    'src/app.controller.ts': "import { Controller } from '@nestjs/common';\n@Controller()\n@Injectable()\nexport class AppController {}\n"
  },
  rails: {
    Gemfile: "source 'https://rubygems.org'\ngem 'rails', '~> 7.0'\n",
    'config/application.rb': 'module App\n  class Application < Rails::Application\n  end\nend\n',
    'config/routes.rb': 'Rails.application.routes.draw do\nend\n',
    'config/environment.rb': '',
    Rakefile: '',
    'app/controllers/application_controller.rb': 'class ApplicationController < ActionController::Base\nend\nclass Post < ActiveRecord::Base\nend\n'
  },
  phoenix: {
    'mix.exs': [
      'defmodule App.MixProject do',
      '  def application, do: []',
      '  defp deps do',
      '    [{:phoenix, "~> 1.7"}, {:phoenix_ecto, "~> 4.4"}, {:phoenix_live_view, "~> 0.20"}]',
      '  end',
      'end'
    ].join('\n'),
    'config/config.exs': 'import Config\n',
    'lib/app_web/endpoint.ex': 'defmodule AppWeb.Endpoint do\n  use Phoenix.Endpoint, otp_app: :app\nend\n',
    'lib/app_web/router.ex': 'defmodule AppWeb.Router do\n  use Phoenix.Router\nend\n',
    'lib/app/application.ex': 'defmodule App.Application do\nend\n'
  },
  dotnet: {
    'Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><PackageReference Include="Microsoft.AspNetCore.Mvc" Version="8.0.0" /><PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.0" /></ItemGroup></Project>',
    'Program.cs': 'using Microsoft.AspNetCore;\nvar app = WebApplication.Create(args);\n',
    'Controllers/WeatherController.cs': 'using Microsoft.AspNetCore.Mvc;\n[ApiController]\n[Route("weather")]\npublic class WeatherController {}\n',
    'appsettings.json': '{}'
  },
  blazor: {
    'App.csproj': '<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly"><ItemGroup><PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly" Version="8.0.0" /></ItemGroup></Project>',
    'App.razor': '<Router />',
    '_Imports.razor': '@using Microsoft.AspNetCore.Components',
    'Pages/Index.razor': '@page "/"\n@code { }\n@inject IFoo Foo\n',
    'wwwroot/index.html': '<html></html>',
    'Counter.cs': 'using Microsoft.AspNetCore.Components;\npublic class Counter : ComponentBase { void Bump() { StateHasChanged(); } }\n'
  }
};

describe('framework axis', () => {
  test.each(Object.keys(FRAMEWORK_PROJECTS))('detects %s from a representative project', async framework => {
    const result = await detect('framework', makeProject(FRAMEWORK_PROJECTS[framework]));

    expect(result.axis).toBe('framework');
    expect(result.detected).toBe(true);
    expect(result.primary).toBe(framework);
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.results[0].name).toBe(framework);
  });

  test('reports the signals that fired and their raw scores', async () => {
    const result = await detect('framework', makeProject(FRAMEWORK_PROJECTS.react));
    const react = result.results[0];

    expect(react.display_name).toBe('React');
    expect(react.signals).toEqual({ packageJson: true, files: true, imports: true });
    expect(react.signal_count).toBe(3);
    // react + react-dom (2 x weight 10), three optional files (3 x 7), imports (5 pattern hits x 8)
    expect(react.details.packageJson).toEqual({ matches: 2, weight: 10, score: 20 });
    expect(react.details.files).toEqual({ matches: 3, weight: 7, score: 21 });
    expect(react.details.imports).toEqual({ matches: 5, weight: 8, score: 40 });
    // (20 + 21 + 40) / 75, then boosted x1.4 (jsx files) x1.3 (useState/useEffect) x1.2 (createRoot)
    expect(react.confidence).toBeCloseTo((81 / 75) * 1.4 * 1.3 * 1.2, 5);
  });

  test('confidence is not capped at 1.0', async () => {
    const result = await detect('framework', makeProject(FRAMEWORK_PROJECTS.blazor));

    expect(result.confidence).toBeGreaterThan(1);
  });

  test('a lone dependency is below the 0.8 threshold but still ranked first', async () => {
    const dir = makeProject({ 'package.json': { dependencies: { react: '^18' } } });

    const result = await detect('framework', dir);

    expect(result.detected).toBe(false);
    expect(result.primary).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.threshold).toBe(0.8);
    expect(result.all_results[0].name).toBe('react');
    expect(result.all_results[0].confidence).toBeCloseTo(10 / 75, 5);
  });

  test('all_results lists every framework, best first, with zero-confidence entries last', async () => {
    const result = await detect('framework', makeProject(FRAMEWORK_PROJECTS.rails));

    expect(names(result.all_results).sort()).toEqual(['blazor', 'dotnet', 'nestjs', 'phoenix', 'rails', 'react']);
    expect(result.all_results[0].name).toBe('rails');
    const confidences = result.all_results.map(entry => entry.confidence);
    expect(confidences).toEqual([...confidences].sort((a, b) => b - a));
    expect(result.all_results.at(-1).confidence).toBe(0);
    expect(result.all_results.at(-1).signals).toEqual(expect.any(Object));
  });

  test('a project with two frameworks reports the second as an alternate', async () => {
    const dir = makeProject({
      ...FRAMEWORK_PROJECTS.react,
      'package.json': {
        dependencies: { react: '^18', 'react-dom': '^18', '@nestjs/core': '^10', '@nestjs/common': '^10' }
      },
      'nest-cli.json': '{}',
      'tsconfig.json': '{}',
      'src/app.module.ts': "import { Module } from '@nestjs/common';\n@Module({})\nexport class AppModule {}\n"
    });

    const result = await detect('framework', dir);

    expect(result.primary).toBe('react');
    expect(names(result.results)).toEqual(['react', 'nestjs']);
  });

  test('a manual override skips detection', async () => {
    const result = await detect('framework', makeProject(), { framework: 'rails' });

    expect(result.manual_override).toBe(true);
    expect(result.primary).toBe('rails');
    expect(result.confidence).toBe(1);
    expect(result.results[0].signals).toEqual({});
    expect(result.results[0].details.manualOverride).toEqual({ matches: 1, weight: 100, score: 100 });
  });

  test('an invalid manual override lists the valid frameworks', async () => {
    await expect(detect('framework', makeProject(), { framework: 'angular' }))
      .rejects.toThrow(/Invalid framework 'angular'.*nestjs, react, phoenix, rails, dotnet, blazor/);
  });

  test('skipDetection returns an empty result', async () => {
    const result = await detect('framework', makeProject(FRAMEWORK_PROJECTS.react), { skipDetection: true });

    expect(result.skipped).toBe(true);
    expect(result.detected).toBe(false);
    expect(result.results).toEqual([]);
  });

  test('an empty project detects nothing', async () => {
    const result = await detect('framework', makeProject());

    expect(result.detected).toBe(false);
    expect(result.primary).toBeNull();
    expect(result.results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// test runners
// ---------------------------------------------------------------------------

const TEST_PROJECTS = {
  jest: {
    'package.json': { devDependencies: { jest: '^29.7.0', 'ts-jest': '^29.1.0' } },
    'jest.config.ts': 'export default {};',
    '__tests__/sum.test.ts': "test('sum', () => {});"
  },
  pytest: {
    'requirements.txt': 'pytest==7.4.0\nrequests==2.31.0\n',
    'pytest.ini': '[pytest]\n',
    'tests/test_sum.py': 'def test_sum():\n    assert 1 + 1 == 2\n'
  },
  rspec: {
    Gemfile: "source 'https://rubygems.org'\ngem 'rspec', '~> 3.12'\n",
    '.rspec': '--require spec_helper\n',
    'spec/sum_spec.rb': "describe 'sum' do\nend\n"
  },
  xunit: {
    'Tests.csproj': '<Project><ItemGroup><PackageReference Include="xunit" Version="2.6.1" /><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.8.0" /></ItemGroup></Project>',
    'xunit.runner.json': '{}',
    'Tests/SumTests.cs': 'public class SumTests {}'
  },
  exunit: {
    'mix.exs': 'defmodule App.MixProject do\nend\n',
    'test/test_helper.exs': 'ExUnit.start()\n',
    'test/sum_test.exs': 'defmodule SumTest do\n  use ExUnit.Case\nend\n'
  }
};

describe('test axis', () => {
  test.each(Object.keys(TEST_PROJECTS))('detects %s as the primary runner', async runner => {
    const result = await detect('test', makeProject(TEST_PROJECTS[runner]));

    expect(result.axis).toBe('test');
    expect(result.detected).toBe(true);
    expect(result.primary).toBe(runner);
    expect(result.results[0].name).toBe(runner);
    expect(result.results[0].confidence).toBeGreaterThan(0.5);
  });

  test('result entries describe the runner, its version and where it was found', async () => {
    const result = await detect('test', makeProject(TEST_PROJECTS.jest));
    const jest = result.results[0];

    expect(jest).toMatchObject({
      name: 'jest',
      display_name: 'Jest',
      language: 'JavaScript/TypeScript',
      version: '29.7.0',
      config_files: ['jest.config.ts'],
      test_directory: '__tests__',
      test_pattern: '**/*.test.js',
      signals: { configFile: true, packageDependency: true, testDirectory: true, testFiles: true },
      signal_count: 4
    });
    expect(jest.confidence).toBeCloseTo(1, 10); // 0.4 + 0.3 + 0.2 + 0.1
  });

  test('extracts versions from requirements.txt', async () => {
    const result = await detect('test', makeProject(TEST_PROJECTS.pytest));

    expect(result.results[0].version).toBe('7.4.0');
  });

  test.each([
    ['config file', { 'jest.config.js': 'module.exports = {};' }, { configFile: true }, 0.4],
    ['package dependency', { 'package.json': { devDependencies: { jest: '^29.0.0' } } }, { packageDependency: true }, 0.3],
    ['test directory', { '__tests__/.keep': '' }, { testDirectory: true }, 0.2],
    ['test files', { 'src/a.test.js': '' }, { testFiles: true }, 0.1]
  ])('weighs the %s signal alone at its configured weight', async (_label, files, expected, confidence) => {
    const result = await detect('test', makeProject(files));
    const jest = result.all_results.find(entry => entry.name === 'jest');

    expect(jest.signals).toEqual({ configFile: false, packageDependency: false, testDirectory: false, testFiles: false, ...expected });
    expect(jest.confidence).toBeCloseTo(confidence, 10);
  });

  test('only the first config file and the first test directory count', async () => {
    const result = await detect('test', makeProject({
      'jest.config.js': '',
      'jest.config.ts': '',
      '__tests__/.keep': '',
      'tests/.keep': ''
    }));
    const jest = result.all_results.find(entry => entry.name === 'jest');

    expect(jest.config_files).toEqual(['jest.config.js']);
    expect(jest.test_directory).toBe('tests');
    expect(jest.confidence).toBeCloseTo(0.6, 10);
  });

  test('there is no minimum threshold: any signal is reported', async () => {
    const result = await detect('test', makeProject({ 'pyproject.toml': '[project]\nname = "x"\n' }));

    expect(result.threshold).toBeNull();
    expect(result.detected).toBe(true);
    expect(result.primary).toBe('pytest');
    expect(result.confidence).toBeCloseTo(0.4, 10);
  });

  test('all_results lists every runner, including those without signals', async () => {
    const result = await detect('test', makeProject(TEST_PROJECTS.rspec));

    expect(names(result.all_results).sort()).toEqual(['exunit', 'jest', 'pytest', 'rspec', 'xunit']);
    expect(result.all_results.find(entry => entry.name === 'jest').confidence).toBe(0);
    expect(names(result.results)).toContain('rspec');
    expect(result.results.every(entry => entry.confidence > 0)).toBe(true);
  });

  test('an empty project detects nothing and says how to proceed', async () => {
    const result = await detect('test', makeProject());

    expect(result.detected).toBe(false);
    expect(result.primary).toBeNull();
    expect(result.results).toEqual([]);
    expect(result.message).toBe('No test framework detected. Please specify framework manually.');
  });
});

// ---------------------------------------------------------------------------
// tooling
// ---------------------------------------------------------------------------

const TOTAL = { helm: 1.4, kubernetes: 1.7, kustomize: 1.0, argocd: 1.1, flyio: 1.0 };
const TOOLING_BOOST = 0.1; // confidence_boost, applied from 3 signals

describe('tooling axis', () => {
  beforeEach(() => detectionCache.clear());

  test('detects a Helm chart (3 signals: chart, values, templates)', async () => {
    const dir = makeProject({
      'Chart.yaml': 'name: web\nversion: 0.1.0\n',
      'values.yaml': 'replicas: 1\n',
      'templates/deployment.yaml': 'kind: Deployment\n'
    });

    const result = await detect('tooling', dir);

    expect(result.axis).toBe('tooling');
    expect(result.detected).toBe(true);
    expect(result.primary).toBe('helm');
    expect(result.results[0].signals).toEqual({
      chart_yaml: true,
      values_yaml: true,
      templates_dir: true,
      cli: false,
      config: false
    });
    expect(result.results[0].signal_count).toBe(3);
    expect(result.confidence).toBeCloseTo((0.6 + 0.3 + 0.2) / TOTAL.helm + TOOLING_BOOST, 5);
    expect(result.threshold).toBe(0.7);
  });

  test('two signals do not reach the boost or the threshold', async () => {
    const dir = makeProject({ 'Chart.yaml': 'name: web\n', 'values.yaml': 'a: 1\n' });

    const result = await detect('tooling', dir);

    expect(result.detected).toBe(false);
    expect(result.all_results[0].name).toBe('helm');
    expect(result.all_results[0].confidence).toBeCloseTo((0.6 + 0.3) / TOTAL.helm, 5);
  });

  test('detects Kubernetes manifests and Kustomize from root-level files and scripts', async () => {
    const dir = makeProject({
      'deployment.yaml': 'apiVersion: apps/v1\nkind: Deployment\n',
      'kustomization.yaml': 'resources:\n  - deployment.yaml\n',
      'deploy.sh': 'kubectl apply -k .\n'
    });

    const result = await detect('tooling', dir);

    const kubernetes = result.results.find(entry => entry.name === 'kubernetes');
    expect(kubernetes.signals).toMatchObject({ api_version: true, kind_field: true, kustomization: true, cli: true });
    expect(kubernetes.confidence).toBeCloseTo((0.5 + 0.4 + 0.3 + 0.2) / TOTAL.kubernetes + TOOLING_BOOST, 5);
    expect(names(result.results)).toContain('kustomize');
  });

  test('YAML content signals only look at root-level *.yaml files', async () => {
    const dir = makeProject({
      'k8s/deployment.yaml': 'apiVersion: apps/v1\nkind: Deployment\n',
      'k8s/service.yaml': 'apiVersion: v1\nkind: Service\n'
    });

    const result = await detect('tooling', dir);
    const kubernetes = result.all_results.find(entry => entry.name === 'kubernetes');

    expect(result.detected).toBe(false);
    expect(kubernetes.signals.api_version).toBe(false);
    expect(kubernetes.signals.kind_field).toBe(false);
    // the k8s/ directory itself still counts (config + manifests_dir)
    expect(kubernetes.signals.config).toBe(true);
    expect(kubernetes.signals.manifests_dir).toBe(true);
  });

  test('detects ArgoCD applications', async () => {
    const dir = makeProject({
      'app.yaml': 'apiVersion: argoproj.io/v1alpha1\nkind: Application\n',
      'sync.sh': 'argocd app sync web\n',
      'argocd/README.txt': ''
    });

    const result = await detect('tooling', dir);

    expect(result.primary).toBe('argocd');
    // (0.6 + 0.3 + 0.2) / 1.1 is already 1.0, so the boost is capped away
    expect(result.confidence).toBeCloseTo(1, 10);
  });

  test('detects Fly.io from fly.toml alone (weight 0.7 meets the threshold)', async () => {
    const result = await detect('tooling', makeProject({ 'fly.toml': 'app = "web"\n' }));

    expect(result.primary).toBe('flyio');
    expect(result.results[0].display_name).toBe('Fly.io');
    expect(result.confidence).toBeCloseTo(0.7 / TOTAL.flyio, 5);
    expect(result.results[0].high_confidence).toBe(true);
  });

  test('fly.toml is found within 3 path levels (a/b/fly.toml) and not deeper (a/b/c/fly.toml)', async () => {
    const shallow = await detect('tooling', makeProject({ 'a/b/fly.toml': 'app = "web"\n' }));
    const deep = await detect('tooling', makeProject({ 'a/b/c/fly.toml': 'app = "web"\n' }));

    expect(shallow.results[0].signals.fly_toml).toBe(true);
    expect(shallow.primary).toBe('flyio');
    expect(deep.all_results.find(entry => entry.name === 'flyio').signals.fly_toml).toBe(false);
    expect(deep.detected).toBe(false);
  });

  test('node_modules and vendor are not searched', async () => {
    const dir = makeProject({
      'node_modules/pkg/fly.toml': 'app = "x"\n',
      'vendor/pkg/fly.toml': 'app = "y"\n'
    });

    const result = await detect('tooling', dir);

    expect(result.all_results.find(entry => entry.name === 'flyio').signals.fly_toml).toBe(false);
  });

  test('script signals read root-level *.sh files only', async () => {
    const nested = await detect('tooling', makeProject({ 'scripts/deploy.sh': 'helm install web .\n' }));
    const root = await detect('tooling', makeProject({ 'deploy.sh': 'helm install web .\n' }));

    expect(nested.all_results.find(entry => entry.name === 'helm').signals.cli).toBe(false);
    expect(root.all_results.find(entry => entry.name === 'helm').signals.cli).toBe(true);
  });

  test('glob matches skip symlinks while direct paths follow them', async () => {
    // The only fly.toml is a symlink to a file with another name
    const nested = makeProject({ 'real/app.toml': 'app = "web"\n' });
    const root = makeProject({ 'real/app.toml': 'app = "web"\n' });
    try {
      fs.mkdirSync(path.join(nested, 'a'));
      fs.symlinkSync('../real/app.toml', path.join(nested, 'a', 'fly.toml'));
      fs.symlinkSync('real/app.toml', path.join(root, 'fly.toml'));
    } catch {
      return; // symlinks unavailable on this platform
    }

    const viaGlob = await detect('tooling', nested);
    const direct = await detect('tooling', root);

    // a/fly.toml is only reachable through the **/fly.toml glob, which matches regular files only
    expect(viaGlob.all_results.find(entry => entry.name === 'flyio').signals.fly_toml).toBe(false);
    // the root fly.toml is checked with fs.existsSync, which follows the link
    expect(direct.all_results.find(entry => entry.name === 'flyio').signals.fly_toml).toBe(true);
  });

  test('--tools style filtering evaluates only the requested tools', async () => {
    const dir = makeProject({ 'Chart.yaml': '', 'values.yaml': '', 'templates/a.yaml': '' });

    const result = await detect('tooling', dir, { tools: ['helm'] });

    expect(names(result.all_results)).toEqual(['helm']);
    expect(result.primary).toBe('helm');
  });

  test('an unknown tool name is rejected', async () => {
    await expect(detect('tooling', makeProject(), { tools: ['terraform'] }))
      .rejects.toThrow("Unknown tool 'terraform'. Valid tools: helm, kubernetes, kustomize, argocd, flyio");
  });

  test('minimumConfidence changes what counts as detected, not the scores', async () => {
    const dir = makeProject({ 'Chart.yaml': '', 'values.yaml': '' });

    const lenient = await detect('tooling', dir, { minimumConfidence: 0.6, useCache: false });
    const strict = await detect('tooling', dir, { useCache: false });

    expect(lenient.primary).toBe('helm');
    expect(lenient.threshold).toBe(0.6);
    expect(strict.detected).toBe(false);
    expect(lenient.all_results[0].confidence).toBe(strict.all_results[0].confidence);
  });

  test('all_results lists every tool, best first', async () => {
    const result = await detect('tooling', makeProject({ 'fly.toml': 'app = "web"\n' }));

    expect(names(result.all_results)).toEqual(['flyio', 'helm', 'kubernetes', 'kustomize', 'argocd']);
    for (const entry of result.all_results) {
      expect(entry.signal_count).toBe(Object.values(entry.signals).filter(Boolean).length);
      expect(typeof entry.description).toBe('string');
    }
  });

  test('repeated detections of an unchanged project are served from the cache', async () => {
    const dir = makeProject({ 'fly.toml': 'app = "web"\n' });

    const first = await detect('tooling', dir);
    // The cache key covers the primary signal files (weight >= 0.5, e.g. Chart.yaml,
    // fly.toml). values.yaml is not one of them, so adding it leaves the key unchanged.
    fs.writeFileSync(path.join(dir, 'values.yaml'), 'replicas: 1\n');
    const cached = await detect('tooling', dir);
    const fresh = await detect('tooling', dir, { useCache: false });

    expect(cached.all_results).toEqual(first.all_results);
    expect(cached.all_results.find(entry => entry.name === 'helm').signals.values_yaml).toBe(false);
    expect(fresh.all_results.find(entry => entry.name === 'helm').signals.values_yaml).toBe(true);
  });

  test('changing a returned result does not change what the cache serves next', async () => {
    const dir = makeProject({ 'fly.toml': 'app = "web"\n' });

    const first = await detect('tooling', dir);
    first.all_results[0].signals.fly_toml = false;
    first.results[0].signals.fly_toml = false;
    const second = await detect('tooling', dir);

    expect(second.all_results[0].name).toBe('flyio');
    expect(second.all_results[0].signals.fly_toml).toBe(true);
    expect(second.results[0].signals.fly_toml).toBe(true);
  });

  test('a symlink cycle does not hang the scan', async () => {
    const dir = makeProject({ 'deploy.sh': 'helm install web .\n' });
    try {
      fs.symlinkSync('.', path.join(dir, 'loop'));
    } catch {
      return; // symlinks unavailable on this platform
    }

    const result = await detect('tooling', dir, { useCache: false });

    expect(result.all_results.find(entry => entry.name === 'helm').signals.cli).toBe(true);
  }, 10000);

  test('an empty project detects nothing', async () => {
    const result = await detect('tooling', makeProject());

    expect(result.detected).toBe(false);
    expect(result.primary).toBeNull();
    expect(result.results).toEqual([]);
    expect(result.all_results).toHaveLength(5);
  });
});
