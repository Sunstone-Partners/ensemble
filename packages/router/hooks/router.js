#!/usr/bin/env node
'use strict';

/*
UserPromptSubmit Router Hook for Claude Code (Node port of router.py).

Analyzes user prompts using keyword matching against routing rules to provide
routing hints for specialized subagents or skills. Supports both global rules
and project-specific rules that are merged together.

No external API calls - uses pattern matching against router-rules.json.
Always injects context-appropriate guidance.

Environment Variables:
    ROUTER_RULES_PATH: Path to global router-rules.json (default: ../lib/router-rules.json relative to script)
    ROUTER_DEBUG: Enable debug logging to stderr (default: 0)
    ROUTER_SHORT_THRESHOLD: Word count threshold for "short" prompts (default: 5)
    ROUTER_STRICT_VALIDATION: Enable structural validation of rules (default: 1)
    ROUTER_CUSTOM_DISCOVERY: Enable custom agent/skill discovery (default: 1)
    ROUTER_PHRASES_PATH: Path to behavior-phrases.json (default: ../lib/behavior-phrases.json)
    ROUTER_PHRASES_DISABLE: Set to "1" to suppress the phrase-matching block

Project Rules:
    The router also checks for .claude/router-rules.json in the current working
    directory. Project rules are merged with global rules, with project-specific
    triggers and skills taking precedence.

Exit Codes:
    Always exits with 0 to never block user prompts.
*/

const fs = require('fs');
const path = require('path');

// === Constants ===
const DEFAULT_SHORT_THRESHOLD = 5;
const PROJECT_RULES_PATH = '.claude/router-rules.json';
const STRICT_VALIDATION_ENV = 'ROUTER_STRICT_VALIDATION';
const CUSTOM_DISCOVERY_ENV = 'ROUTER_CUSTOM_DISCOVERY';
const PHRASES_DISABLE_ENV = 'ROUTER_PHRASES_DISABLE';

// === Enums ===
const Scenario = Object.freeze({
  SHORT_NO_MATCH: 'short_no_match',
  AGENTS_ONLY: 'agents_only',
  AGENTS_AND_SKILLS: 'agents_and_skills',
  SKILLS_ONLY: 'skills_only',
  LONG_NO_MATCH: 'long_no_match',
});

// === Helpers (Python-stdlib shims) ===

// Python's \b with an escaped trigger that may start/end with non-word chars
// is emulated with a manual boundary test.
function pyWordBoundarySearch(triggerLower, text) {
  const t = triggerLower;
  if (!t) return false;
  const startWord = /\w/.test(t[0]);
  const endWord = /\w/.test(t[t.length - 1]);
  let idx = text.indexOf(t);
  while (idx !== -1) {
    const before = text[idx - 1];
    const after = text[idx + t.length];
    const beforeWord = before !== undefined && /\w/.test(before);
    const afterWord = after !== undefined && /\w/.test(after);
    const leftOk = !startWord || !beforeWord;
    const rightOk = !endWord || !afterWord;
    if (leftOk && rightOk) return true;
    idx = text.indexOf(t, idx + 1);
  }
  return false;
}

function regexpSearch(pattern, text) {
  try {
    return new RegExp(pattern, 'i').test(text);
  } catch {
    return { error: true };
  }
}

function truthyEnv(value, def) {
  const v = value === undefined || value === null ? def : value;
  return ['1', 'true', 'yes'].includes(String(v).toLowerCase());
}

// Deep copy via structuredClone with a JSON fallback for older runtimes.
function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// === Logging Functions ===
function logDebug(config, message) {
  if (config && config.debug) {
    const timestamp = formatTime();
    console.error(`[ROUTER DEBUG ${timestamp}] ${message}`);
  }
}

function logError(message) {
  const timestamp = formatTime();
  console.error(`[ROUTER ERROR ${timestamp}] ${message}`);
}

function formatTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

// === Configuration Functions ===
function getDefaultRulesPath() {
  return path.join(__dirname, '..', 'lib', 'router-rules.json');
}

