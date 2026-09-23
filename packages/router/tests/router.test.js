#!/usr/bin/env node
'use strict';

/*
Jest port of packages/router/tests/test_router.py (107 cases) — Node cutover,
part of the Ensemble-as-Behaviors plan (Step 6).
Each Python test class is one describe block here, in the same order.
*/

const fs = require('fs');
const os = require('os');
const path = require('path');

const router = require('../hooks/router.js');
const {
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
} = router;

// === Fixtures (pytest fixture equivalents) ===

function sampleRules() {
  return {
    version: '1.0.0',
    agent_categories: {
      development: {
        description: 'Code implementation',
        triggers: ['implement', 'code', 'build', 'create feature', 'frontend', 'backend'],
        agents: [
          { name: 'frontend-developer', purpose: 'UI development', tools: ['Read', 'Write'] },
          { name: 'backend-developer', purpose: 'Server-side logic', tools: ['Read', 'Write'] },
        ],
      },
      quality_testing: {
        description: 'Testing and review',
        triggers: ['test', 'review', 'debug', 'fix bug'],
        agents: [
          { name: 'test-runner', purpose: 'Run tests', tools: ['Bash'] },
          { name: 'code-reviewer', purpose: 'Review code', tools: ['Read'] },
        ],
      },
    },
    skills: {
      jest: {
        triggers: ['jest', 'javascript test', 'typescript test'],
        patterns: ['run.*jest', 'jest.*test'],
        purpose: 'Jest testing',
      },
      vercel: {
        triggers: ['vercel', 'nextjs', 'next.js'],
        patterns: ['deploy.*vercel', 'vercel.*issue', 'vercel.*problem'],
        purpose: 'Vercel deployments',
      },
    },
    injection_templates: {
      short_no_match: {
        description: 'Short prompts with no matches - context-aware continuation',
        template:
          'Short prompt - review conversation context. If continuing established work (e.g., "proceed", "go ahead"), maintain the current approach including any active subagent delegation. For new implementation tasks, delegate to a specialized subagent.',
      },
      agents_only: {
        description: 'When agents match but no skills - directive delegation',
        template:
          'Delegate implementation to one of these subagents:\n{agent_list}\n\nYou are an orchestrator. Implementation (code, commands, file changes) belongs in subagents.\n\nRespond directly only for: clarifying questions, factual lookups, or pure conversation.',
      },
      agents_and_skills: {
        description: 'When both agents and skills match - directive delegation with skill passing',
        template:
          'Delegate to one of these subagents:\n{agent_list}\n\nPass these skills to the subagent: {skill_list}\n\nAppend to your Task prompt: "Use the Skill tool to invoke [skill-name]. Report which skill(s) you used."\n\nSkip delegation ONLY if this is a purely informational request with no implementation.',
      },
      skills_only: {
        description: 'When skills match but no agents - direct skill instruction',
        template:
          'Use these skill(s) for this request: {skill_list}\n\nInvoke with: Skill(skill="[skill-name]")\n\nIf delegating to a subagent, instruct them to invoke the skill and report back.',
      },
      long_no_match: {
        description: 'Longer prompts with no matches - reminder with decision framework',
        template:
          'No specific agent/skill match found. If this involves implementation (code, commands, file changes), consider delegating to an appropriate subagent - review available agents via Task(subagent_type=...). Respond directly for informational requests.',
      },
      project_agents_only: {
        description: 'Project-specific agents matched',
        template:
          'Project-configured match. Delegate implementation to one of these subagents:\n{agent_list}\n\nYou are an orchestrator. Implementation (code, commands, file changes) belongs in subagents.\n\nRespond directly only if this is clearly a mismatch, or for clarifying questions and factual lookups.',
      },
      project_skills_only: {
        description: 'Project-specific skills matched',
        template:
          'Project-configured skill(s): {skill_list}\n\nInvoke with: Skill(skill="[skill-name]")\n\nIf delegating to a subagent, instruct them to invoke the skill and report back.\n\nSkip only if this is clearly a mismatch.',
      },
      project_agents_and_skills: {
        description: 'Project-specific agents and skills matched',
        template:
          'Project-configured match. Delegate to one of these subagents:\n{agent_list}\n\nPass these skills to the subagent: {skill_list}\n\nAppend to your Task prompt: "Use the Skill tool to invoke [skill-name]. Report which skill(s) you used."\n\nSkip delegation only if this is clearly a mismatch or purely informational.',
      },
    },
  };
}

function sampleProjectRules() {
  return {
    version: '1.0.0',
    project_name: 'test-project',
    triggers: {
      development: ['nextjs', 'react'],
    },
    skill_mappings: {
      nextjs: ['vercel', 'jest'],
    },
    project_context: {
      primary_language: 'TypeScript',
      framework: 'Next.js',
    },
  };
}

