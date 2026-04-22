#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_ROOT = path.join(ROOT, 'packages', 'codex');
const INSTALLER = path.join(PACKAGE_ROOT, 'bin', 'install.js');

function usage() {
  console.log('Usage: node scripts/install-codex-project.js <target-dir> [--link] [--force]');
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  if (!fs.existsSync(INSTALLER)) {
    console.error('Codex installer not found. Ensure packages/codex/bin/install.js exists.');
    process.exit(1);
  }

  const result = spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: PACKAGE_ROOT,
    stdio: 'inherit',
  });

  process.exit(result.status ?? 1);
}

if (require.main === module) {
  main(process.argv);
}
