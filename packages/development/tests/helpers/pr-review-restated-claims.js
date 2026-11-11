'use strict';

/**
 * The review claims the restatement tests (kata tmf5) share: tests/pr-review-restated.test.js pins how the matcher scores them, and
 * tests/review-run-restated-cli.test.js raises them through the real review-run CLI.
 *
 * Four findings of one round (LOOP, CACHE, RETRY, LOCK) each have a restatement the way a delta reviewer writes one: the same defect in
 * its own words, naming the same code (identifiers are where real restatements overlap: the two measured ones of run m2-pr293-re reuse
 * the function and file names of the finding they restate). The rest are what must NOT merge: an abstract paraphrase that shares no
 * identifier (CACHE_ABSTRACT), a distinct defect on the lines of LOCK (LOCK_OTHER), a near-duplicate prior entry that makes a
 * restatement ambiguous (LOOP_TWIN) and a finding of another file (PARSE).
 *
 * Each claim cites `med/aNN.js:line`, the files of the 19-file Medium PR the CLI tests build.
 */

const claim = (id, at, said, evidence) => Object.freeze({ id, at, said, evidence });

const CLAIMS = Object.freeze({
  LOOP: claim(
    'LOOP',
    'med/a02.js:5',
    'The loop `for (let i = 0; i <= items.length; i++)` on line 5 reads `items[items.length]`, one element past the end of the list, so its last pass adds undefined and `total` becomes NaN for every non-empty input.',
    'Ran `sumOf([1, 2, 3])`: it returned NaN, and the loop body executed four times for three elements.',
  ),
  LOOP_AGAIN: claim(
    'LOOP_AGAIN',
    'med/a02.js:5',
    '`total` is NaN whenever `items` is not empty: the condition `i <= items.length` on line 5 lets the loop make one extra pass that reads past the end of `items` and adds undefined to `total`.',
    'Called `sumOf([4, 5])` and got NaN; counting the passes showed three passes for two elements.',
  ),
  LOOP_TWIN: claim(
    'LOOP_TWIN',
    'med/a02.js:4-6',
    'The total built by the loop on line 5 is wrong for non-empty lists because `i <= items.length` makes the loop read `items[items.length]`, which is undefined, and adding undefined to `total` gives NaN.',
    'Ran `sumOf([1, 2, 3])` and got NaN instead of 6.',
  ),
  CACHE: claim(
    'CACHE',
    'med/a04.js:10',
    "`cacheKey(resource)` on line 10 leaves out the tenant id, so two tenants asking for the same resource share one cache entry and the second tenant is served the first tenant's data.",
    'Read `cacheKey` and its two call sites: both tenants produce the key resource:42, and a test that fills the cache for tenant a returns that data for tenant b.',
  ),
  CACHE_AGAIN: claim(
    'CACHE_AGAIN',
    'med/a04.js:10',
    "The cache entry that `cacheKey(resource)` returns on line 10 does not include the tenant id, so a tenant asking for a resource is served the data that another tenant stored for the same resource.",
    'Traced a lookup for tenant b after tenant a filled the cache for the same resource: `cacheKey` returned one key and the cache answered with the entry tenant a wrote.',
  ),
  CACHE_ABSTRACT: claim(
    'CACHE_ABSTRACT',
    'med/a04.js:10',
    'Entries in the cache that line 10 fills are keyed by the resource alone, never by the tenant, so a request from one tenant can be answered with the cached data of another tenant.',
    'Traced a lookup for tenant b after tenant a filled the cache for the same resource: it hit the entry tenant a wrote.',
  ),
  RETRY: claim(
    'RETRY',
    'med/a06.js:20',
    '`retry()` on line 20 never backs off, so a host that is down is called again at once, in a tight loop until the attempt limit is reached, and the caller waits on every one of those calls.',
    'Stubbed the host to fail: `retry()` made five calls in under a millisecond with no delay between them.',
  ),
  RETRY_AGAIN: claim(
    'RETRY_AGAIN',
    'med/a06.js:20',
    'When the host is down, `retry()` on line 20 calls it again with no delay between attempts, so the loop is tight until the attempt limit and the caller waits on every one of those calls.',
    'Made the host fail and timed `retry()`: five calls came in under a millisecond, with no wait between attempts.',
  ),
  LOCK: claim(
    'LOCK',
    'med/a10.js:30',
    '`release()` on line 30 runs before the `write()` it protects completes, so a second writer can take the lock while the first write is still in flight and the two writes interleave.',
    'Added a delay inside `write()` and started two writers: the file ended up with the lines of both interleaved.',
  ),
  LOCK_AGAIN: claim(
    'LOCK_AGAIN',
    'med/a10.js:30',
    'While the first `write()` is still running a second writer can take the lock, because `release()` on line 30 gives the lock up before `write()` finishes, and the two writes end up interleaved in the file.',
    'Ran two writers at once against a slow `write()` and got interleaved output in the file.',
  ),
  LOCK_OTHER: claim(
    'LOCK_OTHER',
    'med/a10.js:30',
    "The error that `acquire()` raises on line 30 when the lock is already held is swallowed by the caller's catch block, so a failed acquire looks like success and the write is skipped without any message.",
    'Held the lock in another process and ran the writer: it exited with status 0 and wrote nothing.',
  ),
  DROP: claim(
    'DROP',
    'med/a10.js:60',
    'The handler drops the response when the stream closes early, so the client waits forever for the final frame of the stream.',
    'Closed the stream after the first frame: the client never received the final frame and kept waiting.',
  ),
  RETRIED: claim(
    'RETRIED',
    'med/a10.js:60',
    'The handler retries the request when the stream closes early, so the client receives the final frame of the stream twice.',
    'Closed the stream after the first frame: the client received the final frame two times.',
  ),
  PARSE: claim(
    'PARSE',
    'med/a12.js:7',
    'The parse on line 7 treats an empty string as the number zero, so a missing field is silently stored as 0 instead of being rejected as invalid input.',
    'Passed an empty field value: the record was saved with 0 and no error was raised.',
  ),
});

/** The four findings of the round the delta tests restate: LOOP, CACHE, RETRY, LOCK, each with the claim that restates it. */
const ROUND = Object.freeze([CLAIMS.LOOP, CLAIMS.CACHE, CLAIMS.RETRY, CLAIMS.LOCK]);
const RESTATEMENT = Object.freeze({
  [CLAIMS.LOOP.at]: CLAIMS.LOOP_AGAIN,
  [CLAIMS.CACHE.at]: CLAIMS.CACHE_AGAIN,
  [CLAIMS.RETRY.at]: CLAIMS.RETRY_AGAIN,
  [CLAIMS.LOCK.at]: CLAIMS.LOCK_AGAIN,
});

/** A claim as a reviewer or a verifier-round candidate writes it (what an agent's result file holds). */
const raised = (one, over = {}) => ({ locationOrLink: one.at, severity: 'important', failureMode: one.said, disposition: 'fix', evidence: one.evidence, ...over });

/** A claim as a ledger entry of a finished round holds it (the shape the matcher and the carry read). */
const entryOf = (one, id, over = {}) => ({
  id,
  source: 'reviewer-s1-a',
  locationOrLink: one.at,
  severity: 'important',
  failureMode: one.said,
  disposition: 'fix',
  evidence: one.evidence,
  verification: { outcome: 'present', reason: 'verifier-majority', tally: { real: 3, notReal: 0, expected: 3 } },
  ...over,
});

module.exports = { CLAIMS, ROUND, RESTATEMENT, raised, entryOf };