function testConfig() {
  return {
    rulesPath: './router-rules.json',
    debug: false,
    shortThreshold: 5,
    cwd: '/test/project',
  };
}

// MatchResult fixture (python dataclass kwargs -> JS object with defaults)
function MatchResult(init = {}) {
  return {
    matchedCategories: init.matchedCategories || [],
    matchedAgents: init.matchedAgents || [],
    matchedSkills: init.matchedSkills || [],
    matchCount: init.matchCount !== undefined ? init.matchCount : 0,
    wordCount: init.wordCount !== undefined ? init.wordCount : 0,
    projectMatchedAgents: init.projectMatchedAgents || [],
    projectMatchedSkills: init.projectMatchedSkills || [],
    hasProjectMatches: init.hasProjectMatches || false,
  };
}

// Env helpers
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function withCleanEnv(fn) {
  const keys = ['ROUTER_RULES_PATH', 'ROUTER_DEBUG', 'ROUTER_SHORT_THRESHOLD', 'ROUTER_STRICT_VALIDATION', 'ROUTER_CUSTOM_DISCOVERY'];
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    return fn();
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

function tmpJsonFile(obj) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-')), 'rules.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function tmpTextFile(text) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-')), 'bad.json');
  fs.writeFileSync(p, text);
  return p;
}

const S = new Set();

// === Configuration Tests ===
describe('LoadConfig', () => {
  test('default values', () => {
    withCleanEnv(() => {
      const config = loadConfig();
      // Default path is now relative to script location: ../lib/router-rules.json
      expect(config.rulesPath.endsWith('lib/router-rules.json')).toBe(true);
      expect(config.debug).toBe(false);
      expect(config.shortThreshold).toBe(5);
    });
  });

  test('custom rules path', () => {
    withEnv({ ROUTER_RULES_PATH: '/custom/path.json' }, () => {
      const config = loadConfig();
      expect(config.rulesPath).toBe('/custom/path.json');
    });
  });

  test('debug enabled', () => {
    withEnv({ ROUTER_DEBUG: '1' }, () => {
      expect(loadConfig().debug).toBe(true);
    });
  });

  test('debug enabled true string', () => {
    withEnv({ ROUTER_DEBUG: 'true' }, () => {
      expect(loadConfig().debug).toBe(true);
    });
  });

  test('debug disabled', () => {
    withEnv({ ROUTER_DEBUG: '0' }, () => {
      expect(loadConfig().debug).toBe(false);
    });
  });

  test('custom short threshold', () => {
    withEnv({ ROUTER_SHORT_THRESHOLD: '10' }, () => {
      expect(loadConfig().shortThreshold).toBe(10);
    });
  });

  test('invalid short threshold', () => {
    withEnv({ ROUTER_SHORT_THRESHOLD: 'invalid' }, () => {
      expect(loadConfig().shortThreshold).toBe(5);
    });
  });

  test('custom discovery enabled default', () => {
    withCleanEnv(() => {
      expect(loadConfig().customDiscovery).toBe(true);
    });
  });

  test('custom discovery disabled', () => {
    withEnv({ ROUTER_CUSTOM_DISCOVERY: '0' }, () => {
      expect(loadConfig().customDiscovery).toBe(false);
    });
  });

  test('custom discovery disabled false string', () => {
    withEnv({ ROUTER_CUSTOM_DISCOVERY: 'false' }, () => {
      expect(loadConfig().customDiscovery).toBe(false);
    });
  });

  test('strict validation enabled default', () => {
    withCleanEnv(() => {
      process.env.ROUTER_RULES_PATH = '/tmp/rules.json';
      expect(loadConfig().strictValidation).toBe(true);
    });
  });

  test('strict validation disabled zero', () => {
    withEnv({ ROUTER_STRICT_VALIDATION: '0' }, () => {
      process.env.ROUTER_RULES_PATH = '/tmp/rules.json';
      expect(loadConfig().strictValidation).toBe(false);
    });
  });

  test('strict validation disabled false', () => {
    withEnv({ ROUTER_STRICT_VALIDATION: 'false' }, () => {
      process.env.ROUTER_RULES_PATH = '/tmp/rules.json';
      expect(loadConfig().strictValidation).toBe(false);
    });
  });
});

// === Input/Output Tests ===
describe('ReadInput', () => {
  test('valid json', () => {
    expect(readInput('{"prompt": "test"}')).toEqual({ prompt: 'test' });
  });

  test('empty input', () => {
    expect(readInput('')).toEqual({});
  });

  test('invalid json', () => {
    expect(readInput('not json')).toEqual({});
  });
});

