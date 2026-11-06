'use strict';

/**
 * Disposition choices for the PR-review cycle: what the operator is asked to
 * decide about each still-undecided finding, and the data behind the final
 * merge question (docs/plans/pr-review-speedup-plan.md, section 3H).
 *
 * NO side effects, NO shell, NO network, NO file reads, NO clock. A pure
 * function over the ledger, the security lane, the vote tally and the head SHA.
 *
 * What this module guarantees, because the gate depends on it:
 *
 *   - only UNDECIDED findings are listed. A finding is decided when it is
 *     `cleared`, when it carries a resolution with full provenance for THIS
 *     head SHA, or when the votes filtered it out. A resolution without valid
 *     provenance (stale head, no `by`, ...) decides nothing: the finding is
 *     listed again and marked `staleResolution`;
 *   - a blocking finding is never offered `follow-on` (a follow-on PR cannot
 *     unblock the gate), is never defaulted to `accept`, and its `accept` is
 *     never batchable;
 *   - a SECURITY finding's `accept` is never the default, never batchable and
 *     always needs its own reason; security findings are never collapsed;
 *   - FAIL CLOSED: input this module cannot read yields `ok: false` with empty
 *     lists, never a quietly shorter list.
 */

const {
  normalizeSeverity,
  anchorOf,
  hasResolutionProvenance,
} = require('./pr-review-ledger');

/** The groups, in the order they are presented. */
const GROUPS = Object.freeze(['blocking', 'nit', 'pre-existing']);

/** The only dispositions an operator can pick. */
const CHOICE_IDS = Object.freeze(['fix-here', 'follow-on', 'accept']);

/** More than this many undecided same-file findings in a group collapse into one entry. */
const COLLAPSE_THRESHOLD = 3;

const GROUP_LABELS = Object.freeze({
  blocking: 'Blocking',
  nit: 'Nits',
  'pre-existing': 'Pre-existing',
});

const CHOICE_LABELS = Object.freeze({
  'fix-here': 'Fix on this PR',
  'follow-on': 'Fix in a follow-on PR',
  accept: 'Accept without fixing',
});

const FIX_HERE_NOTE =
  'Queued: one fix agent, one push. The head moves and any approvals reset.';
const FOLLOW_ON_NOTE = 'The bead stays open, labelled follow-on.';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** A finding id as the gate reads one: text, or a finite number. */
function hasId(finding) {
  return isText(finding.id) || Number.isFinite(finding.id);
}

/** One key per id whichever way it was written (`7` and `'7'` are the same finding). */
function keyOf(id) {
  return typeof id === 'string' ? id.trim() : String(id);
}

/** Same lenient truthiness as the vote tally's `flagged`: anything but an explicit "no". */
function flagged(value) {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return !['', 'false', 'no', 'n', '0', 'off'].includes(value.trim().toLowerCase());
  return true;
}

function failClosed(reason) {
  return { ok: false, reason, dispositionChoices: [], groups: [], mergeConfirmation: null };
}

/**
 * Security if it came through the security lane, is flagged, sits on the
 * security lane, or is Critical. Broader is the safe direction.
 */
function isSecurity(finding, fromSecurityLane) {
  if (fromSecurityLane) return true;
  if (flagged(finding.security) || flagged(finding.securityRelevant)) return true;
  if (isText(finding.lane) && finding.lane.trim().toLowerCase() === 'security') return true;
  return isText(finding.severity) && finding.severity.trim().toLowerCase() === 'critical';
}

/** The group a finding belongs to and the severity word shown for it. */
function classify(finding, security) {
  const canonical = normalizeSeverity(finding.severity);
  const severity = canonical !== null ? canonical : isText(finding.severity) ? finding.severity.trim() : 'unrecognised';
  let group;
  if (canonical === 'pre-existing') group = 'pre-existing';
  else if (canonical === 'nit' && !security) group = 'nit';
  else group = 'blocking'; // important, unrecognised, or security that is not pre-existing
  return { group, severity };
}

/** The file a finding is about, or null when it has none (then it is not collapsible). */
function fileOf(finding) {
  if (isText(finding.file)) return finding.file.trim();
  const anchor = anchorOf(finding);
  if (anchor !== null) return anchor.file;
  if (isText(finding.locationOrLink)) {
    const stripped = finding.locationOrLink.trim().replace(/:\d+(?:-\d+)?$/, '');
    if (stripped !== finding.locationOrLink.trim() && stripped !== '') return stripped;
  }
  return null;
}

