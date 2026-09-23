// Phase-1 functional matrix, runtime-agnostic core (br-fnf/br-zp8/br-c6d shared).
// Every layer checks the RUNTIME's actual entry surfaces, not the repo source:
// registry <-> source SKILL.md <-> that runtime's installed mirror <-> that
// runtime's slash-command surface <-> router/observer hook wiring.
// Usage: node scripts/functional-matrix-core.js [claude|pi|opencode]
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = cp.execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const runtime = (process.argv[2] || 'pi').toLowerCase();
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/router/lib/behavior-phrases.json'), 'utf8'));

// per-skill phrase ground truth from source SKILL.md (excludes mirrors)
const srcSkills = {};
for (const f of cp.execSync(`cd ${JSON.stringify(ROOT)} && git ls-files 'packages/*/skills/*/SKILL.md'`, { encoding: 'utf8' }).trim().split('\n')) {
  const pkg = f.split('/')[1];
  if (pkg === 'full' || pkg === 'pi') continue;
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const name = (src.match(/^name:\s*['"]?(\S+?)['"]?\s*$/m) || [])[1];
  const phBlock = src.match(/^phrases:\n((?:\s+- .*\n?)+)/m);
  const cmd = (src.match(/^command:\s*['"]?([^\s'"]+)/m) || [])[1];
  if (name && phBlock) {
    const clean = (l) => l.replace(/^\s+-\s+/, '').trim().replace(/^['"]|['"]$/g, '').toLowerCase();
    srcSkills[name] = { phrases: phBlock[1].split('\n').map(clean).filter(Boolean), command: cmd || null };
  }
}

const results = [];
function check(layer, name, pass, detail) {
  results.push({ layer, name, pass: !!pass, detail: detail || '' });
}

// --- Layer 1: registry <-> source descriptions ---
for (const [skill, info] of Object.entries(srcSkills)) {
  const inReg = Object.entries(reg.phrases).filter(([, bs]) => bs.some((b) => b.skill === skill)).map(([p]) => p).sort();
  check('registry', `${skill}: phrases match source`, JSON.stringify(inReg) === JSON.stringify([...info.phrases].sort()),
    inReg.length !== info.phrases.length ? `reg:${inReg.length} src:${info.phrases.length}` : '');
}
// locate source files properly (the loop above knows pkg via git path — redo cleanly)
for (const f of cp.execSync(`cd ${JSON.stringify(ROOT)} && git ls-files 'packages/*/skills/*/SKILL.md'`, { encoding: 'utf8' }).trim().split('\n')) {
  const pkg = f.split('/')[1];
  if (pkg === 'full' || pkg === 'pi') continue;
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const name = (src.match(/^name:\s*['"]?(\S+?)['"]?\s*$/m) || [])[1];
  if (!srcSkills[name]) continue;
  const m = src.match(/^description:\s*(.*)$/m);
  check('descriptions', `${name}: activation sentence synced`, m && m[1].includes('Use when the user says'), m ? '' : 'no description line');
}

// --- Layer 2: router runtime ---
for (const [phrase, bindings] of Object.entries(reg.phrases)) {
  for (const b of bindings) {
    const out = cp.spawnSync('node', [path.join(ROOT, 'packages/router/hooks/router.js')], { input: JSON.stringify({ prompt: `please ${phrase} for the payments module` }), encoding: 'utf8', timeout: 8000 });
    let ac = '';
    try { ac = JSON.parse(out.stdout).hookSpecificOutput.additionalContext; } catch { /* fallthrough */ }
    const ok = ac.includes('Ensemble behaviors matching') && ac.includes(`→ skill ${b.skill}`);
    check('router', `phrase "${phrase}" surfaces ${b.skill}`, ok);
    if (b.command) check('router', `phrase "${phrase}" run-hint ${b.command}`, ac.includes(`run ${b.command}`));
    if (out.status !== 0) check('router', `exit 0 on "${phrase}"`, false, `exit=${out.status}`);
  }
}
check('router', 'no-match exit 0 clean', (() => {
  const out = cp.spawnSync('node', [path.join(ROOT, 'packages/router/hooks/router.js')], { input: JSON.stringify({ prompt: 'what time is it' }), encoding: 'utf8', timeout: 8000 });
  return out.status === 0 && !JSON.parse(out.stdout).hookSpecificOutput.additionalContext.includes('Ensemble behaviors matching');
})());

// --- Layer 3: observer runtime (repo-level behavior of the shipped hook) ---
const tmp = fs.mkdtempSync('/tmp/fm-obs-');
function obs(payload) {
  return cp.spawnSync('node', [path.join(ROOT, 'packages/core/hooks/test-failure-observer.js')], { input: JSON.stringify(payload), cwd: tmp, encoding: 'utf8', timeout: 8000 });
}
obs({ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: '3 failing, 10 passing', session_id: 's1' });
const logFile = path.join(tmp, '.ensemble/learning-log.jsonl');
check('observer', 'failure appends exactly 1 row', fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').trim().split('\n').length === 1);
obs({ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'Tests: 13 passed', session_id: 's1' });
check('observer', 'pass appends nothing', fs.readFileSync(logFile, 'utf8').trim().split('\n').length === 1);
obs({ tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_response: 'FAILED', session_id: 's1' });
check('observer', 'non-test command ignored', fs.readFileSync(logFile, 'utf8').trim().split('\n').length === 1);
obs({ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: '3 failing, 10 passing', session_id: 's1' });
check('observer', 'dedupes identical retry', fs.readFileSync(logFile, 'utf8').trim().split('\n').length === 1);
check('observer', 'context mentions PATTERN/ONE-OFF', (() => {
  const o = obs({ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'FAIL: expected 1 got 2\nAssertionError', session_id: 's2' });
  const j = JSON.parse(o.stdout || '{}');
  const ac2 = (j.hookSpecificOutput || {}).additionalContext || '';
  return /PATTERN/.test(ac2) && /ONE-OFF/.test(ac2);
})());
check('observer', 'bad stdin exit 0', obs('not json').status === 0);
check('observer', 'DISABLE env no-op', (() => {
  fs.rmSync(logFile, { force: true });
  const o = cp.spawnSync('node', [path.join(ROOT, 'packages/core/hooks/test-failure-observer.js')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pytest' }, tool_response: '1 failed', session_id: 's3' }), cwd: tmp, encoding: 'utf8', timeout: 8000, env: { ...process.env, ENSEMBLE_BEHAVIORS_DISABLE: '1' } });
  return o.status === 0 && !fs.existsSync(logFile);
})());
fs.rmSync(tmp, { recursive: true, force: true });

// --- Layer 4: runtime surfaces (installed mirrors + prompts/commands + hooks) ---
if (runtime === 'pi') {
  const piRoot = path.join(ROOT, 'packages/pi');
  const promptStems = fs.readdirSync(path.join(piRoot, 'prompts')).filter((f) => f.startsWith('ensemble-') && f.endsWith('.md')).map((f) => f.slice(0, -3));
  check('pi-surface', 'commands generated (prompts/ensemble-*.md)', promptStems.length > 40, `${promptStems.length} prompts`);
  for (const [skill, info] of Object.entries(srcSkills)) {
    const mirror = path.join(piRoot, 'skills', skill, 'SKILL.md');
    if (!fs.existsSync(mirror)) { check('pi-surface', `${skill}: mirrored into pi package`, false, 'MISSING'); continue; }
    const src = fs.readFileSync(mirror, 'utf8');
    check('pi-surface', `${skill}: mirrored`, true);
    check('pi-surface', `${skill}: descriptions synced`, src.includes('Use when the user says'));
    if (info.command) {
      const stem = info.command.slice(1).replace(/^ensemble:/, 'ensemble-');
      check('pi-surface', `${skill}: pi command /${stem} resolvable`, promptStems.includes(stem), 'no such prompt stem');
      check('pi-surface', `${skill}: mirror command field`, (src.match(/^command:\s*['"]?([^\s'"]+)/m) || [])[1] === `/${stem}`, `got ${(src.match(/^command:\s*['"]?([^\s'"]+)/m) || [])[1]}`);
    }
    // activation semantics: every phrase must appear in the synced description.
    // Handles both quoted single-line and YAML folded (>- / |) scalars.
    let desc = (src.match(/^description:\s*(.*)$/m) || [])[1] || '';
    if (/^\s*[|>][-+]?\s*$/.test(desc)) {
      desc = (src.match(/^description:\s*[|>][-+]?\n((?:[ \t]+\S.*\n?)+)/m) || ['', ''])[1]
        .split('\n').map((l) => l.trim()).join(' ');
    }
    const norm = (s) => s.toLowerCase().replace(/[\s"]+/g, ' ').trim();
    const d = norm(desc);
    const all = info.phrases.every((p) => d.includes(norm(p)));
    check('pi-surface', `${skill}: description lists all phrases`, all, all ? '' : `desc: ${desc.slice(0, 70)}`);
  }
  check('pi-surface', 'pi package ships no hooks dir', !fs.existsSync(path.join(piRoot, 'hooks')), 'D2: phrase hints + observer NOT wired for pi sessions');
  const home = path.join(process.env.HOME, '.pi/agent/skills');
  if (fs.existsSync(home)) {
    let stale = 0;
    for (const skill of Object.keys(srcSkills)) {
      const h = path.join(home, skill, 'SKILL.md');
      if (!fs.existsSync(h)) { stale++; continue; }
      if (!fs.readFileSync(h, 'utf8').includes('Use when the user says')) stale++;
    }
    check('pi-surface', `~/.pi/agent/skills copies current (${stale} stale of ${Object.keys(srcSkills).length})`, stale === 0, 'informational: pi loads live package path, not this cache');
  }
}
if (runtime === 'claude') {
  const pluginRoot = path.join(ROOT, 'packages/full');
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks/hooks.json'), 'utf8'));
  const flat = JSON.stringify(hooks);
  check('claude-surface', 'router hook registered', flat.includes('router.js'));
  check('claude-surface', 'observer hook registered', flat.includes('test-failure-observer.js'));
  const cmdFiles = cp.execSync(`cd ${JSON.stringify(ROOT)} && git ls-files 'packages/*/commands/**/*.md' 'packages/*/commands/*.md'`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const stems = cmdFiles.filter((f) => !f.includes('/full/')).map((f) => path.basename(f, '.md'));
  check('claude-surface', 'slash commands present', stems.length > 40, `${stems.length}`);
  for (const b of Object.values(reg.phrases).flat()) {
    if (!b.command) continue;
    const stem = b.command.replace(/^\/ensemble:/, '');
    check('claude-surface', `${b.skill}: /ensemble:${stem} exists`, stems.includes(stem), `got ${stem} in ${stems.length} cmds`);
  }
  for (const skill of Object.keys(srcSkills)) {
    const link = path.join(pluginRoot, 'skills', skill);
    const ok = fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink() && fs.existsSync(path.join(link, 'SKILL.md'));
    check('claude-surface', `${skill}: reachable from full mirror`, ok, ok ? '' : 'missing/broken symlink');
  }
}
if (runtime === 'opencode') {
  const dist = path.join(ROOT, 'dist/opencode');
  const has = fs.existsSync(dist);
  check('opencode-surface', 'generated output present (run generate:opencode first)', has);
  if (has) {
    const cmds = cp.execSync(`cd ${JSON.stringify(dist)} && find . -name "*.md" -path "*command*" | head -80`, { encoding: 'utf8' });
    check('opencode-surface', 'commands emitted', cmds.trim().length > 0, `${cmds.trim().split('\n').length} files`);
  }
  const hb = path.join(ROOT, 'packages/opencode/src/hooks/bridge.js');
  check('opencode-surface', 'bridge discovers hooks.json', fs.readFileSync(hb, 'utf8').includes('hooks.json'));
}

// --- report ---
const fails = results.filter((r) => !r.pass);
const byLayer = {};
for (const r of results) (byLayer[r.layer] ||= { pass: 0, fail: 0 }); for (const l of Object.keys(byLayer)) byLayer[l] = { pass: 0, fail: 0 };
for (const r of results) byLayer[r.layer][r.pass ? 'pass' : 'fail']++;
console.log(`\n=== functional-matrix-core [${runtime}] ===`);
for (const [l, c] of Object.entries(byLayer)) console.log(`  ${l}: ${c.pass} pass, ${c.fail} fail`);
if (fails.length) { console.log('\nFAILURES:'); for (const f of fails) console.log(`  ✗ ${f.layer} | ${f.name} ${f.detail ? '| ' + f.detail : ''}`); }
console.log(`\ntotal ${results.length} checks, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