describe('WriteOutput', () => {
  test('writes json', () => {
    let out = '';
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { out += chunk; return true; };
    try {
      writeOutput({ test: 'value' });
    } finally {
      process.stdout.write = orig;
    }
    expect(JSON.parse(out)).toEqual({ test: 'value' });
  });
});

// === Rules Loading Tests ===
describe('LoadRulesFile', () => {
  test('load valid rules', () => {
    const rules = sampleRules();
    const p = tmpJsonFile(rules);
    const result = loadRulesFile(p);
    expect(result).not.toBeNull();
    expect(result.agent_categories).toBeDefined();
    expect(result.skills).toBeDefined();
  });

  test('missing file', () => {
    expect(loadRulesFile('/nonexistent/path.json')).toBeNull();
  });

  test('invalid json', () => {
    const p = tmpTextFile('not valid json');
    expect(loadRulesFile(p)).toBeNull();
  });
});

describe('ValidateRules', () => {
  test('valid rules', () => {
    expect(validateRules(sampleRules())).toBe(true);
  });

  test('missing agent categories', () => {
    const rules = sampleRules();
    delete rules.agent_categories;
    expect(validateRules(rules)).toBe(false);
  });

  test('missing skills', () => {
    const rules = sampleRules();
    delete rules.skills;
    expect(validateRules(rules)).toBe(false);
  });

  test('missing injection templates', () => {
    const rules = sampleRules();
    delete rules.injection_templates;
    expect(validateRules(rules)).toBe(false);
  });
});

