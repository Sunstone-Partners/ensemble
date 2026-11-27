'use strict';

/**
 * Parser-backed quickstart.md generator.
 *
 * Consumes deterministic trd-parser output. It never scans TRD markdown for
 * acceptance criteria; source AC ids come from task.validatesAcs.
 */

function uniqueSortedPreserveOrder(items) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function taskOrder(parsedTrd) {
  const tasksById = parsedTrd && parsedTrd.tasksById && typeof parsedTrd.tasksById === 'object'
    ? parsedTrd.tasksById
    : {};
  const phases = Array.isArray(parsedTrd && parsedTrd.phases) ? parsedTrd.phases : [];
  const ordered = [];
  const seen = new Set();

  for (const phase of phases) {
    for (const id of Array.isArray(phase.taskIds) ? phase.taskIds : []) {
      if (tasksById[id] && !seen.has(id)) {
        seen.add(id);
        ordered.push(tasksById[id]);
      }
    }
  }

  for (const id of Object.keys(tasksById)) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(tasksById[id]);
    }
  }

  return ordered;
}

function normalizeAcContext(acId, parsedTrd) {
  const prdContext = parsedTrd && parsedTrd.prdContext ? parsedTrd.prdContext : null;
  const acs = prdContext && prdContext.acs && typeof prdContext.acs === 'object' ? prdContext.acs : {};
  const ctx = acs[acId] || acs[String(acId).toUpperCase()] || null;
  if (!ctx) return null;
  return {
    text: ctx.text || '',
    given: ctx.given || '',
    when: ctx.when || '',
    then: ctx.then || '',
    reqId: ctx.reqId || '',
  };
}

function trimTaskDescription(description) {
  return String(description || '')
    .replace(/^\s*-\s*\[[ xX]\]\s+\*\*(TRD-[A-Za-z0-9-]+)\*\*\s*/i, '')
    .replace(/`\s*`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Collect unique parsed PRD AC ids from TRD task.validateAcs in parser order.
 * @param {Object} parsedTrd deterministic parse output, optionally carrying prdContext
 * @returns {Array<Object>}
 */
function collectAcceptanceCriteria(parsedTrd) {
  const collected = [];
  const byAc = new Map();

  for (const task of taskOrder(parsedTrd || {})) {
    const acIds = Array.isArray(task.validatesAcs) ? task.validatesAcs : [];
    for (const rawAcId of acIds) {
      const acId = String(rawAcId || '').trim().toUpperCase();
      if (!acId) continue;
      const context = normalizeAcContext(acId, parsedTrd || {});
      const reqIds = uniqueSortedPreserveOrder([
        ...(Array.isArray(task.satisfies) ? task.satisfies : []),
        context && context.reqId,
      ]);

      if (byAc.has(acId)) {
        const existing = byAc.get(acId);
        existing.relatedTrdTaskIds = uniqueSortedPreserveOrder([
          ...(existing.relatedTrdTaskIds || []),
          task.id,
        ]);
        existing.relatedReqIds = uniqueSortedPreserveOrder([
          ...(existing.relatedReqIds || []),
          ...reqIds,
        ]);
        continue;
      }

      const sourceDescription = context && context.text
        ? context.text
        : trimTaskDescription(task.description || task.rawMarkdown || '');
      const entry = {
        id: acId,
        acId,
        taskId: task.id,
        relatedTrdTaskId: task.id,
        relatedTrdTaskIds: task.id ? [task.id] : [],
        relatedReqIds: reqIds,
        sourceDescription,
        given: context ? context.given : '',
        when: context ? context.when : '',
        then: context ? context.then : '',
        order: collected.length + 1,
      };
      byAc.set(acId, entry);
      collected.push(entry);
    }
  }

  return collected;
}

function needsClarification(ac) {
  const expected = String(ac && ac.then ? ac.then : '').trim();
  if (!expected) return true;
  return /^(success|works|done|complete|valid|handled)$/i.test(expected);
}

function sentenceOrFallback(value, fallback) {
  const text = String(value || '').trim();
  return text || fallback;
}

/**
 * Convert AC sources to one manual scenario per AC.
 * @param {Array<Object>} acSources
 * @returns {Array<Object>}
 */
function buildScenarios(acSources) {
  return (Array.isArray(acSources) ? acSources : []).map((ac, index) => {
    const clarification = needsClarification(ac)
      ? '[NEEDS CLARIFICATION: What observable result proves this AC passed?]'
      : '';
    const actions = [
      sentenceOrFallback(ac.when, `Perform the behavior described by ${ac.acId}.`),
    ];
    if (clarification) {
      actions.push('Record any missing product/setup context before marking pass.');
    }

    return {
      id: `QS-${String(index + 1).padStart(3, '0')}`,
      sourceAcId: ac.acId,
      sourceDescription: ac.sourceDescription || '',
      trdTaskId: ac.relatedTrdTaskId || ac.taskId || '',
      trdTaskIds: ac.relatedTrdTaskIds || [],
      reqIds: ac.relatedReqIds || [],
      setup: sentenceOrFallback(ac.given, `Use the implemented TRD behavior associated with ${ac.acId}.`),
      actions,
      expectedResult: sentenceOrFallback(ac.then, 'Observable pass condition is not specified.'),
      clarification,
      needsClarification: !!clarification,
    };
  });
}

/**
 * Validate AC -> scenario coverage.
 * @param {Array<Object>} acSources
 * @param {Array<Object>} scenarios
 * @returns {Object}
 */
function validateCoverage(acSources, scenarios) {
  const sources = Array.isArray(acSources) ? acSources : [];
  const generated = Array.isArray(scenarios) ? scenarios : [];
  if (sources.length === 0) {
    throw new Error('No parsed acceptance criteria found; quickstart.md was not written as success.');
  }

  const sourceIds = sources.map((ac) => ac.acId || ac.id).filter(Boolean);
  const mapped = new Set(generated.map((s) => s.sourceAcId).filter(Boolean));
  const unmappedAcIds = sourceIds.filter((id) => !mapped.has(id));
  const mappedAcCount = sourceIds.length - unmappedAcIds.length;
  const coveragePercent = sourceIds.length === 0
    ? 0
    : Number(((mappedAcCount / sourceIds.length) * 100).toFixed(2));

  return {
    ok: unmappedAcIds.length === 0,
    parsedAcCount: sourceIds.length,
    scenarioCount: generated.length,
    mappedAcCount,
    unmappedAcIds,
    clarificationCount: generated.filter((s) => s.needsClarification || s.clarification).length,
    coveragePercent,
  };
}

function inlineCode(value) {
  return `\`${String(value || '').replace(/`/g, '\\`')}\``;
}

