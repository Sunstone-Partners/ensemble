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
];

const FIXTURE_PATTERNS: readonly RegExp[] = [
  /(^|\/)behaviors\/[^/]+\/fixtures\//,
  /(^|\/)fixtures\/(events|expected-matches|expected-outcomes)\//,
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