describe('ValidateRulesStructure', () => {
  test('valid rules pass', () => {
    const [valid, errors] = validateRulesStructure(sampleRules());
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });

  test('missing agent_categories key', () => {
    const [valid, errors] = validateRulesStructure({ skills: {}, injection_templates: {} });
    expect(valid).toBe(false);
    expect(errors).toContain('Missing required key: agent_categories');
  });

  test('missing skills key', () => {
    const [valid, errors] = validateRulesStructure({ agent_categories: {}, injection_templates: {} });
    expect(valid).toBe(false);
    expect(errors).toContain('Missing required key: skills');
  });

  test('missing injection_templates key', () => {
    const [valid, errors] = validateRulesStructure({ agent_categories: {}, skills: {} });
    expect(valid).toBe(false);
    expect(errors).toContain('Missing required key: injection_templates');
  });

  test('agent_categories not dict', () => {
    const [valid, errors] = validateRulesStructure({ agent_categories: [], skills: {}, injection_templates: {} });
    expect(valid).toBe(false);
    expect(errors).toContain('agent_categories must be an object');
  });

  test('agent_categories not dict string', () => {
    const [valid, errors] = validateRulesStructure({ agent_categories: 'not-a-dict', skills: {}, injection_templates: {} });
    expect(valid).toBe(false);
    expect(errors).toContain('agent_categories must be an object');
  });

  test('category not dict', () => {
    const rules = { agent_categories: { development: 'not-a-dict' }, skills: {}, injection_templates: {} };
    const [valid, errors] = validateRulesStructure(rules);
    expect(valid).toBe(false);
    expect(errors).toContain('agent_categories.development must be an object');
  });

  test('category missing triggers', () => {
    const rules = { agent_categories: { development: { agents: [] } }, skills: {}, injection_templates: {} };
    const [valid, errors] = validateRulesStructure(rules);
    expect(valid).toBe(false);
    expect(errors).toContain("agent_categories.development missing 'triggers'");
  });

  test('category missing agents', () => {
    const rules = { agent_categories: { development: { triggers: [] } }, skills: {}, injection_templates: {} };
    const [valid, errors] = validateRulesStructure(rules);
    expect(valid).toBe(false);
    expect(errors).toContain("agent_categories.development missing 'agents'");
  });

  test('category triggers not array', () => {
    const rules = { agent_categories: { development: { triggers: 'not-an-array', agents: [] } }, skills: {}, injection_templates: {} };
    const [valid, errors] = validateRulesStructure(rules);
    expect(valid).toBe(false);
    expect(errors).toContain('agent_categories.development.triggers must be an array');
  });

  test('category agents not array', () => {
    const rules = { agent_categories: { development: { triggers: [], agents: 'not-an-array' } }, skills: {}, injection_templates: {} };
    const [valid, errors] = validateRulesStructure(rules);
    expect(valid).toBe(false);
    expect(errors).toContain('agent_categories.development.agents must be an array');
  });

  test('skills not dict', () => {
    const [valid, errors] = validateRulesStructure({ agent_categories: {}, skills: [], injection_templates: {} });
    expect(valid).toBe(false);
    expect(errors).toContain('skills must be an object');
  });

  test('skill not dict', () => {
    const rules = { agent_categories: {}, skills: { jest: 'not-a-dict' }, injection_templates: {} };
    const [valid, errors] = validateRulesStructure(rules);
    expect(valid).toBe(false);
    expect(errors).toContain('skills.jest must be an object');
  });

  test('skill missing triggers', () => {
    const rules = { agent_categories: {}, skills: { jest: { purpose: 'testing' } }, injection_templates: {} };
    const [valid, errors] = validateRulesStructure(rules);
    expect(valid).toBe(false);
    expect(errors).toContain("skills.jest missing 'triggers'");
  });

  test('skill triggers not array', () => {
    const rules = { agent_categories: {}, skills: { jest: { triggers: 'not-an-array', purpose: 'testing' } }, injection_templates: {} };
    const [valid, errors] = validateRulesStructure(rules);
    expect(valid).toBe(false);
    expect(errors).toContain('skills.jest.triggers must be an array');
  });

  test('injection_templates not dict', () => {
    const [valid, errors] = validateRulesStructure({ agent_categories: {}, skills: {}, injection_templates: [] });
    expect(valid).toBe(false);
    expect(errors).toContain('injection_templates must be an object');
  });

  test('multiple errors collected', () => {
    const rules = {
      agent_categories: { dev: { triggers: 'bad' } },
      skills: { jest: { purpose: 'test' } },
      injection_templates: {},
    };
    const [valid, errors] = validateRulesStructure(rules);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  test('empty but valid structure', () => {
    const [valid, errors] = validateRulesStructure({ agent_categories: {}, skills: {}, injection_templates: {} });
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });
});

describe('MergeRules', () => {
  test('no project rules', () => {
    const rules = sampleRules();
    const [merged, projectAgents, projectSkills] = mergeRules(rules, null);
    expect(merged).toEqual(rules);
    expect(projectAgents.size).toBe(0);
    expect(projectSkills.size).toBe(0);
  });

  test('merge skill mappings', () => {
    const [merged, projectAgents, projectSkills] = mergeRules(sampleRules(), sampleProjectRules());
    expect(projectSkills).toContain('vercel');
    expect(projectSkills).toContain('jest');
  });

  test('merge custom agents', () => {
    const globalRules = {
      agent_categories: {
        utility: {
          description: 'Utility agents',
          triggers: ['scaffold', 'generate'],
          agents: [{ name: 'file-creator', purpose: 'Create files', tools: ['Write'] }],
        },
      },
      skills: {},
      injection_templates: {},
    };
    const projectRules = {
      custom_agents: {
        'my-custom-agent': {
          description: 'Custom project automation',
          tools: ['Read', 'Write', 'Bash'],
          triggers: ['my-custom', 'custom automation'],
        },
      },
    };
    const [merged, projectAgents] = mergeRules(globalRules, projectRules);
    const utilityAgents = merged.agent_categories.utility.agents;
    const names = utilityAgents.map((a) => a.name);
    expect(names).toContain('my-custom-agent');
    const custom = utilityAgents.find((a) => a.name === 'my-custom-agent');
    expect(custom.purpose).toBe('Custom project automation');
    expect(custom.tools).toEqual(['Read', 'Write', 'Bash']);
    const triggers = merged.agent_categories.utility.triggers;
    expect(triggers).toContain('my-custom');
    expect(triggers).toContain('custom automation');
    expect(projectAgents).toContain('my-custom-agent');
  });

  test('merge custom agents no utility category', () => {
    const globalRules = {
      agent_categories: { development: { description: 'Development agents', triggers: ['code'], agents: [] } },
      skills: {},
      injection_templates: {},
    };
    const projectRules = {
      custom_agents: { 'my-custom-agent': { description: 'Custom project automation', tools: ['Read', 'Write'], triggers: ['my-custom'] } },
    };
    // Should not throw.
    const [merged, projectAgents] = mergeRules(globalRules, projectRules);
    expect(merged.agent_categories.utility).toBeUndefined();
    expect(projectAgents).not.toContain('my-custom-agent');
  });

  test('merge custom agents malformed data', () => {
    const globalRules = {
      agent_categories: { utility: { description: 'Utility agents', triggers: [], agents: [] } },
      skills: {},
      injection_templates: {},
    };
    const projectRules = {
      custom_agents: {
        'valid-agent': { description: 'Valid agent', tools: ['Read'], triggers: ['valid'] },
        'invalid-agent': 'not a dict',
      },
    };
    const [merged, projectAgents] = mergeRules(globalRules, projectRules);
    const names = merged.agent_categories.utility.agents.map((a) => a.name);
    expect(names).toContain('valid-agent');
    expect(names).not.toContain('invalid-agent');
  });

  test('merge custom agents empty dict', () => {
    const [, projectAgents] = mergeRules(sampleRules(), { custom_agents: {} });
    expect(projectAgents.size).toBe(0);
  });

  test('merge custom agents missing description', () => {
    const globalRules = {
      agent_categories: { utility: { description: 'Utility agents', triggers: [], agents: [] } },
      skills: {},
      injection_templates: {},
    };
    const projectRules = { custom_agents: { 'my-agent': { tools: ['Read'] } } };
    const [merged] = mergeRules(globalRules, projectRules);
    const agent = merged.agent_categories.utility.agents.find((a) => a.name === 'my-agent');
    expect(agent).toBeDefined();
    expect(agent.purpose).toBe('Custom project agent');
  });

  test('merge custom agents missing tools', () => {
    const globalRules = {
      agent_categories: { utility: { description: 'Utility agents', triggers: [], agents: [] } },
      skills: {},
      injection_templates: {},
    };
    const projectRules = { custom_agents: { 'my-agent': { description: 'Test agent' } } };
    const [merged] = mergeRules(globalRules, projectRules);
    const agent = merged.agent_categories.utility.agents.find((a) => a.name === 'my-agent');
    expect(agent).toBeDefined();
    expect(agent.tools).toEqual([]);
  });

  test('merge custom agents triggers not list', () => {
    const globalRules = {
      agent_categories: { utility: { description: 'Utility agents', triggers: [], agents: [] } },
      skills: {},
      injection_templates: {},
    };
    const projectRules = { custom_agents: { 'my-agent': { description: 'Test', triggers: 'not-a-list' } } };
    const [, projectAgents] = mergeRules(globalRules, projectRules);
    expect(projectAgents).toContain('my-agent');
  });
});

// === Word Count Tests ===
describe('CountWords', () => {
  test('empty string', () => expect(countWords('')).toBe(0));
  test('single word', () => expect(countWords('hello')).toBe(1));
  test('multiple words', () => {
    expect(countWords('hello world')).toBe(2);
    expect(countWords('one two three four five')).toBe(5);
  });
  test('extra whitespace', () => expect(countWords('hello  world')).toBe(2));
});

// === Category Matching Tests ===
describe('MatchAgentCategories', () => {
  test('single trigger match', () => {
    const rules = sampleRules();
    const [matches] = matchAgentCategories('Implement the feature', rules, S);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0][0]).toBe('development');
    expect(matches[0][1]).toBeGreaterThanOrEqual(1);
  });

  test('multiple trigger match', () => {
    const rules = sampleRules();
    const [matches] = matchAgentCategories('Build a frontend component', rules, S);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0][1]).toBeGreaterThanOrEqual(2);
  });

  test('no matches', () => {
    const rules = sampleRules();
    const [matches] = matchAgentCategories('Hello world', rules, S);
    expect(matches.length).toBe(0);
  });

  test('sorted by match count', () => {
    const rules = sampleRules();
    const [matches] = matchAgentCategories('Test and review the code', rules, S);
    if (matches.length >= 2) {
      expect(matches[0][1]).toBeGreaterThanOrEqual(matches[1][1]);
    }
  });
});