function getDefaultPhrasesPath() {
  return path.join(__dirname, '..', 'lib', 'behavior-phrases.json');
}

function loadConfig() {
  const rulesPath = process.env.ROUTER_RULES_PATH || getDefaultRulesPath();
  const debug = truthyEnv(process.env.ROUTER_DEBUG, '0');

  let shortThreshold;
  try {
    shortThreshold = parseInt(process.env.ROUTER_SHORT_THRESHOLD || String(DEFAULT_SHORT_THRESHOLD), 10);
    if (Number.isNaN(shortThreshold)) shortThreshold = DEFAULT_SHORT_THRESHOLD;
  } catch {
    shortThreshold = DEFAULT_SHORT_THRESHOLD;
  }

  const strictValidation = truthyEnv(process.env[STRICT_VALIDATION_ENV], '1');
  const customDiscovery = truthyEnv(process.env[CUSTOM_DISCOVERY_ENV], '1');

  return {
    rulesPath,
    debug,
    shortThreshold,
    strictValidation,
    customDiscovery,
    cwd: process.cwd(),
  };
}

// === Input/Output Functions ===
function readInput(rawInput) {
  try {
    if (rawInput === undefined) {
      rawInput = fs.readFileSync(0, 'utf8');
    }
    if (!rawInput || !rawInput.trim()) return {};
    return JSON.parse(rawInput);
  } catch {
    return {};
  }
}

function writeOutput(output) {
  process.stdout.write(JSON.stringify(output) + '\n');
}

// === Rules Loading Functions ===
function loadRulesFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function loadGlobalRules(config) {
  const resolved = path.normalize(config.rulesPath);
  return loadRulesFile(resolved);
}

function loadProjectRules(config, inputData) {
  const cwd = inputData.cwd || config.cwd;
  if (!cwd) return null;
  const projectPath = path.join(cwd, PROJECT_RULES_PATH);
  return loadRulesFile(projectPath);
}

function mergeRules(globalRules, projectRules) {
  if (!projectRules) {
    return [globalRules, new Set(), new Set()];
  }

  const merged = deepCopy(globalRules);
  const projectAgents = new Set();
  const projectSkills = new Set();

  // Merge project_context triggers into categories
  if ('project_context' in projectRules) {
    for (const skillsOrAgents of Object.values(projectRules.project_context)) {
      if (Array.isArray(skillsOrAgents)) {
        for (const s of skillsOrAgents) projectSkills.add(s);
      }
    }
  }

  // Merge additional triggers into existing categories
  if ('triggers' in projectRules) {
    for (const [category, triggers] of Object.entries(projectRules.triggers)) {
      if (merged.agent_categories && category in merged.agent_categories) {
        const existing = merged.agent_categories[category].triggers || [];
        merged.agent_categories[category].triggers = existing.concat(triggers);
        for (const agent of merged.agent_categories[category].agents || []) {
          projectAgents.add(agent.name || '');
        }
      }
    }
  }

  // Merge additional skills
  if ('skills' in projectRules) {
    for (const [skillName, skillData] of Object.entries(projectRules.skills)) {
      if (merged.skills && skillName in merged.skills) {
        const existing = merged.skills[skillName].triggers || [];
        const newTriggers = skillData.triggers || [];
        merged.skills[skillName].triggers = existing.concat(newTriggers);
      } else {
        if (!merged.skills) merged.skills = {};
        merged.skills[skillName] = skillData;
      }
      projectSkills.add(skillName);
    }
  }

  // Merge skill_mappings (keyword -> skill associations)
  if ('skill_mappings' in projectRules) {
    for (const [keyword, skills] of Object.entries(projectRules.skill_mappings)) {
      for (const skillName of skills) {
        if (merged.skills && skillName in merged.skills) {
          const existing = merged.skills[skillName].triggers || [];
          if (!existing.includes(keyword)) {
            merged.skills[skillName].triggers = existing.concat([keyword]);
          }
          projectSkills.add(skillName);
        }
      }
    }
  }

  // Merge custom agents into utility category
  if ('custom_agents' in projectRules) {
    try {
      for (const [agentName, agentData] of Object.entries(projectRules.custom_agents)) {
        if (agentData === null || typeof agentData !== 'object' || Array.isArray(agentData)) continue;
        if (merged.agent_categories && 'utility' in merged.agent_categories) {
          merged.agent_categories.utility.agents = (merged.agent_categories.utility.agents || []).concat([
            {
              name: agentName,
              purpose: agentData.description || 'Custom project agent',
              tools: agentData.tools || [],
            },
          ]);
          if ('triggers' in agentData && Array.isArray(agentData.triggers)) {
            merged.agent_categories.utility.triggers = (merged.agent_categories.utility.triggers || []).concat(
              agentData.triggers,
            );
          }
          projectAgents.add(agentName);
        }
      }
    } catch {
      // Graceful degradation - ignore malformed custom_agents
    }
  }

  return [merged, projectAgents, projectSkills];
}

