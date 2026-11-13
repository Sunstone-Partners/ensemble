'use strict';

/**
 * PR 4 behavior: the Pi adapter (TRD-013) and runtime selection (TRD-013-TEST). A stub `pi` and a stub `claude`
 * stand in for the two runtimes; each records its argv, its cwd content and whether it saw OPENAI_API_KEY.
 * Event shapes follow docs/guides/skills-eval.md ("Pi runtime").
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const pi = require('../lib/runners/pi');
const { getRunner, supportedRuntimes } = require('../lib/runners');
const arms = require('../lib/arms');
const { commandsFromLine } = require('../lib/exec');
const envlib = require('../lib/env');
const { findSkillPackages } = require('../lib/eval-def');

const RUN = path.join(__dirname, '../run.js');
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRATCH = path.join(os.homedir(), '.omp', 'trd-skills-eval', 'jest');
const SKILL = 'ensemble-create-prd';
const PKG = findSkillPackages(SKILL)[0];
const SKILL_DIR = path.join(REPO_ROOT, 'packages', PKG, 'skills', SKILL);

let root;
beforeEach(() => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  root = fs.mkdtempSync(path.join(SCRATCH, 'pi-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const sub = (...p) => path.join(root, ...p);

// ---- Pi event lines -------------------------------------------------------------------------------------------
const skillsSection = (names) => `<skills>\nThe following skills provide specialized instructions.\n\n<available_skills>\n${names.map((n) => `  <skill>\n    <name>${n}</name>\n    <description>d</description>\n    <location>/x/${n}/SKILL.md</location>\n  </skill>`).join('\n')}\n</available_skills>\n</skills>`;
/** The system message event; `names` null: no skills section at all (what --no-skills produces). */
const systemEvent = (type, names) => JSON.stringify({ type, message: { role: 'system', content: '', sections: { preamble: 'p', tools: 't', ...(names && { skills: skillsSection(names) }), cwd: '/w' } } });
/** A non-JSON-parseable agent_end line that still carries the system prompt (the real one is cut like this). */
const brokenAgentEnd = (names) => `{"type":"agent_end","messages":[{"role":"system","content":"","sections":{"skills":${JSON.stringify(names ? skillsSection(names) : '')},"cwd":"/w"}},{"role":"user","content":[{"type":"text","text":"hi"}]}, undefined,`;
const assistantEnd = (total, content = [{ type: 'text', text: 'ok' }]) => JSON.stringify({ type: 'message_end', message: { role: 'assistant', content, usage: { input: 1, output: 1, cost: total === undefined ? undefined : { total } } } });
const turnEnd = () => '{"type":"turn_end","message":{"role":"assistant"}}';
const session = '{"type":"session","version":3}';
const withStream = (names, total = 0.01) => [session, systemEvent('message_start', names), systemEvent('message_end', names), assistantEnd(total), turnEnd(), brokenAgentEnd(names)];
const baseStream = (names = null, total = 0.01) => withStream(names, total);

const shq = (l) => `'${l.replace(/'/g, "'\\''")}'`;
const printLines = (lines) => (lines.length ? `printf '%s\\n' ${lines.map(shq).join(' ')}` : ':');

/** Install stub `pi` and `claude` in root/bin. Both record argv/arm/env per call under root/rec/<runtime>. */
function stubs({ piWith, piBase, claudeLines, piWithExit = 0, piBaseExit = 0, passWith = true, passBase = false }) {
  const bin = sub('bin');
  fs.mkdirSync(bin, { recursive: true });
  const rec = sub('rec');
  fs.mkdirSync(rec, { recursive: true });
  const common = (name) => `mkdir -p "${rec}"
R=$(mktemp -d "${rec}/${name}-XXXXXX")
printf '%s\\n' "$@" > "$R/argv"
echo "\${OPENAI_API_KEY:-unset}" > "$R/oa"
`;
  fs.writeFileSync(path.join(bin, 'pi'), `#!/bin/sh
${common('pi')}case "$*" in *--skill*) ARM=with;; *) ARM=base;; esac
echo $ARM > "$R/arm"
if [ $ARM = with ]; then
  ${passWith ? 'echo ok > SUMMARY.md' : ':'}
  ${printLines(piWith || [])}
  exit ${piWithExit}
else
  ${passBase ? 'echo ok > SUMMARY.md' : ':'}
  ${printLines(piBase || [])}
  exit ${piBaseExit}
fi
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
${common('claude')}case "$*" in *--plugin-dir*) echo with > "$R/arm"; echo ok > SUMMARY.md;; *) echo base > "$R/arm";; esac
${printLines(claudeLines || [JSON.stringify({ type: 'system', subtype: 'init', skills: [], plugins: [] }), JSON.stringify({ type: 'result', num_turns: 1, total_cost_usd: 0.02 })])}
`, { mode: 0o755 });
  return { bin, rec };
}