// === Skill Matching Tests ===
describe('MatchSkills', () => {
  test('trigger match', () => {
    const rules = sampleRules();
    const [matches] = matchSkills('Run jest tests', rules, S, testConfig());
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0][0]).toBe('jest');
  });

  test('pattern match', () => {
    const rules = sampleRules();
    const [matches] = matchSkills('Deploy to vercel now', rules, S, testConfig());
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.map((m) => m[0])).toContain('vercel');
  });

  test('no matches', () => {
    const rules = sampleRules();
    const [matches] = matchSkills('Random unrelated text', rules, S, testConfig());
    expect(matches.length).toBe(0);
  });

  test('multiple skill matches', () => {
    const rules = sampleRules();
    const [matches] = matchSkills('Run jest tests then deploy to vercel', rules, S, testConfig());
    const names = matches.map((m) => m[0]);
    expect(names).toContain('jest');
    expect(names).toContain('vercel');
  });
});

// === Analyze Prompt Tests ===
describe('AnalyzePrompt', () => {
  test('matched categories', () => {
    const rules = sampleRules();
    const result = analyzePrompt('Implement the backend API', rules, S, S, testConfig());
    expect(result.matchedCategories).toContain('development');
  });

  test('matched agents', () => {
    const rules = sampleRules();
    const result = analyzePrompt('Build the frontend', rules, S, S, testConfig());
    const names = result.matchedAgents.map((a) => a.name);
    expect(names.includes('frontend-developer') || names.includes('backend-developer')).toBe(true);
  });

  test('matched skills', () => {
    const rules = sampleRules();
    const result = analyzePrompt('Run jest tests', rules, S, S, testConfig());
    expect(result.matchedSkills).toContain('jest');
  });

  test('deduplication', () => {
    const rules = sampleRules();
    const result = analyzePrompt('Implement frontend backend code build', rules, S, S, testConfig());
    const names = result.matchedAgents.map((a) => a.name);
    expect(names.length).toBe(new Set(names).size);
  });

  test('word count tracked', () => {
    const rules = sampleRules();
    const result = analyzePrompt('one two three', rules, S, S, testConfig());
    expect(result.wordCount).toBe(3);
  });

  test('project matches tracked', () => {
    const rules = sampleRules();
    const result = analyzePrompt('Build the frontend', rules, new Set(['frontend-developer']), S, testConfig());
    expect(result.projectMatchedAgents).toContain('frontend-developer');
    expect(result.hasProjectMatches).toBe(true);
  });
});

