#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = path.join(ROOT, 'packages', 'codex', 'package.json');
const PLUGIN_JSON = path.join(ROOT, 'packages', 'codex', '.claude-plugin', 'plugin.json');
// Claude Code loads the .claude-plugin/ path, while validate-all.js and
// validate-version-sync.js read the root one. .claude-plugin/marketplace.json
// is a symlink to ../marketplace.json, so writing "both" paths below writes
// the same underlying file twice -- harmless, and keeps this script correct
// even if that symlink is ever replaced with a real file again.
const MARKETPLACE_JSONS = [
  path.join(ROOT, 'marketplace.json'),
  path.join(ROOT, '.claude-plugin', 'marketplace.json'),
];

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

  const targetVersion = arg || pkg.version;
  pkg.version = targetVersion;
  plugin.version = targetVersion;

  const marketplaces = MARKETPLACE_JSONS.map((file) => {
    const marketplace = readJson(file);
    const entry = (marketplace.plugins || []).find((p) => p.name === 'ensemble-codex');
    if (!entry) {
      console.error(`${path.relative(ROOT, file)} entry for ensemble-codex not found`);
      process.exit(1);
    }
    entry.version = targetVersion;
    return { file, marketplace };
  });

  writeJson(PACKAGE_JSON, pkg);
  writeJson(PLUGIN_JSON, plugin);
  marketplaces.forEach(({ file, marketplace }) => writeJson(file, marketplace));

  console.log(`Synced ensemble-codex version to ${targetVersion}`);
}

if (require.main === module) {
  main(process.argv);
}
