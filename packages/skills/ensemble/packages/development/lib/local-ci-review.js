'use strict';

/**
 * Local-CI review author classification and block decision (REQ-006).
 *
 * Pure: no network, no side effects. The caller supplies already-fetched
 * reviews, each shaped like
 *   { author: { login, type }, state, submittedAt }
 * (`user` is accepted in place of `author`, as the GitHub REST API names it).
 *
 * FAIL CLOSED toward blocking: an author is a Bot ONLY when the supplied
 * account `type` is exactly "Bot" (letter case ignored). The login/name is
 * never consulted for classification. A missing, blank, non-text or
 * unrecognised type is a human, so an unknown can never silently pass.
 *
 * Bot reviews never block and nothing waits on them (a pending bot review
 * is simply ignored). A human blocks when their LATEST decisive review
 * (APPROVED, CHANGES_REQUESTED or DISMISSED) is CHANGES_REQUESTED.
 */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

const DECISIVE_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const REVIEW_STATES = new Set(['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED', 'DISMISSED', 'PENDING']);

/**
 * A review's state, upper-cased, when one of the five GitHub states
 * ("changes requested" spellings tolerated); otherwise null.
 */
function reviewState(review) {
  if (typeof review.state !== 'string') return null;
  const state = review.state.trim().toUpperCase();
  if (REVIEW_STATES.has(state)) return state;
  return state.replace(/[^A-Z]/g, '') === 'CHANGESREQUESTED' ? 'CHANGES_REQUESTED' : null;
}

function submittedTime(review) {
  if (typeof review.submittedAt !== 'string' || review.submittedAt.trim() === '') return null;
  const time = Date.parse(review.submittedAt);
  return Number.isNaN(time) ? null : time;
}

function authorOf(review) {
  if (isObject(review.author)) return review.author;
  if (isObject(review.user)) return review.user;
  return null;
}

/** Bot or User from the account `type` only; anything unreadable is User. */
function kindOfType(type) {
  return typeof type === 'string' && type.trim().toLowerCase() === 'bot' ? 'Bot' : 'User';
}

/**
 * Classify each review's author from the reported account type only.
 * Returns one entry per input review, in order:
 *   { login, kind: 'Bot'|'User', typeReadable, review }
 * A non-object review is a User with login null and typeReadable false.
 */
function classifyReviews(reviews) {
  if (!Array.isArray(reviews)) return [];
  return Array.from(reviews, (review) => {
    const author = isObject(review) ? authorOf(review) : null;
    const type = author ? author.type : undefined;
    const typeReadable = isText(type) && ['bot', 'user'].includes(type.trim().toLowerCase());
    return {
      login: author && isText(author.login) ? author.login : null,
      kind: kindOfType(type),
      typeReadable,
      review,
    };
  });
}

/** The reviewer's latest decisive review; ties and missing times: later listed wins. */
function standingReview(entries) {
  let standing;
  for (const entry of entries) {
    if (!isObject(entry.review) || !DECISIVE_STATES.has(reviewState(entry.review))) continue;
    if (standing === undefined) {
      standing = entry;
      continue;
    }
    const time = submittedTime(entry.review);
    const standingTime = submittedTime(standing.review);
    if (time === null || standingTime === null || time >= standingTime) standing = entry;
  }
  return standing;
}

/**
 * Decide whether reviews block a merge.
 * Returns { blocked, reviewers, reasons, waiting:false }; `reviewers` names
 * every blocking human, `waiting` is always false (nothing waits on bots).
 */
function decideBlock(reviews) {
  const reviewers = [];
  const reasons = [];
  const block = (name, reason) => {
    reviewers.push(name);
    reasons.push(reason);
  };

  if (!Array.isArray(reviews)) {
    block('(unknown reviewer)', 'reviews is not an array; treated as a blocking unknown');
    return { blocked: true, reviewers, reasons, waiting: false };
  }

  const classified = classifyReviews(reviews);
  const byReviewer = new Map();
  classified.forEach((entry, index) => {
    // A review with no readable login cannot be superseded by anyone else's.
    const key = entry.login === null ? `\u0000unnamed:${index}` : entry.login.toLowerCase();
    if (!byReviewer.has(key)) byReviewer.set(key, []);
    byReviewer.get(key).push(entry);
  });

  for (const entries of byReviewer.values()) {
    // Bot only when EVERY review by this login reports type Bot.
    if (entries.every((entry) => entry.kind === 'Bot')) continue;
    const name = entries.find((entry) => entry.login !== null)?.login ?? '(unknown reviewer)';
    if (entries.some((entry) => !isObject(entry.review) || reviewState(entry.review) === null)) {
      block(name, `${name}: a review has a missing or unrecognised state; treated as blocking`);
      continue;
    }
    const standing = standingReview(entries);
    if (standing !== undefined && reviewState(standing.review) === 'CHANGES_REQUESTED') {
      block(name, `${name} requested changes and has not approved or been dismissed`);
    }
  }

  return { blocked: reviewers.length > 0, reviewers, reasons, waiting: false };
}

module.exports = { classifyReviews, decideBlock };