// === Scenario Determination Tests ===
describe('DetermineScenario', () => {
  test('short no match', () => {
    expect(determineScenario(MatchResult({ wordCount: 2, matchCount: 0 }), testConfig())).toBe(Scenario.SHORT_NO_MATCH);
  });

  test('long no match', () => {
    expect(determineScenario(MatchResult({ wordCount: 10, matchCount: 0 }), testConfig())).toBe(Scenario.LONG_NO_MATCH);
  });

  test('agents only', () => {
    const result = MatchResult({ wordCount: 10, matchedAgents: [{ name: 'test-runner', purpose: 'Run tests' }], matchCount: 1 });
    expect(determineScenario(result, testConfig())).toBe(Scenario.AGENTS_ONLY);
  });

  test('skills only', () => {
    const result = MatchResult({ wordCount: 10, matchedSkills: ['jest'], matchCount: 1 });
    expect(determineScenario(result, testConfig())).toBe(Scenario.SKILLS_ONLY);
  });

  test('agents and skills', () => {
    const result = MatchResult({
      wordCount: 10,
      matchedAgents: [{ name: 'test-runner', purpose: 'Run tests' }],
      matchedSkills: ['jest'],
      matchCount: 2,
    });
    expect(determineScenario(result, testConfig())).toBe(Scenario.AGENTS_AND_SKILLS);
  });

  test('short threshold boundary', () => {
    // Exactly at threshold (5 words) should be considered long.
    expect(determineScenario(MatchResult({ wordCount: 5, matchCount: 0 }), testConfig())).toBe(Scenario.LONG_NO_MATCH);
    // Below threshold (4 words) should be short.
    expect(determineScenario(MatchResult({ wordCount: 4, matchCount: 0 }), testConfig())).toBe(Scenario.SHORT_NO_MATCH);
  });
});

// === Template Building Tests ===
describe('BuildShortNoMatchHint', () => {
  test('generates hint', () => {
    const hint = buildShortNoMatchHint(sampleRules());
    expect(hint).toContain('Short prompt');
    expect(hint).toContain('conversation context');
    expect(hint.toLowerCase()).toContain('delegate');
  });
});

describe('BuildLongNoMatchHint', () => {
  test('generates hint', () => {
    const hint = buildLongNoMatchHint(sampleRules());
    expect(hint).toContain('No specific agent/skill match');
    expect(hint.toLowerCase()).toContain('delegating');
  });
});

describe('BuildAgentsOnlyHint', () => {
  test('generates hint', () => {
    const result = MatchResult({ matchedAgents: [{ name: 'frontend-developer', purpose: 'UI development' }] });
    const hint = buildAgentsOnlyHint(result, sampleRules());
    expect(hint).toContain('frontend-developer');
    expect(hint).toContain('Delegate implementation');
    expect(hint).toContain('orchestrator');
  });

  test('project specific hint', () => {
    const result = MatchResult({
      matchedAgents: [{ name: 'frontend-developer', purpose: 'UI development' }],
      projectMatchedAgents: ['frontend-developer'],
      hasProjectMatches: true,
    });
    const hint = buildAgentsOnlyHint(result, sampleRules());
    expect(hint).toContain('Project-configured');
    expect(hint).toContain('clearly a mismatch');
  });
});

describe('BuildSkillsOnlyHint', () => {
  test('generates hint', () => {
    const result = MatchResult({ matchedSkills: ['jest', 'vercel'] });
    const hint = buildSkillsOnlyHint(result, sampleRules());
    expect(hint).toContain('skill(s)');
    expect(hint).toContain('jest');
    expect(hint).toContain('vercel');
  });

  test('project specific hint', () => {
    const result = MatchResult({
      matchedSkills: ['jest', 'vercel'],
      projectMatchedSkills: ['jest'],
      hasProjectMatches: true,
    });
    const hint = buildSkillsOnlyHint(result, sampleRules());
    expect(hint).toContain('Project-configured');
    expect(hint).toContain('clearly a mismatch');
  });
});

