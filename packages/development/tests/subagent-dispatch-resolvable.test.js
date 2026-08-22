const fs = require('fs');
const path = require('path');

/**
 * br-rt4: beads-build.yaml dispatched Task(subagent_type=beads-build-wave) and
 * implement-trd.yaml dispatched Task(subagent_type=implement-trd-task), but
 * both targets shipped only as commands - never as agents. A command file is
 * not in the agent registry, so the dispatch could not resolve and the
 * documented execution engine was unreachable.
 *
 * This guard fails if any command dispatches a concrete subagent_type that has
 * no matching agent definition on disk.
 */
describe('every subagent_type dispatched by a command resolves to a real agent', () => {
  const commandsDir = path.join(__dirname, '../commands');
  const agentsDir = path.join(__dirname, '../agents');

  // Agents this package can dispatch: its own, plus any sibling package's.
  const packagesDir = path.join(__dirname, '../..');
  const knownAgents = new Set(
    fs
      .readdirSync(packagesDir)
      .map((pkg) => path.join(packagesDir, pkg, 'agents'))
      .filter((dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory())
      .flatMap((dir) => fs.readdirSync(dir))
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.md'))
      .map((f) => f.replace(/\.(yaml|md)$/, ''))
  );

  // Placeholders resolved at runtime from context, not literal agent names.
  const isPlaceholder = (name) => name.startsWith('<') || name === '';

  const dispatches = fs
    .readdirSync(commandsDir)
    .filter((f) => f.endsWith('.yaml'))
    .flatMap((file) => {
      const text = fs.readFileSync(path.join(commandsDir, file), 'utf8');
      const matches = text.match(/subagent_type=(?:"|')?([^,)"'\s]*)/g) || [];
      return matches.map((m) => ({
        file,
        agent: m.replace(/^subagent_type=(?:"|')?/, ''),
      }));
    })
    .filter(({ agent }) => !isPlaceholder(agent));

  test('at least one concrete dispatch exists to check', () => {
    expect(dispatches.length).toBeGreaterThan(0);
  });

  test.each(dispatches)('%s dispatches $agent, which exists as an agent', ({ file, agent }) => {
    expect(knownAgents.has(agent)).toBe(true);
    expect(file).toBeTruthy();
  });

  // The two that regressed. Named explicitly so deleting either agent fails
  // loudly even if the dispatch prose is reworded.
  test.each(['beads-build-wave', 'implement-trd-task'])(
    '%s ships as an agent, not only as a command',
    (name) => {
      expect(fs.existsSync(path.join(agentsDir, `${name}.yaml`))).toBe(true);
      expect(fs.existsSync(path.join(agentsDir, `${name}.md`))).toBe(true);
      expect(fs.existsSync(path.join(commandsDir, `${name}.yaml`))).toBe(true);
    }
  );

  test('runner agents delegate to their command instead of duplicating it', () => {
    for (const name of ['beads-build-wave', 'implement-trd-task']) {
      const text = fs.readFileSync(path.join(agentsDir, `${name}.yaml`), 'utf8');
      expect(text).toMatch(new RegExp(`ensemble:${name}`));
      expect(text).toMatch(/RUNNER, not a second copy of the procedure/);
      expect(text).toMatch(/the command wins/);
    }
  });
});
