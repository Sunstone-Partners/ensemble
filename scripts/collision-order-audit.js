// br-rmw multi-skill collision ordering audit.
// Builds prompts containing phrases from >=2 distinct skills and asserts the
// phrase block lists every matching skill deterministically: deduped by skill,
// sorted by skill name, phrase-alphabetical within a skill (the router's
// documented matchPhrases contract).
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ROUTER = path.join(ROOT, 'packages', 'router', 'hooks', 'router.js');
const REG = require(path.join(ROOT, 'packages', 'router', 'lib', 'behavior-phrases.json'));
const bySkill = {};
for (const [ph, bs] of Object.entries(REG.phrases)) for (const b of bs) (bySkill[b.skill] ||= []).push(ph);
const skills = Object.keys(bySkill).sort();

function order(prompt) {
  const out = execFileSync('node', [ROUTER], {
    input: JSON.stringify({ prompt }), encoding: 'utf8', timeout: 5000,
  });
  const ac = JSON.parse(out).hookSpecificOutput.additionalContext;
  const idx = ac.indexOf('Ensemble behaviors matching');
  if (idx !== 0) return [];
  const block = ac.slice(0, ac.indexOf('\n\n') > 0 ? ac.indexOf('\n\n') : ac.length);
  return [...block.matchAll(/- "([^"]+)" → skill ([a-z0-9-]+)/g)].map((m) => ({ phrase: m[1], skill: m[2] }));
}

function expected(prompt) {
  // plan Step 4: one entry per skill (skill-name dedupe), longest phrase wins as the
  // label, sorted by skill name with stable prompt-position tie-break.
  const n = prompt.toLowerCase();
  const best = new Map();
  for (const s of skills) for (const p of bySkill[s]) {
    const pos = n.indexOf(p);
    if (pos === -1) continue;
    const cur = best.get(s);
    if (!cur || p.length > cur.phrase.length || (p.length === cur.phrase.length && pos < cur.pos)) best.set(s, { phrase: p, pos });
  }
  return [...best.entries()]
    .sort((x, y) => x[0].localeCompare(y[0]) || x[1].pos - y[1].pos)
    .map(([skill, m]) => ({ phrase: m.phrase, skill }));
}

function assertDeterministic(prompt) {
  const a = order(prompt);
  for (let i = 0; i < 4; i++) {
    const b = order(prompt);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      console.error(`NONDETERMINISTIC for "${prompt}"\n run1: ${JSON.stringify(a)}\n run2: ${JSON.stringify(b)}`);
      process.exitCode = 1;
      return a;
    }
  }
  const exp = expected(prompt);
  if (JSON.stringify(a) !== JSON.stringify(exp)) {
    console.error(`ORDER MISMATCH "${prompt.slice(0, 70)}"\n got: ${JSON.stringify(a)}\n exp: ${JSON.stringify(exp)}`);
    process.exitCode = 1;
  }
  return a;
}

const probes = [
  'I want to create a feature branch and create a PR for the billing work',
  'create a PRD and create a feature branch for the new service',
  'create a TRD then create a pull request from the feature branch',
  'merge the PR and land the PR and get this PR green',
  'refine the PRD then update the PRD with PRD feedback',
  'implement the TRD and build the TRD and execute the plan',
  'ship a feature and merge and clean up and handle merge conflicts',
  'create a PR for git-town and create a prd for the spec',
];

let total = 0, collisions = 0;
for (const p of probes) {
  const r = assertDeterministic(p);
  const sset = new Set(r.map((x) => x.skill));
  total++;
  if (sset.size > 1) collisions++;
  console.log(`[${sset.size > 1 ? 'COLLIDE' : 'single '} ${r.length} hits] ${p.slice(0, 72)}`);
}

let pairN = 0;
for (const a of skills) for (const b of skills.filter((x) => x > a)) {
  const pa = bySkill[a][0], pb = bySkill[b][0];
  for (const p of [`${pa} and ${pb}`, `${pb}, then ${pa}`]) {
    pairN++;
    const r = assertDeterministic(p);
    const names = [...new Set(r.map((x) => x.skill))];
    if (JSON.stringify(names) !== JSON.stringify([...names].sort())) {
      console.error(`UNSORTED for "${p}": ${names.join(',')}`);
      process.exitCode = 1;
    }
  }
}
console.log(`compound probes: ${total} (${collisions} multi-skill) | pair probes: ${pairN} | exit ${process.exitCode || 0}`);