describe('BuildAgentsAndSkillsHint', () => {
  test('generates hint', () => {
    const result = MatchResult({
      matchedAgents: [{ name: 'frontend-developer', purpose: 'UI development' }],
      matchedSkills: ['jest', 'vercel'],
    });
    const hint = buildAgentsAndSkillsHint(result, sampleRules());
    expect(hint).toContain('frontend-developer');
    expect(hint).toContain('jest');
  });

  test('project specific hint', () => {
    const result = MatchResult({
      matchedAgents: [{ name: 'frontend-developer', purpose: 'UI development' }],
      matchedSkills: ['jest', 'vercel'],
      projectMatchedAgents: ['frontend-developer'],
      projectMatchedSkills: ['jest'],
      hasProjectMatches: true,
    });
    const hint = buildAgentsAndSkillsHint(result, sampleRules());
    expect(hint).toContain('Project-configured');
    expect(hint).toContain('clearly a mismatch');
    expect(hint).toContain('frontend-developer');
    expect(hint).toContain('jest');
    expect(hint).toContain('Task prompt');
  });
});

describe('BuildHint', () => {
  test('dispatches to correct builder', () => {
    const rules = sampleRules();
    const result = MatchResult({ matchedSkills: ['jest'] });
    expect(buildHint(Scenario.SHORT_NO_MATCH, result, rules)).toContain('Short prompt');
    expect(buildHint(Scenario.LONG_NO_MATCH, result, rules)).toContain('No specific agent/skill match');
    expect(buildHint(Scenario.SKILLS_ONLY, result, rules)).toContain('skill(s)');
  });
});

describe('BuildOutput', () => {
  test('returns hook specific output', () => {
    const result = MatchResult({ wordCount: 10, matchCount: 0 });
    const output = buildOutput(result, sampleRules(), testConfig());
    expect(output.hookSpecificOutput).toBeDefined();
  });

  test('short no match hint', () => {
    const result = MatchResult({ wordCount: 2, matchCount: 0 });
    const output = buildOutput(result, sampleRules(), testConfig());
    expect(output.hookSpecificOutput.additionalContext).toBeDefined();
    expect(output.hookSpecificOutput.additionalContext).toContain('Short prompt');
  });

  test('agents only hint', () => {
    const result = MatchResult({
      wordCount: 10,
      matchedAgents: [{ name: 'frontend-developer', purpose: 'UI' }],
      matchCount: 1,
    });
    const output = buildOutput(result, sampleRules(), testConfig());
    expect(output.hookSpecificOutput.additionalContext).toContain('frontend-developer');
  });

  test('agents and skills hint', () => {
    const result = MatchResult({
      wordCount: 10,
      matchedAgents: [{ name: 'frontend-developer', purpose: 'UI' }],
      matchedSkills: ['jest'],
      matchCount: 2,
    });
    const output = buildOutput(result, sampleRules(), testConfig());
    const hint = output.hookSpecificOutput.additionalContext;
    expect(hint).toContain('frontend-developer');
    expect(hint).toContain('jest');
    expect(hint).toContain('Task prompt');
  });

  test('output format', () => {
    const result = MatchResult({ wordCount: 10, matchCount: 0 });
    const output = buildOutput(result, sampleRules(), testConfig());
    expect(output.hookSpecificOutput).toBeDefined();
    expect(output.hookSpecificOutput.hookEventName).toBeDefined();
    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  });
});

