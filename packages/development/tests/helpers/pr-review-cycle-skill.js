'use strict';

const fs = require('fs');
const path = require('path');

const SKILL_DIR = path.join(__dirname, '..', '..', 'skills', 'pr-review-cycle');

/**
 * The pr-review-cycle skill is SKILL.md plus companion files under reference/.
 * Only a companion that SKILL.md names by relative path counts as part of the
 * skill (the Pi copier ships exactly those), so a rule that lives in a file the
 * SKILL.md never points at is not seen here and its tests still fail.
 */
function referencedFiles(skillText, skillDir = SKILL_DIR) {
  const refDir = path.join(skillDir, 'reference');
  if (!fs.existsSync(refDir)) return [];
  return fs
    .readdirSync(refDir)
    .filter((f) => f.endsWith('.md') && skillText.includes(`reference/${f}`))
    .sort()
    .map((f) => path.join(refDir, f));
}

/** SKILL.md alone. */
function readSkillMain(skillDir = SKILL_DIR) {
  return fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
}

const ORDER = [
  'scope-guidance-depth.md',
  'ledger-and-verification.md',
  'triage-fix-reverify.md',
  'remote-phase.md',
  'status-and-state.md',
  'merge-gate.md',
];

const body = (text) => text.replace(/^# [^\n]*\n\nCompanion to `SKILL.md`[^\n]*\n\n/, '');

/**
 * The whole skill as one document in its original reading order: SKILL.md's
 * header, stopping rule, the full inputs table, CLI resolution, every step's full
 * text from the companions SKILL.md names, then the Safety rules. A companion
 * SKILL.md does not name is left out, so its rules count for nothing.
 */
function readSkillBundle(skillDir = SKILL_DIR) {
  const main = readSkillMain(skillDir);
  const named = new Set(referencedFiles(main, skillDir).map((f) => path.basename(f)));
  const refText = (name) => body(fs.readFileSync(path.join(skillDir, 'reference', name), 'utf8'));
  const at = (label) => {
    const i = main.indexOf(label);
    if (i < 0) throw new Error(`SKILL.md lacks ${label}`);
    return i;
  };
  const parts = [main.slice(0, at('## Inputs'))];
  parts.push('## Inputs\n\n' + (named.has('inputs.md') ? refText('inputs.md').slice(refText('inputs.md').indexOf('| Variable')) : ''));
  parts.push(main.slice(at('## Resolve the CLI'), at('### Step 1 --')));
  for (const name of ORDER) if (named.has(name)) parts.push(refText(name));
  parts.push(main.slice(at('## Safety rules')));
  return parts.join('\n\n');
}

/** One named companion (must also be named by SKILL.md). */
function readSkillReference(name, skillDir = SKILL_DIR) {
  const main = readSkillMain(skillDir);
  if (!main.includes(`reference/${name}`)) throw new Error(`SKILL.md does not name reference/${name}`);
  return fs.readFileSync(path.join(skillDir, 'reference', name), 'utf8');
}

module.exports = { SKILL_DIR, readSkillMain, readSkillBundle, readSkillReference };