function buildChoices(group, security) {
  const blocking = group === 'blocking';
  const defaultId = blocking ? 'fix-here' : 'follow-on';
  const fixHere = {
    id: 'fix-here',
    label: CHOICE_LABELS['fix-here'],
    requiresReason: false,
    batchable: true,
    default: defaultId === 'fix-here',
    note: FIX_HERE_NOTE,
  };
  const followOn = {
    id: 'follow-on',
    label: CHOICE_LABELS['follow-on'],
    requiresReason: false,
    batchable: true,
    default: defaultId === 'follow-on',
    note: FOLLOW_ON_NOTE,
  };
  const accept = {
    id: 'accept',
    label: CHOICE_LABELS.accept,
    requiresReason: true,
    // Blocking findings and security findings are decided one by one.
    batchable: !blocking && !security,
    default: false,
  };
  // A blocking finding offers no follow-on: a follow-on PR cannot unblock the gate.
  const choices = blocking ? [fixHere, accept] : [fixHere, followOn, accept];
  return { choices, default: defaultId };
}

function tallyOf(votesById, id) {
  const entry = votesById.get(keyOf(id));
  if (!entry || !isObject(entry.tally)) return null;
  const { real, notReal, abstain, expected } = entry.tally;
  return { real, notReal, abstain, expected };
}

function aggregateVotes(members) {
  const withVotes = members.filter((m) => m.votes !== null);
  if (withVotes.length === 0) return null;
  const sum = (key) => withVotes.reduce((total, m) => total + (Number(m.votes[key]) || 0), 0);
  return {
    real: sum('real'),
    notReal: sum('notReal'),
    abstain: sum('abstain'),
    expected: Math.max(...withVotes.map((m) => Number(m.votes.expected) || 0)),
  };
}

/** Intersection of the choice ids every entry allows batching on, in CHOICE_IDS order. */
function batchChoicesOf(entries) {
  return CHOICE_IDS.filter((id) =>
    entries.every((entry) => entry.choices.some((choice) => choice.id === id && choice.batchable === true)),
  );
}

/** One short human line for the merge question. */
function summarize({ openBeads, acceptedBlocking, undecidedBlocking }) {
  const accepted = acceptedBlocking.length === 0
    ? '0 blocking findings accepted'
    : `${acceptedBlocking.length} blocking finding(s) accepted (${acceptedBlocking
      .map((a) => `${a.id}: ${a.reason}`)
      .join('; ')})`;
  return `${openBeads} open bead(s); ${accepted}; ${undecidedBlocking.length} blocking finding(s) undecided`;
}

/**
 * Build the per-finding disposition choices and the merge-confirmation data.
 *
 * @param {{ledger: object[], security?: {status?: string, findings?: object[]},
 *   votes?: {ok?: boolean, findings?: object[]}, headSha: string}} input
 * @returns {{ok: boolean, reason?: string, dispositionChoices: object[],
 *   groups: object[], mergeConfirmation: object|null}}
 */
