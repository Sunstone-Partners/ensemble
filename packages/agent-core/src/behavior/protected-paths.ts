/**
 * Classifies paths an auto-fix attempt must never write (TRD-019 / REQ-015).
 *
 * The threat this exists for is mechanical, not hypothetical: the
 * cheapest way to make a failing test pass is to edit the test. An
 * auto-fix loop that can write test files will eventually discover
 * that, and a reviewer reading only the green suite would not notice.
 * The same argument applies to the guardrails themselves, to the
 * conformance fixtures that pin behavior, and to the constitution.
 *
 * This is a mechanical path check with no model involvement, so it
 * cannot be talked out of a refusal (AC-015-2).
 */

export type ProtectedPathReason =
  | "test-file"
  | "build-config"
  | "guardrail-source"
  | "conformance-fixture"
  | "constitution";

export interface ProtectedPathVerdict {
  protected: boolean;
  reason?: ProtectedPathReason;
  detail?: string;
}

/**
 * Normalizes to forward slashes, strips any leading "./", and
 * lowercases.
 *
 * Lowercasing matters on macOS and Windows, whose filesystems are
 * case-insensitive: `Mutation-Guard.ts` and `Foo.TEST.ts` resolve to
 * the same files as their lowercase forms, so case-sensitive patterns
 * would be trivially bypassable by changing capitalisation -- exactly
 * the kind of mechanical bypass this policy exists to prevent.
 */
function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

const TEST_PATTERNS: readonly RegExp[] = [
  /(^|\/)tests?\//,
  /(^|\/)__tests__\//,
  /(^|\/)spec\//,
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
  /_test\.(py|go|rb|exs?)$/,
  /(^|\/)test_[^/]+\.py$/,
];

const GUARDRAIL_PATTERNS: readonly RegExp[] = [
  /(^|\/)mutation-guard\.ts$/,
  /(^|\/)protected-paths\.ts$/,
  /(^|\/)approval-gate\.ts$/,
  /(^|\/)workspace-snapshot\.ts$/,
  /(^|\/)behavior-loader\.ts$/,
  /(^|\/)event-catalog\.ts$/,
  /(^|\/)normalize\.ts$/,
  // The boundary must protect itself: an agent that rewrites the monitor
  // disables enforcement for every other guardrail file at once.
  /(^|\/)write-boundary-monitor\.ts$/,
  // The preventive gate's entire security argument is "native bash is
  // blocked, so ensemble.bash is the only shell path". Rewriting either of
  // these removes the gate while leaving every other guardrail intact and
  // looking correct.
  /(^|\/)bash-approval\.ts$/,
  /(^|\/)ensemble-bash-tool\.ts$/,
  /(^|\/)tool-grant-enforcement\.ts$/,
];

const FIXTURE_PATTERNS: readonly RegExp[] = [
  /(^|\/)behaviors\/[^/]+\/fixtures\//,
  /(^|\/)fixtures\/(events|expected-matches|expected-outcomes)\//,
];

/**
 * Build configuration: how the suite RESOLVES and RUNS, as opposed to what it
 * asserts.
 *
 * Observed live (br-afik): four files were edited by fix-agent children and
 * none was caught, because none was protected --
 *   jest.config.js   moduleNameMapper -> ../agent-core/src
 *   tsconfig.json    lib ES2022 -> ES2024
 *   package.json     added "pretest": "tsc -p ../agent-core"
 * All three are the same move, and it is the same move as editing the test:
 * when the real problem is dependency resolution, an agent told "repair the
 * SOURCE so it passes" will reach for the config that decides whether the
 * suite can load at all. A green run then proves the harness was changed,
 * not that the code was fixed -- and it is harder to spot in review than an
 * edited assertion, because the diff looks like build housekeeping.
 *
 * WINDOWED, not always-protected, and deliberately so: see
 * isAlwaysProtectedPath below. package.json and tsconfig.json are ordinary
 * working material that a maintainer edits constantly. Arming them
 * permanently would lock the user out of their own repository, which is the
 * failure that design note exists to prevent.
 */
const BUILD_CONFIG_PATTERNS: readonly RegExp[] = [
  /(^|\/)package\.json$/,
  /(^|\/)tsconfig(\.[^/]*)?\.json$/,
  /(^|\/)jest\.config\.([cm]?[jt]s|json)$/,
  /(^|\/)jest\.setup\.[cm]?[jt]s$/,
  /(^|\/)vitest\.config\.[cm]?[jt]s$/,
  /(^|\/)babel\.config\.([cm]?[jt]s|json)$/,
  /(^|\/)\.babelrc(\.[^/]+)?$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)pytest\.ini$/,
  /(^|\/)setup\.cfg$/,
];

const CONSTITUTION_PATTERNS: readonly RegExp[] = [
  /(^|\/)docs\/standards\/constitution\.md$/,
  /(^|\/)constitution-rules\.yaml$/,
];

export function classifyPath(rawPath: string): ProtectedPathVerdict {
  const path = normalize(rawPath);

  const checks: readonly [ProtectedPathReason, readonly RegExp[]][] = [
    ["constitution", CONSTITUTION_PATTERNS],
    ["conformance-fixture", FIXTURE_PATTERNS],
    ["guardrail-source", GUARDRAIL_PATTERNS],
    // Before test-file: a config that happens to sit under tests/ is still
    // build configuration, and reporting it as a test file would mis-describe
    // what the agent actually reached for.
    ["build-config", BUILD_CONFIG_PATTERNS],
    ["test-file", TEST_PATTERNS],
  ];

  for (const [reason, patterns] of checks) {
    const hit = patterns.find((pattern) => pattern.test(path));
    if (hit) {
      return { protected: true, reason, detail: `${path} matched ${reason} rule ${hit}` };
    }
  }

  return { protected: false };
}

export function isProtectedPath(path: string): boolean {
  return classifyPath(path).protected;
}

/**
 * Paths protected WHETHER OR NOT a behavior is running.
 *
 * Two designs for br-vjm5 collided, each right about something. Arming the
 * boundary permanently over every tracked file reverted the maintainer's own
 * edits mid-session: protection that locks you out of your repository.
 * Arming it only inside a fix turn left the guardrails -- the constitution,
 * the enforcement sources, the conformance fixtures -- writable at every
 * other moment, which is precisely when an ordinary turn could quietly
 * rewrite the rules that govern the next fix turn.
 *
 * The split is by REASON, not by timing. A test file is the user's working
 * material: theirs to edit freely, and guarded only while an autofix turn is
 * live, because that is the only window in which the machine should not be
 * silently rewriting the test it is being judged by. The constitution and
 * the guardrail sources are never ordinary working material.
 *
 * BUILD CONFIG SITS WITH TEST FILES, on the windowed side, and the next
 * person to "tighten" this should not move it. package.json and
 * tsconfig.json are edited constantly in normal work; arming them
 * permanently is the br-vjm5 failure above -- protection that locks the
 * maintainer out of their own repository -- and it would fire on every
 * dependency bump. Inside a fix turn the calculus inverts: there, changing
 * how the suite resolves is a way of passing it without fixing anything.
 */
export function isAlwaysProtectedPath(path: string): boolean {
  const verdict = classifyPath(path);
  return (
    verdict.protected &&
    (verdict.reason === "constitution" ||
      verdict.reason === "guardrail-source" ||
      verdict.reason === "conformance-fixture")
  );
}
