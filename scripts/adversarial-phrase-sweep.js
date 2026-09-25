// br-ivv adversarial false-positive sweep over the compiled phrase registry.
// Feeds N prompt-templates x 43 phrases through the real router hook and logs
// which skills fired, plus a ground-truth intent label per template.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, "..");
const MIRROR_DIRS = new Set(["full", "pi"]);
const REG = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/router/lib/behavior-phrases.json"), "utf8"));
// phrase keys are normalized; recover skill->phrase ground truth from source SKILL.md only
const phrases = Object.keys(REG.phrases).sort();
const skillOf = {};
{
  const glob = require('glob');
  for (const f of glob.sync('packages/*/skills/*/SKILL.md', { cwd: ROOT })) {
    const pkg = f.split('/')[1];
    if (MIRROR_DIRS.has(pkg)) continue;
    const m = fs.readFileSync(path.join(ROOT, f), 'utf8').match(/^name:\s*(\S+)/m);
    if (!m) continue;
    const sk = m[1];
    const fm = fs.readFileSync(path.join(ROOT, f), 'utf8').match(/^phrases:\n((?:\s+- .*\n?)+)/m);
    if (!fm) continue;
    for (const line of fm[1].split('\n')) {
      const ph = line.replace(/^\s+-\s+/, '').trim().toLowerCase();
      if (ph) (skillOf[ph] ||= new Set()).add(sk);
    }
  }
}

// intent: true = a human would say the behavior applies; false = it must NOT fire.
const TEMPLATES = [
  ['negation_do_not', (p) => `do not ${p}`, false],
  ['negation_dont', (p) => `please don't ${p}`, false],
  ['negation_never', (p) => `never ${p} again`, false],
  ['already_done', (p) => `we already ${p} last sprint, nothing to do`, false],
  ['substring_trap', (p) => `${p}-free zone is the goal`, false],
  ['quoted_meta', (p) => `the phrase "${p}" appears in our docs`, false],
  ['question_what', (p) => `what does it mean to ${p}?`, false],
  ['question_why', (p) => `why would anyone ${p}?`, false],
  ['past_tense', (p) => `yesterday we ${p}`, false],
  ['compound_neg', (p) => `neither ${p} nor anything like it`, false],
  ['embedded_word', (p) => `the ${p} module is literally named "${p} thing" internally`, false],
  ['real_request', (p) => `can you help me ${p} for the billing service`, true],
];

function fired(prompt) {
  let out;
  try {
    out = execFileSync('node', [path.join(ROOT, 'packages/router/hooks/router.js')], {
      input: JSON.stringify({ prompt }), encoding: 'utf8', timeout: 5000,
    });
  } catch (e) { return { skills: [], err: String(e.message).slice(0, 80) }; }
  const ac = (JSON.parse(out).hookSpecificOutput || {}).additionalContext || '';
  const idx = ac.indexOf('Ensemble behaviors matching');
  const block = idx === 0 ? ac.slice(0, ac.indexOf('\n\n') > 0 ? ac.indexOf('\n\n') : ac.length) : '';
  const skills = [...block.matchAll(/→ skill ([a-z0-9-]+)/g)].map((m) => m[1]);
  return { skills: [...new Set(skills)].sort(), block: idx === 0 };
}

const rows = [];
for (const [kind, tmpl, intent] of TEMPLATES) {
  for (const ph of phrases) {
    const prompt = tmpl(ph);
    const r = fired(prompt);
    const expects = [...(skillOf[ph] || [])].sort();
    rows.push({ kind, intent, phrase: ph, prompt, fired: r.skills, expects, err: r.err || null });
  }
}
fs.writeFileSync('/tmp/ivv-raw.json', JSON.stringify(rows, null, 1));

// precision table per phrase
const byPhrase = {};
for (const r of rows) {
  byPhrase[r.phrase] ||= { fp: 0, fn: 0, neg: 0, pos: 0 };
  const expSet = new Set(r.expects);
  if (r.intent) { r.fired.length ? byPhrase[r.phrase].pos++ : byPhrase[r.phrase].fn++; }
  else {
    // any skill firing on a no-intent prompt counts as an FP for that phrase
    byPhrase[r.phrase].neg += r.fired.length ? 1 : 0;
  }
}
console.log('total', rows.length, 'rows; negative-fires:', rows.filter((r) => !r.intent && r.fired.length).length, 'positive-misses:', rows.filter((r) => r.intent && !r.fired.length).length);
console.log('errors:', rows.filter((r) => r.err).length);
