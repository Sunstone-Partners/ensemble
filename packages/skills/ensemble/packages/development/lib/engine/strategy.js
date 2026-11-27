'use strict';

/**
 * TRD-013 (TRD-2026-d571763f): which implementation strategy a TRD is being built under.
 *
 * `implement resume` has always answered this for step 1.5; the quality gate needs the same
 * answer, because the strategy decides whether a failing gate blocks or is only recorded. The
 * precedence moved here unchanged rather than being re-derived: a second implementation could
 * disagree with the first, and then the same TRD would be `tdd` to one verb and
 * `characterization` to another.
 *
 * Every step of the precedence reads policy, never a hard-coded table (Constitution Rule 8):
 * `constitution_methodology` maps the repository's own word, `strategy_detection` maps the
 * TRD's, and `default_strategy` is the floor.
 */

const fs = require('fs');
const path = require('path');
const { STRATEGIES } = require('./policy');
const { getFrontmatterField, normalizeLineEndings } = require('../trd-parser');

/** Where the repository declares its development methodology. */
const CONSTITUTION_FILE = path.join('docs', 'standards', 'constitution.md');

/** The constitution line the methodology is read from. */
const METHODOLOGY_RE = /Development Methodology:?\**\s*(.+)/i;

/**
 * The methodology the repository's constitution declares, mapped through policy.
 * @param {string} projectRoot
 * @param {object} table the `constitution_methodology` policy value
 * @returns {string|null} a strategy, or `null` when the constitution says nothing usable
 */
function constitutionStrategy(projectRoot, table) {
  let text;
  try {
    text = fs.readFileSync(path.join(projectRoot, CONSTITUTION_FILE), 'utf8');
  } catch {
    return null;
  }
  for (const line of normalizeLineEndings(text).split('\n')) {
    const match = METHODOLOGY_RE.exec(line);
    if (!match) continue;
    const word = match[1]
      .replace(/\*/g, '')
      .trim()
      .split(/[\s—–-]+/)[0]
      .toLowerCase();
    const mapped = table[word];
    if (typeof mapped === 'string') return mapped;
  }
  return null;
}

/**
 * The strategy the TRD's own words suggest, through the policy detection table.
 * @param {{summary: string, title: string}} parsed
 * @param {object} table the `strategy_detection` policy value
 * @returns {string|null}
 */
function detectStrategy(parsed, table) {
  const haystack = `${parsed.title || ''}\n${parsed.summary || ''}`.toLowerCase();
  for (const keyword of Object.keys(table)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`).test(haystack)) return table[keyword];
  }
  return null;
}

/**
 * Step 1.5's strategy precedence, in order.
 * @param {{frontmatter: object|null, parsed: object, policy: object, projectRoot: string,
 *   strategyArgument: string|undefined, warnings: string[]}} input
 * @returns {{source: string, strategy: string}}
 */
function resolveStrategy({
  frontmatter,
  parsed,
  policy,
  projectRoot,
  strategyArgument,
  warnings,
}) {
  if (strategyArgument !== undefined) return { source: 'argument', strategy: strategyArgument };

  const declared = getFrontmatterField(frontmatter, 'strategy');
  if (declared != null) {
    const value = String(declared).trim();
    if (STRATEGIES.includes(value)) return { source: 'trd', strategy: value };
    warnings.push(
      `TRD frontmatter 'strategy' is not one of ${STRATEGIES.join(', ')} ('${value}'); ignored`
    );
  }

  const fromConstitution = constitutionStrategy(projectRoot, policy.constitution_methodology);
  if (fromConstitution !== null) return { source: 'constitution', strategy: fromConstitution };

  const detected = detectStrategy(parsed, policy.strategy_detection);
  if (detected !== null) return { source: 'detection', strategy: detected };

  return { source: 'default', strategy: policy.default_strategy };
}

/**
 * The strategy in force for one TRD, for a caller that has not already parsed it.
 *
 * `implement resume` parses the TRD for several other reasons and passes what it has; a verb
 * that only needs the strategy reads the title and summary through `readParsedTrd`, so there is
 * still exactly one parser (`trd-cli parse`) behind both paths.
 *
 * @param {object} call the dispatcher's call object
 * @param {{frontmatter: object|null, parsed: object, policy: object, strategyArgument:
 *   string|undefined, warnings: string[]}} input
 * @returns {{source: string, strategy: string}}
 */
function strategyFor(call, { frontmatter, parsed, policy, strategyArgument, warnings }) {
  return resolveStrategy({
    frontmatter,
    parsed,
    policy,
    projectRoot: call.projectRoot,
    strategyArgument,
    warnings,
  });
}

module.exports = {
  CONSTITUTION_FILE,
  METHODOLOGY_RE,
  constitutionStrategy,
  detectStrategy,
  resolveStrategy,
  strategyFor,
};
