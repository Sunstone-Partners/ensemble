#!/usr/bin/env node
'use strict';

/**
 * Deterministic PRD → Playwright test-stub CLI.
 *
 * Mirrors reqnroll-cli.js / prd-cli.js: a thin argv layer over pure libs
 * (prd-parser, playwright-gen, drift). Slash commands shell out to this;
 * nothing is hand-parsed in prose.
 *
 * Subcommands:
 *   generate     <prd-path> [--out <dir>] [--dry-run]
 *   check-drift  <prd-path> [--out <dir>] [--json]
 *
 * Exit codes:
 *   0  success / IN_SYNC
 *   1  usage or read error
 *   2  drift detected (check-drift only) — lets CI gate on it later
 */

const fs = require('fs');
const path = require('path');

const { parsePRD } = require('./prd-parser');
const { parseArgs, deriveSlug } = require('./prd-cli');
const { writeArtifacts, buildArtifacts, MANIFEST_NAME } = require('./playwright-gen');
const { diffDrift } = require('./drift');

const DEFAULT_OUT = 'e2e';

function readPrd(prdPath) {
  if (!prdPath) throw new Error('Missing required <prd-path> argument');
  try {
    return fs.readFileSync(prdPath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read PRD file '${prdPath}': ${err.message}`);
  }
}

function loadParsed(prdPath) {
  return { slug: deriveSlug(prdPath), parsed: parsePRD(readPrd(prdPath)) };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function runGenerate(argv) {
  const { positionals, flags } = parseArgs(argv, new Set(['out']));
  const prdPath = positionals[0];
  const { slug, parsed } = loadParsed(prdPath);
  const outRoot = flags.out || DEFAULT_OUT;
  const res = writeArtifacts(parsed, slug, outRoot, {
    dryRun: !!flags['dry-run'],
    prdPath,
  });
  const flagged = Object.values(buildArtifacts(parsed, slug).manifest.acs).filter(
    (a) => a.needs_clarification
  ).length;
  return {
    ok: true,
    slug,
    outDir: res.outDir,
    dryRun: !!flags['dry-run'],
    specFiles: parsed.reqs.filter((r) => r.acs.length).length,
    testCount: parsed.reqs.reduce((n, r) => n + r.acs.length, 0),
    needsClarification: flagged,
    written: res.written,
    planned: res.planned,
    warnings: parsed.warnings,
  };
}

function runCheckDrift(argv) {
  const { positionals, flags } = parseArgs(argv, new Set(['out']));
  const prdPath = positionals[0];
  const { slug, parsed } = loadParsed(prdPath);
  const outRoot = flags.out || DEFAULT_OUT;
  const manifestPath = path.join(outRoot, slug, MANIFEST_NAME);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      slug,
      noManifest: true,
      manifestPath,
      message: `No manifest at ${manifestPath} — run generate first (${err.code || err.message}).`,
    };
  }

  const drift = diffDrift(parsed, manifest);
  return { ok: true, slug, manifestPath, drift };
}

// ---------------------------------------------------------------------------
// Reporting (human-readable)
// ---------------------------------------------------------------------------

function reportGenerate(r) {
  const verb = r.dryRun ? 'Would generate' : 'Generated';
  const lines = [
    `${verb} ${r.specFiles} spec file(s) (${r.testCount} test(s)) → ${r.outDir}`,
  ];
  if (r.needsClarification) {
    lines.push(`⚠ ${r.needsClarification} AC(s) need clarification (tagged @needs-clarification).`);
  }
  for (const w of r.warnings) lines.push(`  warning: ${w}`);
  if (!r.dryRun) lines.push('  Every test starts as test.fixme() — fill them in test-first.');
  return lines.join('\n');
}

function reportDrift(r) {
  if (r.noManifest) return r.message;
  const d = r.drift;
  if (d.inSync) return `IN_SYNC — ${r.slug} spec files match the PRD.`;
  const lines = [`DRIFT DETECTED — ${r.slug}`];
  if (d.prdMismatch) lines.push('  ! manifest was generated from a different PRD document_id');
  if (d.added.length) lines.push(`  + ADDED   (${d.added.length}): ${d.added.join(', ')}`);
  if (d.removed.length) lines.push(`  - REMOVED (${d.removed.length}): ${d.removed.join(', ')}`);
  if (d.changed.length) lines.push(`  ~ CHANGED (${d.changed.length}): ${d.changed.join(', ')}`);
  lines.push('  Run generate to resync.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(argv) {
  const [cmd, ...rest] = argv;
  const wantsJson = rest.includes('--json');
  try {
    if (cmd === 'generate') {
      const r = runGenerate(rest);
      console.log(wantsJson ? JSON.stringify(r, null, 2) : reportGenerate(r));
      return 0;
    }
    if (cmd === 'check-drift') {
      const r = runCheckDrift(rest);
      console.log(wantsJson ? JSON.stringify(r, null, 2) : reportDrift(r));
      if (r.noManifest) return 1;
      return r.drift.inSync ? 0 : 2;
    }
    console.error('Usage: playwright-cli <generate|check-drift> <prd-path> [--out dir] [--dry-run] [--json]');
    return 1;
  } catch (err) {
    if (wantsJson) console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    else console.error(`Error: ${err.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, runGenerate, runCheckDrift };
