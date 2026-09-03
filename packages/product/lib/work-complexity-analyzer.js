'use strict';

const DEPTHS = {
  simple: { depth: 'Simple', score: 2, path: ['fix-issue'] },
  medium: { depth: 'Medium', score: 5, path: ['create-prd', 'create-trd'] },
  complex: { depth: 'Complex', score: 8, path: ['create-prd', 'refine-prd', 'create-trd', 'refine-trd'] }
};

const LEVEL_POINTS = {
  low: 0,
  uncertain: 0,
  medium: 1,
  high: 2
};

class WorkComplexityInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkComplexityInputError';
    this.code = 'EMPTY_DESCRIPTION';
  }
}

function normalizeDepth(depth) {
  if (depth == null || depth === '') return null;
  const normalized = String(depth).trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(DEPTHS, normalized)) {
    throw new WorkComplexityInputError(`Invalid planning depth '${depth}'. Use simple, medium, or complex.`);
  }
  return normalized;
}

function classificationForDepth(depth) {
  const normalized = normalizeDepth(depth);
  if (!normalized) return null;
  const result = DEPTHS[normalized];
  return { score: result.score, depth: result.depth, path: [...result.path] };
}

function classificationForScore(score) {
  const bounded = clampScore(score);
  if (bounded <= 3) return { score: bounded, depth: 'Simple', path: ['fix-issue'] };
  if (bounded <= 6) return { score: bounded, depth: 'Medium', path: ['create-prd', 'create-trd'] };
  return { score: bounded, depth: 'Complex', path: ['create-prd', 'refine-prd', 'create-trd', 'refine-trd'] };
}

function clampScore(score) {
  return Math.max(1, Math.min(10, Math.round(score)));
}

function collectEvidence(text, patterns) {
  const evidence = [];
  for (const { label, pattern } of patterns) {
    if (pattern.test(text)) evidence.push(label);
  }
  return [...new Set(evidence)];
}

function factor(level, evidence) {
  return { level, evidence };
}

function detectScope(text) {
  const high = collectEvidence(text, [
    { label: 'multiple features', pattern: /\b(multiple|many|several)\s+(features?|capabilities|flows?|workflows?)\b/i },
    { label: 'multiple workflows', pattern: /\b(multiple|many|several)\s+(workflows?|pipelines?)\b|\b(end[- ]to[- ]end|full pipeline)\b/i },
    { label: 'multiple packages', pattern: /\b(multiple|many|several)\s+(packages?|modules?|workspaces?)\b|\b(monorepo)\b/i },
    { label: 'multiple user roles', pattern: /\b(multiple|many|several)\s+(developers?|pms?|operators?|admins?|users?|roles?|stakeholders?)\b|\b(developer,\s*PM,\s*and\s*operator|PM\s+and\s+QA)\b/i }
  ]);
  const medium = collectEvidence(text, [
    { label: 'new feature', pattern: /\b(feature|command|entrypoint|workflow|route|routing|screen|page)\b/i },
    { label: 'behavior change', pattern: /\b(add|create|introduce|support|implement|enable|change)\b/i }
  ]);
  const low = collectEvidence(text, [
    { label: 'isolated bug', pattern: /\b(bug|fix|typo|one-line|small|isolated|single)\b/i },
    { label: 'single command', pattern: /\bsingle\s+(command|endpoint|file|case)\b/i }
  ]);

  if (high.length >= 2) return factor('high', high);
  if (high.length === 1 || medium.length >= 2) return factor('medium', [...high, ...medium]);
  if (low.length > 0) return factor('low', low);
  if (medium.length === 1) return factor('medium', medium);
  return factor('uncertain', []);
}

function detectDependencies(text) {
  const high = collectEvidence(text, [
    { label: 'integration', pattern: /\b(integration|integrate|third[- ]party|api|service|webhook|provider)\b/i },
    { label: 'shared library', pattern: /\b(shared|library|lib|module|package)\b/i },
    { label: 'generated artifacts', pattern: /\b(generated|regenerate|artifact|markdown|manifest)\b/i },
    { label: 'Foreman phases', pattern: /\b(foreman|phase|phases|run artifact)\b/i },
    { label: 'command entrypoints', pattern: /\b(commands?|cli|entrypoints?)\b/i },
    { label: 'database/schema', pattern: /\b(database|schema|migration|queue|cache)\b/i }
  ]);
  if (high.length >= 2) return factor('high', high);
  if (high.length === 1) return factor('medium', high);
  return factor('low', []);
}

function detectRisk(text) {
  const evidence = collectEvidence(text, [
    { label: 'security', pattern: /\b(security|auth|permission|secret|credential|token|compliance)\b/i },
    { label: 'data loss', pattern: /\b(data loss|delete|destructive|irreversible|rollback|migration)\b/i },
    { label: 'production impact', pattern: /\b(production|prod|customer-facing|user-visible|outage|incident)\b/i },
    { label: 'automation', pattern: /\b(automation|auto-|automatic|scheduler|background|pipeline)\b/i },
    { label: 'planning route changes', pattern: /\b(route|routing|classification|override|approval|gate)\b/i }
  ]);
  const ambiguous = collectEvidence(text, [
    { label: 'ambiguous risk context', pattern: /\b(maybe|unknown|unclear|risky|might|could)\b/i }
  ]);
  if (evidence.length >= 2) return factor('high', evidence);
  if (evidence.length === 1) return factor('medium', evidence);
  if (ambiguous.length > 0) return factor('uncertain', ambiguous);
  return factor('low', []);
}