/** Recorded calls of one runtime ('pi' | 'claude'). */
function calls(runtime) {
  const rec = sub('rec');
  if (!fs.existsSync(rec)) return [];
  return fs.readdirSync(rec).filter((d) => d.startsWith(`${runtime}-`)).sort().map((d) => {
    const r = (f) => fs.readFileSync(path.join(rec, d, f), 'utf8');
    return { argv: r('argv').split('\n').slice(0, -1), arm: r('arm').trim(), openai: r('oa').trim() };
  });
}

function runEvals(def, s, args = [], env = {}) {
  const skillsDir = sub('skills');
  const dir = path.join(skillsDir, SKILL);
  fs.mkdirSync(path.join(dir, 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fixture', 'seed.txt'), 'seed\n');
  fs.writeFileSync(path.join(dir, 'eval.json'), JSON.stringify({
    skill: SKILL, prompt: 'Write a summary of the repo', runtimes: ['claude', 'pi'], checks: [{ type: 'fileExists', path: 'SUMMARY.md' }], ...def,
  }));
  fs.mkdirSync(sub('scenarios'), { recursive: true });
  const base = {
    ...process.env, CI: 'false', GITHUB_ACTIONS: 'false', PATH: `${s.bin}:${process.env.PATH}`, EVALS_WORKDIR: sub('work'),
    EVALS_RESULTS_DIR: sub('results'), EVALS_SCENARIOS_DIR: sub('scenarios'), EVALS_SKILLS_DIR: skillsDir,
    EVALS_PI_BIN: path.join(s.bin, 'pi'), EVALS_CLAUDE_BIN: path.join(s.bin, 'claude'), ...env,
  };
  const r = spawnSync('node', [RUN, '--skill', SKILL, '--concurrency', '1', ...args], { encoding: 'utf8', env: base });
  const rf = fs.existsSync(sub('results')) ? fs.readdirSync(sub('results'))[0] : null;
  const report = rf ? JSON.parse(fs.readFileSync(sub('results', rf), 'utf8')) : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, report, ev: report && report.results[0] };
}

const piOk = () => stubs({ piWith: withStream([SKILL]), piBase: baseStream(null) });

describe('TRD-013-TEST both runtimes evaluated, runtime recorded', () => {
  test('claude and pi each evaluate the pilot eval; every result records its runtime; Pi arms use --no-skills --skill and --no-skills', () => {
    const s = piOk();
    const c = runEvals({}, s, ['--runtime', 'claude', '--repeats', '1']);
    expect(calls('pi')).toHaveLength(0);
    expect(calls('claude')).toHaveLength(2);
    expect(c.report.runtime).toBe('claude');
    expect(c.ev.runtime).toBe('claude');
    expect(c.ev.runs.map((r) => r.runtime)).toEqual(['claude', 'claude']);
    expect(c.ev.upliftLabel).toBe('package-level (skills share a package)');
    fs.rmSync(sub('rec'), { recursive: true, force: true });
    fs.rmSync(sub('results'), { recursive: true, force: true });

    const p = runEvals({}, s, ['--runtime', 'pi', '--repeats', '1', '--model', 'litellm-stack/smart_router']);
    expect(p.status).toBe(0);
    expect(calls('claude')).toHaveLength(0);
    const [w, b] = ['with', 'base'].map((a) => calls('pi').find((x) => x.arm === a));
    const flags = (argv) => argv.filter((a) => a.startsWith('--'));
    expect(w.argv.slice(w.argv.indexOf('--no-skills'), w.argv.indexOf('--no-skills') + 3)).toEqual(['--no-skills', '--skill', SKILL_DIR]);
    expect(w.argv.filter((a) => a === '--skill')).toHaveLength(1);
    expect(b.argv).toContain('--no-skills');
    expect(b.argv).not.toContain('--skill');
    for (const x of [w, b]) {
      expect(flags(x.argv)).toEqual(expect.arrayContaining(['--print', '--no-session', '--no-context-files', '--no-extensions', '--no-mcp', '--offline']));
      expect(x.argv[x.argv.indexOf('--model') + 1]).toBe('litellm-stack/smart_router');
      expect(x.argv[x.argv.length - 1]).toBe('Write a summary of the repo'); // prompt positional, last
    }
    expect(p.report.runtime).toBe('pi');
    expect(p.ev).toMatchObject({ runtime: 'pi', outcome: expect.any(String), upliftLabel: 'skill-level' });
    expect(p.ev.runs.map((r) => r.runtime)).toEqual(['pi', 'pi']);
    expect(p.ev.runs.every((r) => r.arm === 'with-skill' || r.arm === 'baseline')).toBe(true);
    expect(p.ev.withSkill.passes).toBe(1);
    expect(p.ev.baseline.passes).toBe(0);
    expect(p.ev.runs.find((r) => r.arm === 'with-skill').loadedSkills).toEqual([SKILL]);
    expect(p.ev.runs.find((r) => r.arm === 'baseline').loadedSkills).toEqual([]);
  });

  test('an unsupported runtime is rejected before anything runs (no process, no results)', () => {
    const s = piOk();
    const r = runEvals({}, s, ['--runtime', 'codex']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unsupported --runtime "codex": not supported in this release/);
    expect(calls('pi')).toHaveLength(0);
    expect(calls('claude')).toHaveLength(0);
    expect(r.report).toBeNull();
    expect(supportedRuntimes().sort()).toEqual(['claude', 'pi']);
    expect(() => getRunner('codex')).toThrow(/unsupported runtime "codex"/);
  });

  test('`runtimes` acts: an eval that does not list the runtime is skipped under it, with no warning', () => {
    const s = piOk();
    const r = runEvals({ runtimes: ['claude'] }, s, ['--runtime', 'pi', '--repeats', '1']);
    expect(r.stderr).toMatch(/SKIP ensemble-create-prd: not run under --runtime pi/);
    expect(r.stderr).not.toMatch(/accepted but not yet acted on/);
    expect(calls('pi')).toHaveLength(0);
    fs.rmSync(sub('results'), { recursive: true, force: true });
    // and the default runtime still runs it
    const c = runEvals({ runtimes: ['claude'] }, s, ['--repeats', '1']);
    expect(calls('claude')).toHaveLength(2);
    expect(c.ev.runtime).toBe('claude');
  });

  test('explicit invocation on Pi prefixes /skill:<name> on the with-skill arm only', () => {
    const s = piOk();
    runEvals({ invocation: 'explicit', command: '/ensemble:create-prd' }, s, ['--runtime', 'pi', '--repeats', '1']);
    const prompt = (arm) => { const c = calls('pi').find((x) => x.arm === arm); return c.argv[c.argv.length - 1]; };
    expect(prompt('with')).toBe(`/skill:${SKILL} Write a summary of the repo`);
    expect(prompt('base')).toBe('Write a summary of the repo');
  });

  test('Pi provider credentials (from env-allowlist.json) reach Pi runs only, never Claude runs', () => {
    const s = piOk();
    const env = { OPENAI_API_KEY: 'sk-openai-testvalue-123' };
    const p = runEvals({}, s, ['--runtime', 'pi', '--repeats', '1'], env);
    expect(calls('pi').every((c) => c.openai === 'sk-openai-testvalue-123')).toBe(true);
    expect(p.report.env.allowlisted).toContain('OPENAI_API_KEY');
    expect(JSON.stringify(p.report)).not.toContain('sk-openai-testvalue-123');
    fs.rmSync(sub('rec'), { recursive: true, force: true });
    fs.rmSync(sub('results'), { recursive: true, force: true });
    const c = runEvals({}, s, ['--runtime', 'claude', '--repeats', '1'], env);
    expect(calls('claude').every((x) => x.openai === 'unset')).toBe(true);
    expect(c.report.env.allowlisted).not.toContain('OPENAI_API_KEY');
  });
});

describe('TRD-013 Pi cost accounting', () => {
  test('cost is the sum of usage.cost.total over assistant messages', () => {
    const s = stubs({ piWith: [session, systemEvent('message_end', [SKILL]), assistantEnd(0.01), assistantEnd(0.02), turnEnd()], piBase: baseStream(null, 0.05) });
    const r = runEvals({}, s, ['--runtime', 'pi', '--repeats', '1']);
    const byArm = (a) => r.ev.runs.find((x) => x.arm === a);
    expect(byArm('with-skill').costUsd).toBeCloseTo(0.03, 10);
    expect(byArm('baseline').costUsd).toBeCloseTo(0.05, 10);
    expect(r.ev.costUsd).toBeCloseTo(0.08, 10);
    expect(r.ev.costEstimated).toBeUndefined();
    expect(r.report.totalCostUsd).toBeCloseTo(0.08, 10);
  });

  test('no reported cost (absent, or total 0 = unpriced): the run is charged the per-run ceiling and flagged estimated', () => {
    const absent = [session, systemEvent('message_end', null), assistantEnd(undefined)];
    const zero = [session, systemEvent('message_end', null), assistantEnd(0)];
    for (const lines of [absent, zero]) {
      const s = stubs({ piWith: lines, piBase: lines });
      const r = runEvals({}, s, ['--runtime', 'pi', '--repeats', '1', '--run-usd', '0.4'], {});
      expect(r.ev.runs.map((x) => x.costUsd)).toEqual([0.4, 0.4]);
      expect(r.ev.costEstimated).toBe(true);
      expect(r.report.totalCostUsd).toBeCloseTo(0.8, 10);
      fs.rmSync(sub('results'), { recursive: true, force: true });
    }
  });

  test('a run that times out is charged the ceiling even if it reported partial cost', async () => {
    fs.mkdirSync(sub('bin'), { recursive: true });
    fs.mkdirSync(sub('ws'));
    fs.writeFileSync(sub('bin/pi'), `#!/bin/sh\n${printLines([session, systemEvent('message_end', null), assistantEnd(0.01)])}\nsleep 30\n`, { mode: 0o755 });
    const r = await pi.run({ prompt: 'p', workspace: sub('ws'), env: { PATH: process.env.PATH }, timeoutMs: 1500 }, { bin: sub('bin/pi') });
    expect(r.timedOut).toBe(true);
    expect(r.costUsd).toBeNull();
  });
});

describe('TRD-013 Pi baseline leak check', () => {
  const clean = () => baseStream(null);

  test('a baseline whose system prompt lists the skill aborts the eval as a leak; with-skill is not scored', () => {
    const s = stubs({ piWith: withStream([SKILL]), piBase: baseStream([SKILL]) });
    const r = runEvals({}, s, ['--runtime', 'pi', '--repeats', '1']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(new RegExp(`ABORTED eval "${SKILL}": baseline arm leaked the skill under test "${SKILL}": reported loaded by the runtime`));
    expect(r.ev.outcome).toBe('fail');
    expect(r.ev.baseline).toBeNull();
  });

  test('a baseline that lists any other skill is also a leak (Pi baseline must list none)', () => {
    const s = stubs({ piWith: withStream([SKILL]), piBase: baseStream(['some-user-skill']) });
    const r = runEvals({}, s, ['--runtime', 'pi', '--repeats', '1']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/skills were loaded under --no-skills \(some-user-skill\)/);
    expect(r.ev.abort).toBeDefined();
  });

  test('a completed baseline with no readable system prompt is unverifiable and aborts the eval', () => {
    const s = stubs({ piWith: withStream([SKILL]), piBase: [session, assistantEnd(0.01), turnEnd()] });
    const r = runEvals({}, s, ['--runtime', 'pi', '--repeats', '1']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/baseline isolation unverifiable/);
    expect(r.ev.baseline).toBeNull();
  });

  test('a baseline that crashes before any system prompt is not counted, and is not called clean', () => {
    const s = stubs({ piWith: withStream([SKILL]), piBase: [session], piBaseExit: 3 });
    const r = runEvals({}, s, ['--runtime', 'pi', '--repeats', '1']);
    expect(r.ev.baseline).toMatchObject({ runs: 0, unverifiable: 1 });
    expect(r.ev.runs.find((x) => x.arm === 'baseline').outcome).toBe('unverifiable');
  });

  test('contrast: a baseline whose system prompt was seen and lists no skills is verified clean and scored', () => {
    const s = stubs({ piWith: withStream([SKILL]), piBase: clean() });
    const r = runEvals({}, s, ['--runtime', 'pi', '--repeats', '1']);
    expect(r.status).toBe(0);
    expect(r.ev.abort).toBeUndefined();
    expect(r.ev.baseline).toMatchObject({ runs: 1 });
    expect(arms.checkBaseline({ id: 'e', skill: SKILL, package: PKG }, { runtime: 'pi', loadedSkills: [], loadedSource: 'system-prompt', exitCode: 0, timedOut: false }, { repoRoot: REPO_ROOT })).toBeNull();
  });
});

describe('TRD-013 Pi stream parsing', () => {
  test('skills come from <name> entries, tolerant of a non-JSON agent_end line, deduped across events', () => {
    const line = brokenAgentEnd(['alpha', 'beta']);
    expect(() => JSON.parse(line)).toThrow();
    const only = pi.analyzeTranscript(line);
    expect(only).toMatchObject({ loadedSkills: ['alpha', 'beta'], loadedSource: 'system-prompt' });
    const all = pi.analyzeTranscript([systemEvent('message_start', ['beta', 'alpha']), systemEvent('message_end', ['alpha', 'beta']), line].join('\n'));
    expect(all.loadedSkills).toEqual(['alpha', 'beta']);
  });

  test('a system prompt with no skills block is a verified empty list; no system prompt is not evidence', () => {
    expect(pi.analyzeTranscript(systemEvent('message_start', null))).toMatchObject({ loadedSkills: [], loadedSource: 'system-prompt' });
    expect(pi.analyzeTranscript([session, assistantEnd(0.01)].join('\n'))).toMatchObject({ loadedSkills: [], loadedSource: 'transcript-scan' });
  });

  test('<name> text outside the system prompt skills block (a user message, a tool result) is not a loaded skill', () => {
    const user = JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: '<available_skills><skill><name>planted</name></skill></available_skills>' }] } });
    const tool = JSON.stringify({ type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: '<name>planted</name>' }] } });
    expect(pi.analyzeTranscript([user, tool, systemEvent('message_end', ['real'])].join('\n')).loadedSkills).toEqual(['real']);
  });

  test('inside a system prompt, <name> outside the skills block is not a skill, and only a system-role line shows a system prompt', () => {
    const decoy = JSON.stringify({ type: 'message_end', message: { role: 'system', content: '', sections: { rules: '<name>decoy</name>', skills: skillsSection(['real']), docs: '<name>decoy2</name>' } } });
    expect(pi.analyzeTranscript(decoy).loadedSkills).toEqual(['real']);
    const userWithSections = JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'sections' }], sections: {} } });
    expect(pi.analyzeTranscript(userWithSections)).toMatchObject({ loadedSource: 'transcript-scan' });
  });

  test('invocation: a /skill:<name> expansion or a read of <name>/SKILL.md counts; other reads do not', () => {
    const expansion = JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: '<skill name="alpha" location="/x/alpha/SKILL.md">\nbody' }] } });
    const read = assistantEnd(0.01, [{ type: 'toolCall', name: 'read', arguments: { path: '/x/beta/SKILL.md' } }, { type: 'toolCall', name: 'read', arguments: { path: '/x/gamma/README.md' } }]);
    expect(pi.analyzeTranscript([systemEvent('message_end', null), expansion, read, turnEnd(), turnEnd()].join('\n'))).toMatchObject({ invokedSkills: ['alpha', 'beta'], turns: 2 });
    expect(arms.wasInvoked('beta', { invokedSkills: ['beta'], transcript: '' })).toBe(true);
  });

  test('bash tool calls are collected as commands (so forbidden-command checks see Pi runs)', () => {
    const line = assistantEnd(0.01, [{ type: 'toolCall', name: 'bash', arguments: { command: 'git push origin main' } }, { type: 'toolCall', name: 'read', arguments: { path: '/x' } }]);
    expect(commandsFromLine(line)).toEqual(['git push origin main']);
    expect(commandsFromLine(JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'x' } }] } }))).toEqual([]);
  });
});