function buildDispositionChoices(input) {
  if (!isObject(input)) return failClosed('input must be an object');
  if (!Array.isArray(input.ledger)) return failClosed('ledger must be an array');
  if (!isText(input.headSha)) return failClosed('headSha is required');
  const headSha = input.headSha.trim();

  let securityFindings = [];
  if (input.security !== undefined && input.security !== null) {
    if (!isObject(input.security)) return failClosed('security must be an object');
    if (input.security.findings !== undefined) {
      if (!Array.isArray(input.security.findings)) return failClosed('security.findings must be an array');
      securityFindings = input.security.findings;
    }
  }

  // Merge the lanes; the same id in both is ONE finding and security wins.
  const merged = new Map();
  const lanes = [
    [input.ledger, false],
    [securityFindings, true],
  ];
  for (const [list, fromSecurity] of lanes) {
    for (const finding of list) {
      if (!isObject(finding)) return failClosed('every finding must be an object');
      if (!hasId(finding)) return failClosed('every finding needs an id');
      const key = keyOf(finding.id);
      const existing = merged.get(key);
      if (existing === undefined) merged.set(key, { finding, fromSecurity });
      else if (fromSecurity) merged.set(key, { finding, fromSecurity: true });
    }
  }

  const votesById = new Map();
  if (isObject(input.votes) && Array.isArray(input.votes.findings)) {
    for (const entry of input.votes.findings) {
      if (isObject(entry) && hasId(entry)) votesById.set(keyOf(entry.id), entry);
    }
  }

  const undecided = [];
  const acceptedBlocking = [];
  for (const { finding, fromSecurity } of merged.values()) {
    if (finding.cleared === true) continue;
    const security = isSecurity(finding, fromSecurity);
    const { group, severity } = classify(finding, security);
    const provenance = hasResolutionProvenance(finding, headSha);
    if (provenance) {
      if (group === 'blocking') {
        const { reason, by, at } = finding.resolution;
        acceptedBlocking.push({ id: finding.id, severity, security, reason, by, at });
      }
      continue;
    }
    const vote = votesById.get(keyOf(finding.id));
    if (vote !== undefined && vote.presented === false) continue;
    undecided.push({
      finding,
      security,
      group,
      severity,
      votes: tallyOf(votesById, finding.id),
      stale: finding.resolution !== undefined && finding.resolution !== null,
      file: fileOf(finding),
      index: undecided.length,
    });
  }

  // Order: group, then security before non-security inside blocking, then input order.
  const rank = (u) => GROUPS.indexOf(u.group) * 2 + (u.group === 'blocking' && !u.security ? 1 : 0);
  undecided.sort((a, b) => rank(a) - rank(b) || a.index - b.index);

  // Collapse: more than COLLAPSE_THRESHOLD non-security same-file findings in nit / pre-existing.
  const bucketKey = (u) => `${u.group}\u0000${u.file}`;
  const collapsible = (u) => u.group !== 'blocking' && !u.security && u.file !== null;
  const buckets = new Map();
  for (const u of undecided) {
    if (!collapsible(u)) continue;
    const key = bucketKey(u);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(u);
  }
  const collapsedKeys = new Set(
    [...buckets.entries()].filter(([, list]) => list.length > COLLAPSE_THRESHOLD).map(([key]) => key),
  );

  const entries = [];
  const emitted = new Set();
  for (const u of undecided) {
    const { choices, default: defaultId } = buildChoices(u.group, u.security);
    const key = bucketKey(u);
    if (collapsible(u) && collapsedKeys.has(key)) {
      if (emitted.has(key)) continue;
      emitted.add(key);
      const members = buckets.get(key);
      const beadIds = members.map((m) => m.finding.beadId).filter(isText);
      const entry = {
        id: `file:${u.file}`,
        collapsed: true,
        members: members.map((m) => ({ id: m.finding.id, locationOrLink: m.finding.locationOrLink })),
        file: u.file,
        severity: u.severity,
        locationOrLink: u.file,
        votes: aggregateVotes(members),
        beadId: null,
        beadIds,
        group: u.group,
        security: false,
        choices,
        default: defaultId,
        requiresReason: false,
      };
      if (members.some((m) => m.stale)) entry.staleResolution = true;
      entries.push(entry);
      continue;
    }
    const entry = {
      id: u.finding.id,
      severity: u.severity,
      locationOrLink: u.finding.locationOrLink,
      votes: u.votes,
      beadId: isText(u.finding.beadId) ? u.finding.beadId : null,
      group: u.group,
      security: u.security,
      choices,
      default: defaultId,
      requiresReason: u.group === 'blocking' || u.security,
    };
    if (u.security) entry.reasonPerFinding = true;
    if (u.stale) entry.staleResolution = true;
    entries.push(entry);
  }

  const groups = GROUPS.map((group) => {
    const inGroup = entries.filter((entry) => entry.group === group);
    return {
      group,
      label: GROUP_LABELS[group],
      ids: inGroup.map((entry) => entry.id),
      batchChoices: batchChoicesOf(inGroup),
      _size: inGroup.length,
    };
  })
    .filter((g) => g._size > 0)
    .map(({ _size, ...rest }) => rest);

  const openBeads = undecided.filter((u) => isText(u.finding.beadId)).length;
  const undecidedBlocking = entries.filter((entry) => entry.group === 'blocking').map((entry) => entry.id);
  const mergeConfirmation = {
    undecided: entries.map((entry) => entry.id),
    undecidedBlocking,
    openBeads,
    findingsWithoutBead: undecided.length - openBeads,
    acceptedBlocking,
    staleResolutions: undecided.filter((u) => u.stale).map((u) => u.finding.id),
  };
  mergeConfirmation.summary = summarize({ openBeads, acceptedBlocking, undecidedBlocking });

  return { ok: true, dispositionChoices: entries, groups, mergeConfirmation };
}

module.exports = { buildDispositionChoices, GROUPS, CHOICE_IDS, COLLAPSE_THRESHOLD };