function listOrDash(values) {
  const arr = uniqueSortedPreserveOrder(values);
  return arr.length ? arr.map(inlineCode).join(', ') : '—';
}

function renderScenario(scenario) {
  const lines = [];
  lines.push(`### ${scenario.id} — ${scenario.sourceAcId}`);
  lines.push('');
  lines.push('- [ ] Execute scenario');
  lines.push('- [ ] Pass');
  lines.push('- [ ] Fail');
  lines.push('');
  lines.push(`- **Source AC:** ${inlineCode(scenario.sourceAcId)}`);
  lines.push(`- **TRD task:** ${scenario.trdTaskId ? inlineCode(scenario.trdTaskId) : '—'}`);
  lines.push(`- **Related TRD tasks:** ${listOrDash(scenario.trdTaskIds)}`);
  lines.push(`- **Related REQs:** ${listOrDash(scenario.reqIds)}`);
  if (scenario.sourceDescription) {
    lines.push(`- **Source description:** ${scenario.sourceDescription}`);
  }
  if (scenario.clarification) {
    lines.push(`- **Clarification:** ${scenario.clarification}`);
  }
  lines.push('');
  lines.push(`**Setup / Preconditions:** ${scenario.setup}`);
  lines.push('');
  lines.push('**Actions:**');
  scenario.actions.forEach((action, index) => lines.push(`${index + 1}. ${action}`));
  lines.push('');
  lines.push(`**Expected result:** ${scenario.expectedResult}`);
  lines.push('');
  return lines.join('\n');
}

/** Render final quickstart Markdown. */
function renderQuickstart({ parsedTrd, trdPath, scenarios, coverage }) {
  const title = parsedTrd && parsedTrd.title ? parsedTrd.title : 'TRD quickstart validation';
  const lines = [];
  lines.push('# Quickstart Validation Runbook');
  lines.push('');
  lines.push(`- **Source TRD:** ${trdPath || '—'}`);
  lines.push(`- **TRD title:** ${title}`);
  lines.push('- **Generation source:** deterministic `trd-cli.js parse` output');
  lines.push('');
  lines.push('## Coverage Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---:|');
  lines.push(`| Parsed AC count | ${coverage.parsedAcCount} |`);
  lines.push(`| Scenario count | ${coverage.scenarioCount} |`);
  lines.push(`| Mapped AC count | ${coverage.mappedAcCount} |`);
  lines.push(`| Unmapped AC count | ${coverage.unmappedAcIds.length} |`);
  lines.push(`| Clarification count | ${coverage.clarificationCount} |`);
  lines.push(`| Coverage percentage | ${coverage.coveragePercent}% |`);
  lines.push('');
  lines.push(`**Unmapped AC IDs:** ${coverage.unmappedAcIds.length ? coverage.unmappedAcIds.map(inlineCode).join(', ') : 'None'}`);
  lines.push('');
  lines.push('## Manual Test Scenarios');
  lines.push('');
  for (const scenario of scenarios) {
    lines.push(renderScenario(scenario));
  }
  return lines.join('\n');
}

function buildQuickstart(parsedTrd, options) {
  const opts = options || {};
  const acSources = collectAcceptanceCriteria(parsedTrd || {});
  const scenarios = buildScenarios(acSources);
  const coverage = validateCoverage(acSources, scenarios);
  if (!coverage.ok) {
    throw new Error(`Missing quickstart scenario coverage for AC IDs: ${coverage.unmappedAcIds.join(', ')}`);
  }
  const markdown = renderQuickstart({
    parsedTrd: parsedTrd || {},
    trdPath: opts.trdPath || '',
    scenarios,
    coverage,
  });
  return { markdown, scenarios, coverage };
}

module.exports = {
  collectAcceptanceCriteria,
  buildScenarios,
  validateCoverage,
  renderQuickstart,
  buildQuickstart,
};
