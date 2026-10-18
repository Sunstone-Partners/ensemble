/**
 * metadata.visibility: 'hidden' in the Pi generator.
 *
 * A hidden command is still generated and readable by path (dispatchers point
 * at it), but it is written under prompts/_hidden/ so Pi's non-recursive
 * prompts/*.md scan does not register it and no wrapper skill is produced.
 * Each test pairs the hidden fixture with a visible control so a generator
 * that hides everything (or nothing) fails.
 */

jest.setTimeout(60_000);

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generate, promptOutputPath } from '../src/generator';
import { generateCommandSkills } from '../src/transformers/command-skill-transformer';
import { GeneratorOptions } from '../src/types';

function command(name: string, extra = '', visibility = ''): string {
  return [
    'metadata:',
    `  name: "ensemble:${name}"`,
    `  description: "The ${name} command"`,
    '  version: "1.0.0"',
    ...(visibility ? [`  visibility: ${visibility}`] : []),
    'mission:',
    `  summary: "Summary of ${name}"`,
    'workflow:',
    '  phases:',
    '    - name: "Do it"',
    '      order: 1',
    '      steps:',
    '        - order: 1',
    '          title: "Step"',
    '          description: "Do the thing"',
    extra,
    '',
  ].join('\n');
}

const DISPATCHER_EXTRA = [
  'dispatch:',
  '  subcommands:',
  '    - keyword: shown',
  '      ref: shown',
  '      description: "Visible leaf"',
  '    - keyword: secret',
  '      ref: secret',
  '      description: "Hidden leaf"',
].join('\n');

describe('Pi generator: metadata.visibility', () => {
  let src: string;
  let out: string;

  const options = (overrides: Partial<GeneratorOptions> = {}): GeneratorOptions => ({
    dryRun: false,
    verbose: false,
    validate: false,
    sourceRoot: src,
    outputRoot: out,
    ...overrides,
  });

  beforeEach(() => {
    src = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-vis-src-'));
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-vis-out-'));
    fs.mkdirSync(path.join(src, 'packages', 'fake', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(src, 'CLAUDE.md'), '## Agent Mesh\n\nContent.\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  });

  function write(file: string, content: string): void {
    fs.writeFileSync(path.join(src, 'packages', 'fake', 'commands', file), content, 'utf-8');
  }

  const prompt = (...p: string[]) => path.join(out, 'prompts', ...p);

  it('writes a hidden command under prompts/_hidden/ and a visible one at the prompts root', async () => {
    write('shown.yaml', command('shown'));
    write('secret.yaml', command('secret', '', 'hidden'));
    await generate(options());

    expect(fs.existsSync(prompt('ensemble-shown.md'))).toBe(true);
    expect(fs.existsSync(prompt('_hidden', 'ensemble-shown.md'))).toBe(false);
    expect(fs.existsSync(prompt('_hidden', 'ensemble-secret.md'))).toBe(true);
    expect(fs.existsSync(prompt('ensemble-secret.md'))).toBe(false);
    // The hidden file is a real, complete prompt, not a stub.
    expect(fs.readFileSync(prompt('_hidden', 'ensemble-secret.md'), 'utf-8')).toContain(
      '# ensemble-secret'
    );
  });

  it('treats an explicit visibility: visible exactly like the default', async () => {
    write('shown.yaml', command('shown', '', 'visible'));
    await generate(options());
    expect(fs.existsSync(prompt('ensemble-shown.md'))).toBe(true);
    expect(fs.existsSync(prompt('_hidden'))).toBe(false);
  });

  it('generates a wrapper skill for a visible command but not for a hidden one', async () => {
    write('shown.yaml', command('shown'));
    write('secret.yaml', command('secret', '', 'hidden'));
    await generate(options());

    expect(fs.existsSync(path.join(out, 'skills', 'ensemble-shown', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'skills', 'ensemble-secret'))).toBe(false);
  });

  it('generateCommandSkills ignores prompts/_hidden/ (non-recursive scan)', async () => {
    fs.mkdirSync(prompt('_hidden'), { recursive: true });
    fs.writeFileSync(prompt('ensemble-a.md'), '# ensemble-a\n', 'utf-8');
    fs.writeFileSync(prompt('_hidden', 'ensemble-b.md'), '# ensemble-b\n', 'utf-8');

    const results = await generateCommandSkills(out, { dryRun: true });
    expect(results.map((r) => path.basename(path.dirname(r.outputPath)))).toEqual([
      'ensemble-a',
    ]);
  });

  it('points a dispatcher at the hidden prompt path and the visible one at the root', async () => {
    write('shown.yaml', command('shown'));
    write('secret.yaml', command('secret', '', 'hidden'));
    write('hub.yaml', command('hub', DISPATCHER_EXTRA));
    await generate(options());

    const hub = fs.readFileSync(prompt('ensemble-hub.md'), 'utf-8');
    const rel = (p: string) => path.relative(src, p).split(path.sep).join('/');
    expect(hub).toContain(`\`${rel(prompt('_hidden', 'ensemble-secret.md'))}\``);
    expect(hub).toContain(`\`${rel(prompt('ensemble-shown.md'))}\``);
    // The file the dispatcher names actually exists on disk.
    expect(fs.existsSync(prompt('_hidden', 'ensemble-secret.md'))).toBe(true);
  });

  it('dry-run writes nothing, including prompts/_hidden/', async () => {
    write('secret.yaml', command('secret', '', 'hidden'));
    await generate(options({ dryRun: true }));
    expect(fs.existsSync(prompt())).toBe(false);
  });

  it('removes the stale visible prompt and wrapper skill when a command becomes hidden', async () => {
    write('secret.yaml', command('secret'));
    await generate(options());
    expect(fs.existsSync(prompt('ensemble-secret.md'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'skills', 'ensemble-secret', 'SKILL.md'))).toBe(true);

    write('secret.yaml', command('secret', '', 'hidden'));
    await generate(options());
    expect(fs.existsSync(prompt('ensemble-secret.md'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'skills', 'ensemble-secret'))).toBe(false);
    expect(fs.existsSync(prompt('_hidden', 'ensemble-secret.md'))).toBe(true);
  });

  it('removes the stale _hidden prompt when a command becomes visible again', async () => {
    write('secret.yaml', command('secret', '', 'hidden'));
    await generate(options());
    write('secret.yaml', command('secret'));
    await generate(options());
    expect(fs.existsSync(prompt('_hidden', 'ensemble-secret.md'))).toBe(false);
    expect(fs.existsSync(prompt('ensemble-secret.md'))).toBe(true);
  });

  it('never deletes a hand-authored skill that shares a hidden command\'s name', async () => {
    write('secret.yaml', command('secret'));
    await generate(options());
    // Replace the generated wrapper with a skill lacking the wrapper marker.
    const skillFile = path.join(out, 'skills', 'ensemble-secret', 'SKILL.md');
    fs.writeFileSync(skillFile, '---\nname: ensemble-secret\ndescription: hand\n---\nbody\n');

    write('secret.yaml', command('secret', '', 'hidden'));
    await generate(options());
    expect(fs.existsSync(skillFile)).toBe(true);
  });

  it('promptOutputPath routes by the hidden flag', () => {
    expect(promptOutputPath('/o', 'ensemble:x', false)).toBe(path.join('/o', 'prompts', 'ensemble-x.md'));
    expect(promptOutputPath('/o', 'ensemble:x', true)).toBe(
      path.join('/o', 'prompts', '_hidden', 'ensemble-x.md')
    );
  });
});
