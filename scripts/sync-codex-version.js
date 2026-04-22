#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = path.join(ROOT, 'packages', 'codex', 'package.json');
const PLUGIN_JSON = path.join(ROOT, 'packages', 'codex', '.claude-plugin', 'plugin.json');
const MARKETPLACE_JSON = path.join(ROOT, 'marketplace.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function usage() {
  console.log('Usage: node scripts/sync-codex-version.js [<version>]');
}

function main(argv) {
  const arg = argv[2];
  if (arg === '--help' || arg === '-h') {
    usage();
    process.exit(0);
  }

  const pkg = readJson(PACKAGE_JSON);
  const plugin = readJson(PLUGIN_JSON);
  const marketplace = readJson(MARKETPLACE_JSON);

  const targetVersion = arg || pkg.version;
  pkg.version = targetVersion;
  plugin.version = targetVersion;

  const entry = (marketplace.plugins || []).find((p) => p.name === 'ensemble-codex');
  if (!entry) {
    console.error('marketplace.json entry for ensemble-codex not found');
    process.exit(1);
  }
  entry.version = targetVersion;

  writeJson(PACKAGE_JSON, pkg);
  writeJson(PLUGIN_JSON, plugin);
  writeJson(MARKETPLACE_JSON, marketplace);

  console.log(`Synced ensemble-codex version to ${targetVersion}`);
}

if (require.main === module) {
  main(process.argv);
}
