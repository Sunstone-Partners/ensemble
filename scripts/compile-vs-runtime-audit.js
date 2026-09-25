// br-ckm compile-vs-runtime failure-mode audit.
// For each failure family, record WHERE it is caught: compiler (generate-behaviors),
// router hook, observer hook, generation chain, or nowhere (finding).
// EVERY fixture runs against a temp tree — NEVER the live checkout.
// `node scripts/compile-vs-runtime-audit.js` -> table; exit 2 on findings.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = cp.execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const rows = [];
const rec = (name, layer, expect, got) => rows.push({ name, layer, expect, got, pass: expect === got });

function tmpTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-'));
  for (const [rel, content] of Object.entries(files)) {
    if (content === 'SENTINEL-NONEXISTENT') continue;
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

const gb = require(path.join(ROOT, 'scripts/generate-behaviors.js'));
async function compilerCase(name, files, want) {
  const dir = tmpTree(files);
  try {
    const res = await gb.run({ root: dir, dryRun: true, silent: true });
    const got = res.ok ? 'pass' : 'fail';
    rec(name, 'compiler', want, got === want ? want : `${got}; first error: ${(res.errors || [''])[0].slice(0, 90)}`);
  } catch (e) {
    rec(name, 'compiler', want, `crash: ${e.message.slice(0, 80)}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// source command YAMLs are named metadata.name == "ensemble:<cmd>"; refs are "/ensemble:<cmd>".
// command-set discovery goes through .claude-plugin/plugin.json -> commands dir.
const PLUGIN = (name) => JSON.stringify({ name, version: '0.0.0', commands: './commands' }) + '\n';
const cmdYaml = (name) => `metadata:\n  name: ${name}\n`;
const skillMd = (phrases, cmd, desc = 'Authoring a doc.') => `---
name: t-skill
description: ${desc}
version: 1.0.0
phrases:
${phrases.map((p) => `  - ${p}`).join('\n')}${cmd ? `\ncommand: ${cmd}` : ''}
---

## Mission
test fixture
`;
const XPKG = { 'packages/x/.claude-plugin/plugin.json': PLUGIN('p-x') };

function routerCase(name, registryContent, prompt, want) {
  const dir = tmpTree({ 'ph.json': registryContent });
  const p = registryContent === 'SENTINEL-NONEXISTENT' ? path.join(dir, 'missing.json') : path.join(dir, 'ph.json');
  const r = cp.spawnSync('node', [path.join(ROOT, 'packages/router/hooks/router.js')], {
    input: JSON.stringify({ prompt }), encoding: 'utf8', timeout: 10000, env: { ...process.env, ROUTER_PHRASES_PATH: p },
  });
  let block = false;
  try { block = JSON.parse(r.stdout).hookSpecificOutput.additionalContext.includes('Ensemble behaviors matching'); } catch { /* fallthrough */ }
  rec(name, 'router', want, `code=${r.status}${block ? '+block' : ''}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

function obsCase(name, input, env, want) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-obs-'));
  const r = cp.spawnSync('node', [path.join(ROOT, 'packages/core/hooks/test-failure-observer.js')], {
    input, encoding: 'utf8', timeout: 10000, cwd: dir, env: env ? { ...process.env, ...env } : process.env,
  });
  const wrote = fs.existsSync(path.join(dir, '.ensemble/learning-log.jsonl'));
  rec(name, 'observer', want, `code=${r.status}${wrote ? '+wrote' : ''}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  // compiler families (corrupt fixtures = regression guards)
  await compilerCase('description missing activation marker (self-healed)', { ...XPKG, 'packages/x/skills/t-skill/SKILL.md': skillMd(['do the thing'], null, "'Authoring a doc. Fresh tail here.'"), 'packages/x/commands/ensemble:c.yaml': cmdYaml('ensemble:c') }, 'pass');
  await compilerCase('phrase <3 chars', { ...XPKG, 'packages/x/skills/t-skill/SKILL.md': skillMd(['ab'], null), 'packages/x/commands/ensemble:c.yaml': cmdYaml('ensemble:c') }, 'fail');
  await compilerCase('quote inside phrase', { ...XPKG, 'packages/x/skills/t-skill/SKILL.md': skillMd(['say "hi" now'], null), 'packages/x/commands/ensemble:c.yaml': cmdYaml('ensemble:c') }, 'fail');
  await compilerCase('dangling command ref', { ...XPKG, 'packages/x/skills/t-skill/SKILL.md': skillMd(['do the thing'], '/ensemble:ghost'), 'packages/x/commands/ensemble:c.yaml': cmdYaml('ensemble:c') }, 'fail');
  await compilerCase('duplicate phrase+skill', { ...XPKG, 'packages/x/skills/t-skill/SKILL.md': skillMd(['do the thing', 'do the thing'], null), 'packages/x/commands/ensemble:c.yaml': cmdYaml('ensemble:c') }, 'fail');
  await compilerCase('no frontmatter skipped', { ...XPKG, 'packages/x/skills/t-skill/SKILL.md': '# doc\nno frontmatter\n', 'packages/x/commands/ensemble:c.yaml': cmdYaml('ensemble:c') }, 'pass');
  await compilerCase('zero phrases still emits', { ...XPKG, 'packages/x/skills/skill-a/SKILL.md': skillMd(['alpha phrase'], null), 'packages/x/commands/ensemble:c.yaml': cmdYaml('ensemble:c') }, 'pass');
  await compilerCase('command ref resolves to real YAML', { ...XPKG, 'packages/x/skills/t-skill/SKILL.md': skillMd(['do the thing'], '/ensemble:c'), 'packages/x/commands/ensemble:c.yaml': cmdYaml('ensemble:c') }, 'pass');

  // router runtime: corrupt/mismatched registries must exit 0, never block on garbage
  routerCase('malformed registry JSON', '{ this is not json', 'create a prd for billing', 'code=0');
  routerCase('registry file missing', 'SENTINEL-NONEXISTENT', 'create a prd for billing', 'code=0');
  routerCase('phrases wrong type', '{"phrases":[1,2,3]}', 'create a prd for billing', 'code=0');
  routerCase('binding missing skill', '{"phrases":{"create a prd":[{"command":"/ensemble:create-prd"}]}}', 'create a prd for billing', 'code=0+block');
  routerCase('command-less binding', '{"phrases":{"create a prd":[{"skill":"no-cmd-skill"}]}}', 'create a prd for billing', 'code=0+block');
  routerCase('empty phrases', '{"phrases":{}}', 'create a prd for billing', 'code=0');

  // observer runtime: every path exits 0; only failures write
  obsCase('empty stdin', '', undefined, 'code=0');
  obsCase('garbage stdin', 'not json', undefined, 'code=0');
  obsCase('non-object JSON', '"hello"', undefined, 'code=0');
  obsCase('no tool fields', '{"foo":1}', undefined, 'code=0');
  obsCase('failure payload', '{"tool_name":"Bash","tool_input":{"command":"pytest"},"tool_response":"2 failed"}', undefined, 'code=0+wrote');
  obsCase('disabled by env', '{"tool_name":"Bash","tool_input":{"command":"pytest"},"tool_response":"2 failed"}', { ENSEMBLE_BEHAVIORS_DISABLE: '1' }, 'code=0');

  // --- generation chain (mutating probe runs against a temp tree only) ---
  // non-dry run() resolves REPO_ROOT from its own __dirname = live repo, so the
// read-only sweep is done via dryRun and only the mutating probe uses root:.
const chain = cp.spawnSync('npm', ['run', '--silent', 'generate:behaviors'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  rec('chain: behaviors over real repo', 'chain', 'code=0', `code=${chain.status}`);

  // Description drift is re-synced by regeneration: syncDescription keeps the authored
  // prefix (text before ' Use when the user says:') and rebuilds the activation tail.
  const drift = tmpTree({
    ...XPKG,
    'packages/x/commands/ensemble:c.yaml': cmdYaml('ensemble:c'),
    'packages/x/skills/t-skill/SKILL.md': skillMd(['do the thing'], '/ensemble:c'),
  });
  const sp = path.join(drift, 'packages/x/skills/t-skill/SKILL.md');
  fs.writeFileSync(sp, fs.readFileSync(sp, 'utf8').replace(
    /^description: .*$/m, "description: 'Authoring a doc. Use when the user says: \"stale phrase\"'"));
  // The CLI hardcodes its scan root from __dirname, so the mutating probe must call the
  // exported run() with root: <tmpdir>; spawning the CLI would rewrite the live tree.
  const res2 = await gb.run({ root: drift, silent: true });
  const after = fs.readFileSync(sp, 'utf8');
  const healed = /Authoring a doc\./.test(after) && !/stale phrase/.test(after) && /"do the thing"/.test(after);
  const regPath = path.join(drift, 'packages/router/lib/behavior-phrases.json');
  const regOut = fs.existsSync(regPath) ? fs.readFileSync(regPath, 'utf8') : '';
  rec('chain: description drift re-synced', 'chain', `code=0+healed+registry-has-phrase`,
    `code=${res2.ok ? 0 : 1}+${healed ? 'healed' : 'stale'}+${/do the thing/.test(regOut) ? 'registry-has-phrase' : 'registry-missing'}`);
  fs.rmSync(drift, { recursive: true, force: true });

  const byLayer = {};
  for (const r of rows) (byLayer[r.layer] ||= []).push(r);
  console.log('\n=== compile-vs-runtime failure-mode audit ===\n');
  for (const [layer, rs] of Object.entries(byLayer)) {
    console.log(`## ${layer} (${rs.filter((x) => x.pass).length}/${rs.length} as-expected)`);
    for (const r of rs) console.log(`  ${r.pass ? 'PASS   ' : 'FINDING'}  ${r.name}  expect[${r.expect}] got[${r.got}]`);
    console.log('');
  }
  const findings = rows.filter((r) => !r.pass);
  console.log(`${rows.length} families, ${findings.length} findings`);
  process.exit(findings.length ? 2 : 0);
})();
