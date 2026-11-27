'use strict';

/**
 * Shared parser for task sub-state representations.
 *
 * Supported formats:
 *   - br-comment:  status:<state> <key>:<value> [<key>:<value>...]
 *   - git-trailer: Key: Value lines, including a Status: <state> trailer
 *
 * Returns a normalized shape:
 *   { state: string, metadata: Record<string,string> }
 */

const GIT_TRAILER_KEY_MAP = {
  Status: null,
  Assigned: 'assigned',
  Builder: 'builder',
  Architect: 'architect',
  Reviewer: 'reviewer',
  Advisor: 'advisor',
  Qa: 'qa',
  QA: 'qa',
  Pm: 'pm',
  PM: 'pm',
  Verdict: 'verdict',
  Reason: 'reason',
  Files: 'files',
  Lead: 'lead',
  Clarification: 'clarification',
};

function decodeMetadataValue(key, rawValue) {
  if (key === 'reason' || key === 'clarification') {
    return decodeURIComponent(rawValue);
  }
  return rawValue;
}

function parseBrComment(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return null;
  }

  const lines = rawText.split('\n');

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    const statusIdx = line.indexOf('status:');
    if (statusIdx === -1) continue;

    const statusPart = line.substring(statusIdx);
    if (!statusPart.startsWith('status:')) continue;

    const tokens = statusPart.split(/\s+/);
    const state = tokens[0].replace('status:', '');
    if (!state) continue;

    const metadata = {};
    for (let j = 1; j < tokens.length; j++) {
      const colonIdx = tokens[j].indexOf(':');
      if (colonIdx === -1) continue;
      const key = tokens[j].substring(0, colonIdx);
      const rawValue = tokens[j].substring(colonIdx + 1);
      if (!key || rawValue === undefined) continue;
      metadata[key] = decodeMetadataValue(key, rawValue);
    }

    return { state, metadata };
  }

  return null;
}

function parseGitTrailer(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return null;
  }

  const lines = rawText.split('\n');
  let lastStatusIndex = -1;
  let lastState = null;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^Status:\s*(.+)$/);
    if (match) {
      lastStatusIndex = i;
      lastState = match[1].trim();
    }
  }

  if (lastStatusIndex === -1 || !lastState) {
    return null;
  }

  const metadata = {};
  for (let i = lastStatusIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) {
      continue;
    }

    const rawKey = match[1];
    const rawValue = match[2];
    if (rawKey === 'Status') {
      break;
    }

    const mappedKey = GIT_TRAILER_KEY_MAP[rawKey];
    if (!mappedKey) {
      continue;
    }

    metadata[mappedKey] = decodeMetadataValue(mappedKey, rawValue);
  }

  return { state: lastState, metadata };
}

function parseSubState(rawText, format = 'br-comment') {
  if (format === 'br-comment') {
    return parseBrComment(rawText);
  }

  if (format === 'git-trailer') {
    return parseGitTrailer(rawText);
  }

  throw new Error(`Unsupported parseSubState format: ${format}`);
}

module.exports = {
  parseSubState,
  parseBrComment,
  parseGitTrailer,
};
