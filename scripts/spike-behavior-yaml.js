#!/usr/bin/env node
/**
 * spike-behavior-yaml.js — REQ-BEH-004 compilation spike (br-3r4)
 *
 * Question this spike answers: can the runtime *compile* §3.1-shaped
 * behavior.yaml files from the phrase registry (packages/router/lib/
 * behavior-phrases.json) + the SKILL.md files they were extracted from,
 * deterministically and byte-stably, instead of hand-authoring each
 * behavior?
 *
 * Method: one output byteset per behavior; run twice, compare hashes;
 * also report whether a hand-authored seed (test-failure) round-trips
 * through the same schema shape.
 *
 * NOT wired into generate-behaviors.js — throwaway, findings go to the
 * Sprint-1 schema task.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY = path.join(ROOT, 'packages/router/lib/behavior-phrases.json');

function sha(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}

// --- 1. Load registry, group phrases by skill (the behavior identity) ---
const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
const bySkill = new Map();
for (const [phrase, hits] of Object.entries(reg.phrases)) {
  for (const h of hits) {
    if (!bySkill.has(h.skill)) bySkill.set(h.skill, { command: h.command, source: h.source, phrases: [] });
    bySkill.get(h.skill).phrases.push(phrase);
  }
}

// --- 2. Compile a behavior.yaml per skill ---
function compile(skill, info) {
  const doc = {
    api_version: 'ensemble.sunstone.dev/v1',
    kind: 'Behavior',
    metadata: {
      name: skill,
      version: '0.1.0',
      description: `Compiled from phrase registry: ${info.phrases.length} phrase(s) route to ${info.command || skill}.`,
    },
    trigger: {
      // Router-match on natural-language phrases is the pilot trigger; the
      // §3.1 event predicate form only exists for event-driven behaviors
      // (test-failure seed), which a phrase registry cannot express.
      event_type: 'user.invocation',
      predicate: {
        phrases: { any: info.phrases.sort() },
      },
    },
    policy: {
      mode: 'propose',
      max_concurrent: 1,
      cooldown: '24h',
    },
    capabilities: {
      tools: ['read', 'grep', 'glob'],
      mutation_classes: [],
    },
    execution: {
      graph: skill,
      // The command this behavior routes to is the only executable body the
      // registry actually knows about.
      invoke: info.command || null,
    },
    outcomes: [`${skill}.completed`],
    _provenance: {
      compiled_by: 'spike-behavior-yaml.js',
      registry_version: reg.version,
      source_skill_md: info.source,
    },
  };
  // Byte-stable: js-yaml dump with sorted keys off, explicit sort done above;
  // key order is insertion order, deterministic.
  return yaml.dump(doc, { lineWidth: 120, noRefs: true, sortKeys: false });
}

// --- 3. Emit twice, compare ---
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'spike-beh-'));
const emit = () => {
  const out = {};
  for (const [skill, info] of [...bySkill.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out[skill] = compile(skill, info);
  }
  return out;
};
const run1 = emit();
const run2 = emit();
let stable = true;
for (const [skill, body] of Object.entries(run1)) {
  const h1 = sha(body);
  const h2 = sha(run2[skill]);
  if (h1 !== h2) stable = false;
  fs.writeFileSync(path.join(tmp, `${skill}.behavior.yaml`), body);
  console.log(`${skill.padEnd(20)} ${h1} ${body.split('\n').length - 1}L ${stable && h1 === h2 ? 'STABLE' : 'UNSTABLE'}`);
}
console.log(`\nbehaviors compiled: ${Object.keys(run1).length}`);
console.log(`byte-stable across runs: ${stable ? 'YES' : 'NO'}`);

// --- 4. Schema-shape agreement with the hand-authored seed ---
const seedPath = path.join(ROOT, 'packages/core/behaviors/test-failure/behavior.yaml');
const seed = yaml.load(fs.readFileSync(seedPath, 'utf8'));
const first = yaml.load(Object.values(run1)[0]);
const seedKeys = new Set(Object.keys(seed));
const compiledKeys = new Set(Object.keys(first));
const shared = [...seedKeys].filter((k) => compiledKeys.has(k));
console.log(`\nseed top-level keys:     ${[...seedKeys].join(', ')}`);
console.log(`compiled top-level keys: ${[...compiledKeys].join(', ')}`);
console.log(`shared:                  ${shared.join(', ')} (${shared.length}/${seedKeys.size} of seed)`);

// trigger/predicate divergence is the spike's real finding:
console.log('\ntrigger.predicate seed:     ', JSON.stringify(Object.keys(seed.trigger.predicate)));
console.log('trigger.predicate compiled: ', JSON.stringify(Object.keys(first.trigger.predicate)));

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(stable && shared.length === seedKeys.size ? 0 : 1);
