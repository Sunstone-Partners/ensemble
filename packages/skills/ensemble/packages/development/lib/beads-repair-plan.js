'use strict';

/**
 * Repair-plan builder for `/ensemble:refine-beads` (packages/development/commands/
 * refine-beads.yaml, via `beads-refine-cli.js`'s `plan` subcommand).
 *
 * PR 7 independent review item 8: every `fix.commands[]` entry below is a literal `br ...`
 * string (e.g. `br comments add <id> --message '...'`, `br dep add <child> <parent> --type
 * parent-child`). This is DISPLAY-ONLY text -- a human-readable rendering of what the proposed
 * repair would do -- never a string this module or its one caller `execFile`s/`spawn`s/
 * `execFileSync`s (grepped: neither file, nor `beads-refine-cli.js`, calls any `child_process`
 * function; `requiresDependencyConfirmation` above even regex-matches against these same
 * strings for a UI confirmation gate, not to decide what to run). The real mutation, when a
 * user approves a fix, is ALWAYS applied by refine-beads.yaml's own Apply Approved Repairs
 * phase, which runs the EQUIVALENT toolchain-cli capability (`tracker.comment`/
 * `tracker.dep-add`/`tracker.update`/`tracker.dep-remove`, matching this module's own
 * finding-type-to-capability mapping) via `node "$TOOLCHAIN_CLI" run <capability> ...` --
 * never the literal `br` string this module generated for display. Do not wire `fix.commands`
 * to an executor: if the repair plan's capability mapping ever needs to change, change the
 * `fix(...)` calls in `planFixForFinding` below AND refine-beads.yaml's own "Supported
 * mutations" list together, since they must stay in sync by convention, not by shared code.
 */

function fix(id, finding, commands, verify, extra = {}) {
  return Object.assign({
    id,
    findingId: finding.id,
    risk: 'medium',
    requiresDependencyConfirmation: commands.some((c) => /^br dep\s+/i.test(c)),
    commands,
    verify,
    inverseCommands: [],
    expectedGraphEffect: finding.recommendation || '',
    skipped: false,
  }, extra);
}

function shellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, `'"'"'`)}'`;
}

function planFixForFinding(finding, index) {
  const id = `fix-${String(index + 1).padStart(3, '0')}`;
  const beadIds = finding.beadIds || [];
  if (finding.requiresUserResolution || finding.type === 'cycle' || finding.type === 'priority_order') {
    return fix(id, finding, [], { kind: 'manual_resolution_required' }, {
      risk: 'high',
      skipped: true,
      options: ['retry with chosen edge', 'skip', 'reverse selected edge', 'abort'],
      expectedGraphEffect: 'Blocked until user chooses a dependency resolution.',
    });
  }
  if ((finding.type === 'traceability' || finding.type === 'pr_boundary') && beadIds[0]) {
    const msg = `refine-beads: ${finding.type} finding ${finding.id}: ${finding.recommendation}`;
    return fix(id, finding, [`br comments add ${beadIds[0]} --message ${shellQuote(msg)}`], { kind: 'comment_contains', beadId: beadIds[0], text: `refine-beads: ${finding.type}` }, { risk: 'low', inverseCommands: [] });
  }
  if (finding.type === 'orphan' && beadIds.length >= 2) {
    const child = beadIds[0];
    const parent = beadIds[1];
    return fix(id, finding, [`br dep add ${shellQuote(child)} ${shellQuote(parent)} --type parent-child`], { kind: 'dependency_exists', source: child, target: parent }, { risk: 'medium', inverseCommands: [`br dep remove ${shellQuote(child)} ${shellQuote(parent)}`] });
  }
  if (finding.type === 'duplicate') {
    return fix(id, finding, [], { kind: 'manual_review_required' }, {
      risk: 'low',
      skipped: true,
      options: ['merge', 'close duplicate', 'relink', 'leave unchanged'],
      expectedGraphEffect: 'No automatic close is generated for possible duplicates.',
    });
  }
  return fix(id, finding, [], { kind: 'manual_review_required' }, { skipped: true, expectedGraphEffect: 'Manual review required; no deterministic br command proposed.' });
}

function buildRepairPlan(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const fixes = list.map(planFixForFinding);
  return {
    ok: true,
    findings: list,
    fixes,
    summary: summarizeRepairPlan(fixes),
  };
}

function summarizeRepairPlan(fixes) {
  const list = Array.isArray(fixes) ? fixes : [];
  return {
    total: list.length,
    executable: list.filter((f) => !f.skipped && f.commands.length).length,
    skipped: list.filter((f) => f.skipped || !f.commands.length).length,
    dependencyConfirmationRequired: list.filter((f) => f.requiresDependencyConfirmation).length,
  };
}

function renderSummary({ findings = [], fixes = [], applied = [], skipped = [], failed = [], remaining = [] } = {}) {
  const changedEdges = applied
    .filter((a) => a.verify && a.verify.kind === 'dependency_exists')
    .map((a) => `${a.verify.source} -> ${a.verify.target}`);
  return {
    findings: findings.length,
    fixesApproved: applied.length + skipped.length + failed.length,
    fixesApplied: applied.length,
    fixesSkipped: skipped.length,
    failedFixes: failed.length,
    remainingGraphIssues: remaining.length,
    changedDependencyEdges: changedEdges,
  };
}

module.exports = { buildRepairPlan, summarizeRepairPlan, renderSummary, shellQuote };