function validateRules(rules) {
  const requiredKeys = ['agent_categories', 'skills', 'injection_templates'];
  return requiredKeys.every((key) => key in rules);
}

function validateRulesStructure(rules) {
  const errors = [];

  const requiredKeys = ['agent_categories', 'skills', 'injection_templates'];
  for (const key of requiredKeys) {
    if (!(key in rules)) errors.push(`Missing required key: ${key}`);
  }
  if (errors.length) return [false, errors];

  // Validate agent_categories structure
  if (!isObj(rules.agent_categories)) {
    errors.push('agent_categories must be an object');
  } else {
    for (const [catName, catData] of Object.entries(rules.agent_categories)) {
      if (!isObj(catData)) {
        errors.push(`agent_categories.${catName} must be an object`);
        continue;
      }
      if (!('triggers' in catData)) errors.push(`agent_categories.${catName} missing 'triggers'`);
      else if (!Array.isArray(catData.triggers)) errors.push(`agent_categories.${catName}.triggers must be an array`);
      if (!('agents' in catData)) errors.push(`agent_categories.${catName} missing 'agents'`);
      else if (!Array.isArray(catData.agents)) errors.push(`agent_categories.${catName}.agents must be an array`);
    }
  }

  // Validate skills structure
  if (!isObj(rules.skills)) {
    errors.push('skills must be an object');
  } else {
    for (const [skillName, skillData] of Object.entries(rules.skills)) {
      if (!isObj(skillData)) {
        errors.push(`skills.${skillName} must be an object`);
        continue;
      }
      if (!('triggers' in skillData)) errors.push(`skills.${skillName} missing 'triggers'`);
      else if (!Array.isArray(skillData.triggers)) errors.push(`skills.${skillName}.triggers must be an array`);
    }
  }

  // Validate injection_templates structure
  if (!isObj(rules.injection_templates)) {
    errors.push('injection_templates must be an object');
  }

  return [errors.length === 0, errors];
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// === Keyword Matching Functions ===
function normalizeText(text) {
  return String(text).toLowerCase().trim();
}

function countWords(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function matchAgentCategories(prompt, rules, projectAgents) {
  const results = [];
  const matchedProjectAgents = [];
  const promptLower = normalizeText(prompt);
  const categories = rules.agent_categories || {};

  for (const [categoryName, categoryData] of Object.entries(categories)) {
    const triggers = categoryData.triggers || [];
    const agents = categoryData.agents || [];
    let matchCount = 0;

    for (const trigger of triggers) {
      if (pyWordBoundarySearch(String(trigger).toLowerCase(), promptLower)) {
        matchCount += 1;
      }
    }

    if (matchCount > 0) {
      results.push([categoryName, matchCount, agents]);
      for (const agent of agents) {
        if (projectAgents.has(agent.name || '')) {
          matchedProjectAgents.push(agent.name || '');
        }
      }
    }
  }

  results.sort((a, b) => b[1] - a[1]);
  return [results, matchedProjectAgents];
}

function matchSkills(prompt, rules, projectSkills, config) {
  const results = [];
  const matchedProjectSkills = [];
  const promptLower = normalizeText(prompt);
  const skills = rules.skills || {};

  for (const [skillName, skillData] of Object.entries(skills)) {
    const triggers = skillData.triggers || [];
    const patterns = skillData.patterns || [];
    const purpose = skillData.purpose || '';
    let matchCount = 0;

    for (const trigger of triggers) {
      if (pyWordBoundarySearch(String(trigger).toLowerCase(), promptLower)) {
        matchCount += 1;
      }
    }

    for (const pattern of patterns) {
      const r = regexpSearch(pattern, promptLower);
      if (r === true) matchCount += 2;
      else if (r && r.error) logDebug(config, `Invalid pattern '${pattern}': invalid regex`);
    }

    if (matchCount > 0) {
      results.push([skillName, matchCount, purpose]);
      if (projectSkills.has(skillName)) {
        matchedProjectSkills.push(skillName);
      }
    }
  }

  results.sort((a, b) => b[1] - a[1]);
  return [results, matchedProjectSkills];
}

function analyzePrompt(prompt, rules, projectAgents, projectSkills, config) {
  const result = {
    matchedCategories: [],
    matchedAgents: [],
    matchedSkills: [],
    matchCount: 0,
    wordCount: 0,
    projectMatchedAgents: [],
    projectMatchedSkills: [],
    hasProjectMatches: false,
  };
  result.wordCount = countWords(prompt);

  // Match agent categories
  const [categoryMatches, matchedProjAgents] = matchAgentCategories(prompt, rules, projectAgents);
  for (const [categoryName, matchCount, agents] of categoryMatches) {
    result.matchedCategories.push(categoryName);
    result.matchedAgents.push(...agents.slice(0, 2));
    result.matchCount += matchCount;
  }
  result.projectMatchedAgents = matchedProjAgents;

  // Match skills
  const [skillMatches, matchedProjSkills] = matchSkills(prompt, rules, projectSkills, config);
  for (const [skillName, matchCount, purpose] of skillMatches.slice(0, 3)) {
    result.matchedSkills.push(skillName);
    result.matchCount += matchCount;
  }
  result.projectMatchedSkills = matchedProjSkills;

  // Track if we have any project-specific matches
  result.hasProjectMatches = !!(matchedProjAgents.length || matchedProjSkills.length);

  // Deduplicate agents
  const seenAgents = new Set();
  const uniqueAgents = [];
  for (const agent of result.matchedAgents) {
    const agentName = agent.name || '';
    if (agentName && !seenAgents.has(agentName)) {
      seenAgents.add(agentName);
      uniqueAgents.push(agent);
    }
  }
  result.matchedAgents = uniqueAgents.slice(0, 4);

  return result;
}

// === Scenario Determination ===
function determineScenario(result, config) {
  const hasAgents = result.matchedAgents.length > 0;
  const hasSkills = result.matchedSkills.length > 0;
  const isShort = result.wordCount < config.shortThreshold;

  if (hasAgents && hasSkills) return Scenario.AGENTS_AND_SKILLS;
  else if (hasAgents) return Scenario.AGENTS_ONLY;
  else if (hasSkills) return Scenario.SKILLS_ONLY;
  else if (isShort) return Scenario.SHORT_NO_MATCH;
  else return Scenario.LONG_NO_MATCH;
}

// === Template Building ===
function buildShortNoMatchHint(rules) {
  const templates = rules.injection_templates || {};
  const templateConfig = templates.short_no_match || {};
  return (
    templateConfig.template ||
    'Short prompt - review conversation context. If continuing established work ' +
      '(e.g., "proceed", "go ahead"), maintain the current approach including any ' +
      'active subagent delegation. For new implementation tasks, delegate to a specialized subagent.'
  );
}

function buildLongNoMatchHint(rules) {
  const templates = rules.injection_templates || {};
  const templateConfig = templates.long_no_match || {};
  return (
    templateConfig.template ||
    'No specific agent/skill match found. If this involves implementation (code, commands, ' +
      'file changes), consider delegating to an appropriate subagent - review available agents ' +
      'via Task(subagent_type=...). Respond directly for informational requests.'
  );
}

function buildAgentsOnlyHint(result, rules) {
  const templates = rules.injection_templates || {};

  const templateConfig = result.hasProjectMatches
    ? templates.project_agents_only || templates.agents_only || {}
    : templates.agents_only || {};

  const agentLines = [];
  for (const agent of result.matchedAgents.slice(0, 3)) {
    const name = agent.name || '';
    const purpose = agent.purpose || '';
    if (result.projectMatchedAgents.includes(name)) {
      agentLines.push(`  - ${name}: ${purpose} [PROJECT-SPECIFIC]`);
    } else {
      agentLines.push(`  - ${name}: ${purpose}`);
    }
  }
  const agentList = agentLines.join('\n');

  const defaultTemplate = result.hasProjectMatches
    ? 'Project-configured match. Delegate implementation to one of these subagents:\n' +
      '{agent_list}\n\n' +
      'You are an orchestrator. Implementation (code, commands, file changes) belongs in subagents.\n\n' +
      'Respond directly only if this is clearly a mismatch, or for clarifying questions and factual lookups.'
    : 'Delegate implementation to one of these subagents:\n' +
      '{agent_list}\n\n' +
      'You are an orchestrator. Implementation (code, commands, file changes) belongs in subagents.\n\n' +
      'Respond directly only for: clarifying questions, factual lookups, or pure conversation.';

  const template = templateConfig.template || defaultTemplate;
  return template.split('{agent_list}').join(agentList);
}

function buildSkillsOnlyHint(result, rules) {
  const templates = rules.injection_templates || {};

  const templateConfig = result.hasProjectMatches
    ? templates.project_skills_only || templates.skills_only || {}
    : templates.skills_only || {};

  const skillParts = [];
  for (const skill of result.matchedSkills.slice(0, 3)) {
    if (result.projectMatchedSkills.includes(skill)) skillParts.push(`${skill} [PROJECT]`);
    else skillParts.push(skill);
  }
  const skillList = skillParts.join(', ');

  const defaultTemplate = result.hasProjectMatches
    ? 'Project-configured skill(s): {skill_list}\n\n' +
      'Invoke with: Skill(skill="[skill-name]")\n\n' +
      'If delegating to a subagent, instruct them to invoke the skill and report back.\n\n' +
      'Skip only if this is clearly a mismatch.'
    : 'Use these skill(s) for this request: {skill_list}\n\n' +
      'Invoke with: Skill(skill="[skill-name]")\n\n' +
      'If delegating to a subagent, instruct them to invoke the skill and report back.';

  const template = templateConfig.template || defaultTemplate;
  return template.split('{skill_list}').join(skillList);
}

function buildAgentsAndSkillsHint(result, rules) {
  const templates = rules.injection_templates || {};

  const templateConfig = result.hasProjectMatches
    ? templates.project_agents_and_skills || templates.agents_and_skills || {}
    : templates.agents_and_skills || {};

  // Format agent list with project markers
  const agentLines = [];
  for (const agent of result.matchedAgents.slice(0, 3)) {
    const name = agent.name || '';
    const purpose = agent.purpose || '';
    if (result.projectMatchedAgents.includes(name)) {
      agentLines.push(`  - ${name}: ${purpose} [PROJECT-SPECIFIC]`);
    } else {
      agentLines.push(`  - ${name}: ${purpose}`);
    }
  }
  const agentList = agentLines.join('\n');

  // Format skill list with project markers
  const skillParts = [];
  for (const skill of result.matchedSkills.slice(0, 3)) {
    if (result.projectMatchedSkills.includes(skill)) skillParts.push(`${skill} [PROJECT]`);
    else skillParts.push(skill);
  }
  const skillList = skillParts.join(', ');

  const defaultTemplate = result.hasProjectMatches
    ? 'Project-configured match. Delegate to one of these subagents:\n' +
      '{agent_list}\n\n' +
      'Pass these skills to the subagent: {skill_list}\n\n' +
      'Append to your Task prompt: "Use the Skill tool to invoke [skill-name]. Report which skill(s) you used."\n\n' +
      'Skip delegation only if this is clearly a mismatch or purely informational.'
    : 'Delegate to one of these subagents:\n' +
      '{agent_list}\n\n' +
      'Pass these skills to the subagent: {skill_list}\n\n' +
      'Append to your Task prompt: "Use the Skill tool to invoke [skill-name]. Report which skill(s) you used."\n\n' +
      'Skip delegation ONLY if this is a purely informational request with no implementation.';

  const template = templateConfig.template || defaultTemplate;
  return template.split('{agent_list}').join(agentList).split('{skill_list}').join(skillList);
}

function buildHint(scenario, result, rules) {
  if (scenario === Scenario.SHORT_NO_MATCH) return buildShortNoMatchHint(rules);
  else if (scenario === Scenario.LONG_NO_MATCH) return buildLongNoMatchHint(rules);
  else if (scenario === Scenario.AGENTS_ONLY) return buildAgentsOnlyHint(result, rules);
  else if (scenario === Scenario.SKILLS_ONLY) return buildSkillsOnlyHint(result, rules);
  else if (scenario === Scenario.AGENTS_AND_SKILLS) return buildAgentsAndSkillsHint(result, rules);
  else return buildLongNoMatchHint(rules);
}

// === Phrase Layer (additive; never modifies router-rules.json) ===
function loadPhrases(config) {
  const envDisabled = process.env[PHRASES_DISABLE_ENV] === '1';
  const cfgDisabled = config && config.phrasesDisable === true;
  if (envDisabled || cfgDisabled) return null;
  const p = (process.env.ROUTER_PHRASES_PATH || (config && config.phrasesPath)) || getDefaultPhrasesPath();
  try {
    const data = JSON.parse(fs.readFileSync(path.normalize(p), 'utf8'));
    return data && isObj(data.phrases) ? data : null;
  } catch {
    return null;
  }
}

function matchPhrases(prompt, registry) {
  // One entry per skill (deduped by skill name); when several phrases hit the
  // same skill the longest wins as the label. Sorted by skill name, tie-break
  // by first-match position in the prompt (stable) — the plan Step 4 contract.
  if (!registry || !registry.phrases) return [];
  const norm = normalizeText(prompt);
  const best = new Map(); // skill -> { phrase, command, source, pos }
  for (const [phrase, bindingsFor] of Object.entries(registry.phrases)) {
    const pos = norm.indexOf(phrase);
    if (pos === -1) continue;
    for (const b of bindingsFor || []) {
      const cur = best.get(b.skill);
      if (!cur || phrase.length > cur.phrase.length ||
          (phrase.length === cur.phrase.length && pos < cur.pos)) {
        best.set(b.skill, { phrase, command: b.command, source: b.source, pos });
      }
    }
  }
  return [...best.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].pos - b[1].pos)
    .map(([skill, m]) => ({ phrase: m.phrase, skill, command: m.command, source: m.source }));
}

function buildPhraseBlock(matches) {
  const lines = ['Ensemble behaviors matching this request:'];
  for (const m of matches) {
    lines.push(`- "${m.phrase}" \u2192 skill ${m.skill}` + (m.command ? ` \u2192 run ${m.command}` : ''));
  }
  if (matches.some((m) => /^\/ensemble:/.test(m.command || ''))) {
    lines.push('');
    lines.push(
      'In pi/omp runtimes, invoke these as /ensemble-<cmd> (hyphen form) — the colon form above is for Claude-family runtimes.',
    );
  }
  lines.push('');
  lines.push('These are suggestions. Act on one only if it fits what the user actually asked for.');
  return lines.join('\n');
}

// === Output ===
function buildOutput(result, rules, config, matches) {
  const scenario = determineScenario(result, config);
  let hint = buildHint(scenario, result, rules);

  if (matches && matches.length) {
    hint = buildPhraseBlock(matches) + '\n\n' + hint;
  }

  logDebug(
    config,
    `Scenario: ${scenario}, project_matches: ${result.hasProjectMatches}, hint length: ${hint.length} chars`,
  );

  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: hint,
    },
  };
}

