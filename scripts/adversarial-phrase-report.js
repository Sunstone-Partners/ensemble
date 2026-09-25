// Precision report over /tmp/ivv-raw.json produced by scripts/adversarial-phrase-sweep.js.
'use strict';
const rows = require('/tmp/ivv-raw.json');

const byPhrase = {};
for (const r of rows) {
  const rec = (byPhrase[r.phrase] ||= { neg: 0, negFire: 0, pos: 0, posFire: 0, extraHits: 0, kinds: {} });
  const exp = new Set(r.expects);
  const extra = r.fired.filter((s) => !exp.has(s)).length;
  if (r.intent) { rec.pos++; if (r.fired.length) rec.posFire++; rec.extraHits += extra; }
  else { rec.neg++; if (r.fired.length) rec.negFire++; rec.extraHits += extra; if (r.fired.length) (rec.kinds[r.kind] ||= 0) && rec.kinds[r.kind]++; if (rec.kinds[r.kind]===undefined) rec.kinds[r.kind]=1; }
}
// recompute kinds cleanly
for (const ph of Object.keys(byPhrase)) byPhrase[ph].kinds = {};
for (const r of rows) if (!r.intent && r.fired.length) byPhrase[r.phrase].kinds[r.kind] = (byPhrase[r.phrase].kinds[r.kind] || 0) + 1;

const lines = [];
lines.push('| phrase | neg prompts | neg firings | pos firings | extra-skill hits | firing templates (all negative-intent) |');
lines.push('|---|---|---|---|---|---|');
let totExtra = 0;
for (const [ph, r] of Object.entries(byPhrase).sort()) {
  totExtra += r.extraHits;
  lines.push(`| \`${ph}\` | ${r.neg} | ${r.negFire}/${r.neg} | ${r.posFire}/${r.pos} | ${r.extraHits} | ${Object.keys(r.kinds).length}/11 |`);
}
lines.push('');
lines.push(`**Extra-skill (cross-phrase) firings total: ${totExtra}**`);

// ambiguous phrase pairs: phrase A whose templates trigger skill B (not B's own phrase)
const cross = [];
for (const r of rows) {
  const exp = new Set(r.expects);
  for (const s of r.fired) if (!exp.has(s)) {
    // which of B's phrases matched this prompt?
    const REG = require('/Users/ldangelo/Development/Sunstone/ensemble/packages/router/lib/behavior-phrases.json');
    const bph = Object.entries(REG.phrases).filter(([, bs]) => bs.some((b) => b.skill === s)).map(([p]) => p);
    const hit = bph.find((p) => r.prompt.toLowerCase().includes(p));
    cross.push({ inPhrase: r.phrase, template: r.kind, skill: s, viaPhrase: hit, prompt: r.prompt });
  }
}
const uniq = {};
for (const c of cross) { const k = `${c.skill} via "${c.viaPhrase}" inside "${c.inPhrase}"`; (uniq[k] ||= { n: 0, templates: new Set(), ex: c }); uniq[k].n++; uniq[k].templates.add(c.template); }
lines.push('');
lines.push('## Cross-phrase collision table (skill fires for a phrase it does not own)');
lines.push('');
lines.push('| skill fired | via its phrase | inside probe phrase | probes | templates | example prompt |');
lines.push('|---|---|---|---|---|---|');
for (const [k, v] of Object.entries(uniq).sort((a, b) => b[1].n - a[1].n)) {
  lines.push(`| ${v.ex.skill} | \`${v.ex.viaPhrase}\` | \`${v.ex.inPhrase}\` | ${v.n} | ${[...v.templates].join(', ')} | ${v.ex.prompt.slice(0, 70)} |`);
}
require('fs').writeFileSync('/tmp/ivv-report.md', lines.join('\n') + '\n');
console.log(lines.slice(0, 6).join('\n'));
console.log('report at /tmp/ivv-report.md, rows:', rows.length, 'cross-firings:', cross.length);