describe('TRD-013 Pi run() interface', () => {
  const job = (over = {}) => ({ evalId: 'e', skill: SKILL, arm: 'with-skill', runtime: 'pi', prompt: 'p', workspace: sub('ws'), env: { PATH: process.env.PATH }, timeoutMs: 20000, skillPaths: [SKILL_DIR], ...over });
  beforeEach(() => fs.mkdirSync(sub('ws')));

  test('returns the interface shape; redacts the secret from transcript, commands and stderr', async () => {
    fs.mkdirSync(sub('bin'));
    const secret = 'sk-pi-secret-0123456789';
    const cmd = assistantEnd(0.04, [{ type: 'toolCall', name: 'bash', arguments: { command: `echo ${secret}` } }]);
    fs.writeFileSync(sub('bin/pi'), `#!/bin/sh\necho "oops ${secret}" >&2\n${printLines([...withStream([SKILL]), cmd])}\n`, { mode: 0o755 });
    const r = await getRunner('pi').run(job(), { bin: sub('bin/pi'), secrets: [secret] });
    expect(Object.keys(r)).toEqual(expect.arrayContaining(['transcript', 'exitCode', 'timedOut', 'costUsd', 'loadedSkills', 'runtime']));
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, runtime: 'pi', loadedSkills: [SKILL], loadedSource: 'system-prompt' });
    expect(r.costUsd).toBeCloseTo(0.05, 10);
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.commands).toEqual(['echo [REDACTED]']);
    expect(r.stderr).toContain('[REDACTED]');
  });

  test('refuses a missing env or workspace, an option-like prompt or model, and a bad skill path', async () => {
    const bin = { bin: '/bin/true' };
    await expect(pi.run(job({ env: undefined }), bin)).rejects.toThrow(/job\.env is required/);
    await expect(pi.run(job({ workspace: undefined }), bin)).rejects.toThrow(/job\.workspace is required/);
    await expect(pi.run(job({ prompt: '--help' }), bin)).rejects.toThrow(/must not start with "-"/);
    await expect(pi.run(job({ model: '--x' }), bin)).rejects.toThrow(/model must not start/);
    await expect(pi.run(job({ skillPaths: [sub('missing')] }), bin)).rejects.toThrow(/not an absolute directory containing SKILL\.md/);
    await expect(pi.run(job({ skillPaths: ['relative/dir'] }), bin)).rejects.toThrow(/not an absolute directory/);
  });

  test('the with-skill/baseline argv differ only by --skill <dir>', () => {
    const w = pi.buildArgs(job());
    const b = pi.buildArgs(job({ skillPaths: [] }));
    expect(w.filter((a) => a !== '--skill' && a !== SKILL_DIR)).toEqual(b);
    expect(b).toContain('--no-skills');
  });

  test('Pi credential names live in the editable allowlist file, per runtime', () => {
    expect(envlib.loadCredentialNames({ runtime: 'pi' })).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']));
    expect(envlib.loadCredentialNames({ runtime: 'claude' })).not.toContain('OPENAI_API_KEY');
    const file = sub('allow.json');
    fs.writeFileSync(file, JSON.stringify({ credentials: ['A_KEY'], runtimes: { pi: ['PI_ONLY'] } }));
    expect(envlib.loadCredentialNames({ file, runtime: 'pi' })).toEqual(['A_KEY', 'PI_ONLY']);
    expect(envlib.loadCredentialNames({ file, runtime: 'claude' })).toEqual(['A_KEY']);
    fs.writeFileSync(file, JSON.stringify({ credentials: [], runtimes: { pi: ['bad name'] } }));
    expect(() => envlib.loadCredentialNames({ file, runtime: 'pi' })).toThrow(/invalid environment variable name/);
  });
});