// === Integration Tests ===
describe('Integration', () => {
  test('full flow agents match', () => {
    const rules = sampleRules();
    const result = analyzePrompt('Implement the frontend feature', rules, S, S, testConfig());
    expect(result.matchCount).toBeGreaterThan(0);
    expect(result.matchedCategories).toContain('development');
    const names = result.matchedAgents.map((a) => a.name);
    expect(names.includes('frontend-developer') || names.includes('backend-developer')).toBe(true);
    const output = buildOutput(result, rules, testConfig());
    expect(output.hookSpecificOutput.additionalContext).toContain('frontend-developer');
  });

  test('full flow skills match', () => {
    const rules = sampleRules();
    const result = analyzePrompt('Run the jest tests please', rules, S, S, testConfig());
    expect(result.matchedSkills).toContain('jest');
    const output = buildOutput(result, rules, testConfig());
    expect(output.hookSpecificOutput.additionalContext).toContain('jest');
  });

  test('full flow short no match', () => {
    const rules = sampleRules();
    const prompt = 'thanks';
    const result = analyzePrompt(prompt, rules, S, S, testConfig());
    const output = buildOutput(result, rules, testConfig());
    expect(result.wordCount).toBeLessThan(testConfig().shortThreshold);
    expect(result.matchCount).toBe(0);
    expect(output.hookSpecificOutput.additionalContext).toContain('Short prompt');
  });

  test('full flow long no match', () => {
    const rules = sampleRules();
    const prompt = 'Random text that matches nothing in particular here';
    const result = analyzePrompt(prompt, rules, S, S, testConfig());
    const output = buildOutput(result, rules, testConfig());
    expect(result.wordCount).toBeGreaterThanOrEqual(testConfig().shortThreshold);
    expect(result.matchCount).toBe(0);
    expect(output.hookSpecificOutput.additionalContext).toContain('No specific agent/skill match');
  });

  test('question prompts not blocked', () => {
    const rules = sampleRules();
    const prompts = [
      'What is Python?',
      'How does React work?',
      'Can you help me with this?',
      'Why is it failing?',
    ];
    for (const prompt of prompts) {
      const result = analyzePrompt(prompt, rules, S, S, testConfig());
      const output = buildOutput(result, rules, testConfig());
      // All prompts should get a hint (no blocking).
      expect(output.hookSpecificOutput.additionalContext).toBeDefined();
    }
  });
});

// === Edge Case Tests ===
describe('EdgeCases', () => {
  test('empty prompt', () => {
    const rules = sampleRules();
    const result = analyzePrompt('', rules, S, S, testConfig());
    expect(result.matchCount).toBe(0);
  });

  test('case insensitive matching', () => {
    const rules = sampleRules();
    const result1 = analyzePrompt('IMPLEMENT THE FEATURE', rules, S, S, testConfig());
    const result2 = analyzePrompt('implement the feature', rules, S, S, testConfig());
    expect(result1.matchCount).toBe(result2.matchCount);
  });

  test('prompt with special characters', () => {
    const rules = sampleRules();
    const result = analyzePrompt('!!!@@@###$$$%%%^^^&&&', rules, S, S, testConfig());
    expect(result.matchedCategories.length).toBe(0);
    expect(result.matchCount).toBe(0);
  });

  test('unicode text', () => {
    const rules = sampleRules();
    const result = analyzePrompt('Implement feature 测试 🎉', rules, S, S, testConfig());
    expect(result.matchedCategories.length).toBeGreaterThanOrEqual(1);
  });

  test('long prompt', () => {
    const rules = sampleRules();
    const longPrompt = 'Implement ' + 'word '.repeat(1000);
    const result = analyzePrompt(longPrompt, rules, S, S, testConfig());
    expect(result).not.toBeNull(); // Should not crash.
  });
});

// === Normalize Text Tests ===
describe('NormalizeText', () => {
  test('lowercase', () => expect(normalizeText('HELLO')).toBe('hello'));
  test('strip whitespace', () => expect(normalizeText('  hello  ')).toBe('hello'));
  test('combined', () => expect(normalizeText('  HELLO WORLD  ')).toBe('hello world'));
});

// === Scenario Enum Tests ===
describe('ScenarioEnum', () => {
  test('all scenarios defined', () => {
    expect(Scenario.SHORT_NO_MATCH).toBeDefined();
    expect(Scenario.AGENTS_ONLY).toBeDefined();
    expect(Scenario.AGENTS_AND_SKILLS).toBeDefined();
    expect(Scenario.SKILLS_ONLY).toBeDefined();
    expect(Scenario.LONG_NO_MATCH).toBeDefined();
  });

  test('scenario values', () => {
    expect(Scenario.SHORT_NO_MATCH).toBe('short_no_match');
    expect(Scenario.AGENTS_ONLY).toBe('agents_only');
    expect(Scenario.AGENTS_AND_SKILLS).toBe('agents_and_skills');
    expect(Scenario.SKILLS_ONLY).toBe('skills_only');
    expect(Scenario.LONG_NO_MATCH).toBe('long_no_match');
  });
});

// === Match Result Tests ===
describe('MatchResult', () => {
  test('default values', () => {
    const result = MatchResult();
    expect(result.matchedCategories).toEqual([]);
    expect(result.matchedAgents).toEqual([]);
    expect(result.matchedSkills).toEqual([]);
    expect(result.matchCount).toBe(0);
    expect(result.wordCount).toBe(0);
    expect(result.projectMatchedAgents).toEqual([]);
    expect(result.projectMatchedSkills).toEqual([]);
    expect(result.hasProjectMatches).toBe(false);
  });

  test('with project matches', () => {
    const result = MatchResult({ projectMatchedAgents: ['frontend-developer'], hasProjectMatches: true });
    expect(result.hasProjectMatches).toBe(true);
  });
});