// === Main Entry Point ===
function main(rawInput) {
  const startTime = Date.now();

  const config = loadConfig();
  logDebug(config, 'Router starting');

  try {
    const inputData = readInput(rawInput);
    const prompt = inputData.prompt || '';
    const cwd = inputData.cwd || '';

    logDebug(config, `Received prompt (${prompt.length} chars, ${countWords(prompt)} words)`);
    logDebug(config, `Working directory: ${cwd}`);

    if (!prompt) {
      logDebug(config, 'Empty prompt, using short_no_match template');
      const globalRules = loadGlobalRules(config);
      if (globalRules) {
        const hint = buildShortNoMatchHint(globalRules);
        writeOutput({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: hint } });
      } else {
        writeOutput({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
      }
      process.exit(0);
    }

    const globalRules = loadGlobalRules(config);
    if (globalRules === null || !validateRules(globalRules)) {
      logDebug(config, `Failed to load global rules from ${config.rulesPath}`);
      writeOutput({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
      process.exit(0);
    }

    if (config.strictValidation) {
      const [valid, validationErrors] = validateRulesStructure(globalRules);
      if (!valid) {
        for (const err of validationErrors) logDebug(config, `Rules validation warning: ${err}`);
        // Graceful degradation: log warnings but continue.
      }
    }

    const projectRules = loadProjectRules(config, inputData);
    if (projectRules) logDebug(config, `Found project rules at ${cwd}/${PROJECT_RULES_PATH}`);

    const [mergedRules, projectAgents, projectSkills] = mergeRules(globalRules, projectRules);

    logDebug(
      config,
      `Loaded rules: ${Object.keys(mergedRules.agent_categories || {}).length} categories, ` +
        `${Object.keys(mergedRules.skills || {}).length} skills, ` +
        `${projectAgents.size} project agents, ${projectSkills.size} project skills`,
    );

    const result = analyzePrompt(prompt, mergedRules, projectAgents, projectSkills, config);

    logDebug(
      config,
      `Matches: agents=${JSON.stringify(result.matchedAgents.map((a) => a.name))}, ` +
        `skills=${JSON.stringify(result.matchedSkills)}, ` +
        `project_matches=${result.hasProjectMatches}`,
    );

    // Phrase layer (additive, exception-safe).
    let matches = [];
    try {
      const registry = loadPhrases(config);
      if (registry) matches = matchPhrases(prompt, registry);
    } catch {
      matches = [];
    }

    const output = buildOutput(result, mergedRules, config, matches);
    writeOutput(output);

    const elapsedMs = Date.now() - startTime;
    logDebug(config, `Router completed in ${elapsedMs.toFixed(1)}ms`);
  } catch (e) {
    logError(`Unexpected error: ${e && e.constructor ? e.constructor.name : 'Error'}: ${e && e.message ? e.message : e}`);
    writeOutput({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
  }

  process.exit(0);
}

module.exports = {
  Scenario,
  loadConfig,
  readInput,
  writeOutput,
  loadRulesFile,
  loadGlobalRules,
  loadProjectRules,
  mergeRules,
  validateRules,
  validateRulesStructure,
  normalizeText,
  countWords,
  matchAgentCategories,
  matchSkills,
  analyzePrompt,
  determineScenario,
  buildShortNoMatchHint,
  buildLongNoMatchHint,
  buildAgentsOnlyHint,
  buildSkillsOnlyHint,
  buildAgentsAndSkillsHint,
  buildHint,
  buildOutput,
  loadPhrases,
  matchPhrases,
  buildPhraseBlock,
  main,
  // helpers exported for tests
  pyWordBoundarySearch,
};

if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  process.stdin.on('end', () => main(data));
  process.stdin.on('error', () => main(''));
}