function detectTeamSize(text) {
  const high = collectEvidence(text, [
    { label: 'multi-team', pattern: /\b(multi[- ]team|multiple teams|cross[- ]functional|stakeholders?)\b/i },
    { label: 'PM review', pattern: /\b(pm|product manager)\b/i },
    { label: 'QA review', pattern: /\b(qa|quality assurance)\b/i },
    { label: 'review approval', pattern: /\b(review|approval)\b/i },
    { label: 'enterprise rollout', pattern: /\b(enterprise|rollout|organization|company-wide)\b/i }
  ]);
  const low = collectEvidence(text, [
    { label: 'solo maintainer', pattern: /\b(solo|single maintainer|one developer|personal)\b/i }
  ]);
  if (high.length >= 2) return factor('high', high);
  if (high.length === 1) return factor('medium', high);
  if (low.length > 0) return factor('low', low);
  return factor('uncertain', []);
}

function severeUplift(text) {
  const matches = text.match(/\b(security|data loss|irreversible|production|outage|destructive|compliance|automation)\b/gi) || [];
  return Math.min(3, new Set(matches.map((item) => item.toLowerCase())).size);
}

function baseAnalysis(description) {
  const factors = {
    scope: detectScope(description),
    dependencies: detectDependencies(description),
    risk: detectRisk(description),
    teamSize: detectTeamSize(description)
  };
  const factorPoints = Object.values(factors).reduce((sum, item) => sum + LEVEL_POINTS[item.level], 0);
  const uplift = severeUplift(description);
  const score = clampScore(1 + factorPoints + uplift);
  return { ...classificationForScore(score), factors };
}

function analyzeWorkComplexity(input) {
  const options = typeof input === 'string' ? { description: input } : { ...(input || {}) };
  const description = String(options.description || '').trim();
  if (!description) {
    throw new WorkComplexityInputError('Work description is required before complexity analysis can select a planning path.');
  }

  const overrideDepth = normalizeDepth(options.overrideDepth);
  const configDefaultDepth = normalizeDepth(options.config && options.config.defaultDepth);
  const configAuto = options.config && Object.prototype.hasOwnProperty.call(options.config, 'autoComplexity')
    ? options.config.autoComplexity !== false
    : true;
  const disabled = options.disableAuto === true || configAuto === false;

  const original = disabled ? null : baseAnalysis(description);
  let finalClassification;
  if (disabled) {
    finalClassification = classificationForDepth(overrideDepth || configDefaultDepth || 'medium');
  } else if (overrideDepth) {
    finalClassification = classificationForDepth(overrideDepth);
  } else {
    finalClassification = original;
  }

  const factors = original ? original.factors : {
    scope: factor('uncertain', []),
    dependencies: factor('uncertain', []),
    risk: factor('uncertain', []),
    teamSize: factor('uncertain', [])
  };
  const uncertainty = Object.entries(factors)
    .filter(([, value]) => value.level === 'uncertain')
    .map(([name, value]) => value.evidence.length ? `${name}: ${value.evidence.join(', ')}` : `${name}: no explicit evidence found`);

  const result = {
    score: finalClassification.score,
    depth: finalClassification.depth,
    path: finalClassification.path,
    factors,
    rationale: buildRationale(finalClassification, factors, disabled),
    uncertainty,
    overrideApplied: Boolean(overrideDepth) || disabled,
    disabled
  };
  if (!disabled && overrideDepth) {
    result.originalClassification = {
      score: original.score,
      depth: original.depth,
      path: original.path
    };
  }
  return result;
}

function buildRationale(classification, factors, disabled) {
  if (disabled) {
    return `Auto complexity disabled; using manual ${classification.depth} depth and ${classification.path.join(' -> ')} path.`;
  }
  const summary = Object.entries(factors)
    .map(([name, value]) => `${name}=${value.level}${value.evidence.length ? ` (${value.evidence.join('; ')})` : ''}`)
    .join(', ');
  return `Score ${classification.score}/10 maps to ${classification.depth}; factors: ${summary}.`;
}

function renderAnalysisBlock(analysis) {
  const lines = [
    'Complexity analysis',
    `Score: ${analysis.score}/10`,
    `Depth: ${analysis.depth}`,
    `Path: ${analysis.path.join(' -> ')}`,
    `Override applied: ${analysis.overrideApplied ? 'yes' : 'no'}`,
    `Auto disabled: ${analysis.disabled ? 'yes' : 'no'}`,
    `Rationale: ${analysis.rationale}`
  ];
  if (analysis.originalClassification) {
    lines.push(`Original classification: ${analysis.originalClassification.score}/10 ${analysis.originalClassification.depth} (${analysis.originalClassification.path.join(' -> ')})`);
  }
  if (analysis.uncertainty.length) {
    lines.push(`Uncertainty: ${analysis.uncertainty.join('; ')}`);
  }
  return lines.join('\n');
}

module.exports = {
  WorkComplexityInputError,
  analyzeWorkComplexity,
  classificationForScore,
  classificationForDepth,
  renderAnalysisBlock
};
