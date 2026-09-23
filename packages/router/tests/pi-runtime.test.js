// Runtime-translation contract for the compiled phrase registry.
//
// router.js emits its `→ run` hints verbatim from behavior-phrases.json, which
// is authored in the Claude-canonical colon form (`/ensemble:<cmd>`). Pi's
// transformer rewrites `ensemble:<cmd>` → `ensemble-<cmd>` across generated
// skill copies because pi registers prompts by filename stem and ':' is illegal
// in Windows filenames — so in a pi runtime the runnable slash command is
// `/ensemble-<cmd>`. This suite pins the contract from both sides so neither
// the registry nor the transformer can silently diverge from what users type.
const fs = require('fs');
const path = require('path');

const REGISTRY = path.join(__dirname, '..', 'lib', 'behavior-phrases.json');
const PI_ROOT = path.join(__dirname, '..', '..', 'pi');

function loadRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
}

function collectCommands(registry) {
  const commands = new Set();
  for (const bindings of Object.values(registry.phrases)) {
    for (const b of bindings) if (b.command) commands.add(b.command);
  }
  return [...commands].sort();
}

function piPromptExists(command) {
  const stem = command.replace(/^\//, '').replace(/^ensemble:/, 'ensemble-');
  return fs.existsSync(path.join(PI_ROOT, 'prompts', `${stem}.md`));
}

describe('behavior registry runtime-translation contract', () => {
  const registry = loadRegistry();
  const commands = collectCommands(registry);

  it('registry commands are all in Claude-canonical /ensemble:<cmd> form', () => {
    for (const c of commands) {
      expect(c).toMatch(/^\/ensemble:[a-z0-9-]+$/);
    }
  });

  it('every registry command resolves to a generated pi prompt (colon → hyphen)', () => {
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) {
      expect(piPromptExists(c)).toBe(true);
    }
  });

  it('pi skill mirrors translate command refs: no colon form survives generation', () => {
    const skillsDir = path.join(PI_ROOT, 'skills');
    if (!fs.existsSync(skillsDir)) return; // pi package not built in this checkout
    const offenders = [];
    for (const dir of fs.readdirSync(skillsDir)) {
      const skillFile = path.join(skillsDir, dir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const content = fs.readFileSync(skillFile, 'utf8');
      // Body/prose refs must be translated; a `command:` field in colon form
      // means the pi transformer regressed (it is the mirror's runtime truth).
      const m = content.match(/^command:\s*['"]?([^\s'"]+)/m);
      if (m && m[1].includes('ensemble:')) offenders.push(`${dir}: ${m[1]}`);
      if (/[^-]ensemble:[a-z]/.test(content.replace(/^command:.*$/m, ''))) {
        offenders.push(`${dir}: untranslated prose ref`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('pi prompt files for bound commands exist as prompts/ensemble-<cmd>.md', () => {
    const promptsDir = path.join(PI_ROOT, 'prompts');
    if (!fs.existsSync(promptsDir)) return;
    for (const c of commands) {
      const stem = c.slice(1).replace(/^ensemble:/, 'ensemble-');
      expect(fs.existsSync(path.join(promptsDir, `${stem}.md`))).toBe(true);
    }
  });
});
