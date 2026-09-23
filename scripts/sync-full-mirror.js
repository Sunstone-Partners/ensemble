#!/usr/bin/env node
// Maintain the packages/full skills mirror: every behavior skill (SKILL.md with
// a `phrases:` frontmatter block) must be reachable from packages/full/skills/
// via a relative symlink, matching the existing mirror convention.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = cp.execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const MIRROR = path.join(ROOT, 'packages/full/skills');

const behaviorSkills = [];
for (const f of cp.execSync(`cd ${JSON.stringify(ROOT)} && git ls-files 'packages/*/skills/*/SKILL.md'`, { encoding: 'utf8' })
  .trim().split('\n')) {
  const pkg = f.split('/')[1];
  if (pkg === 'full' || pkg === 'pi') continue;
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (!/^phrases:/m.test(src)) continue;
  behaviorSkills.push({ file: f, dir: path.dirname(f), name: path.basename(path.dirname(f)) });
}

let added = 0;
for (const { dir, name } of behaviorSkills) {
  const link = path.join(MIRROR, name);
  if (fs.existsSync(link)) continue;
  const rel = path.relative(path.dirname(link), path.join(ROOT, dir));
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(rel, link);
  console.log(`linked ${path.relative(ROOT, link)} -> ${rel}`);
  added++;
}
if (!added) console.log(`full mirror complete: ${behaviorSkills.length} behavior skills reachable`);
else {
  // verify every behavior is now reachable
  const missing = behaviorSkills.filter((b) => !fs.existsSync(path.join(MIRROR, b.name, 'SKILL.md')));
  if (missing.length) { console.error('STILL MISSING:', missing.map((m) => m.name).join(', ')); process.exit(1); }
  console.log(`added ${added} link(s); all ${behaviorSkills.length} behavior skills reachable`);
}
