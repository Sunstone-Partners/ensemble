import { spawn } from "node:child_process";
import {
  BehaviorInvocation,
  BehaviorInvoker,
  CompiledBehaviorPackage,
  createMutationGuard,
  eventCwd,
  WorkspaceSnapshot,
  ApprovalGate,
} from "@sunstone-partners/ensemble-agent-core";
import { AutofixLoop, FixCandidate, SuiteResult, AttemptOutcome } from "./autofix-loop";
import { ConstitutionProposal, ConstitutionChange, PullRequestRef, AppliedChange } from "./constitution-proposal";
import { IssueKeyInput, issueKey } from "./issue-identity";
import { captureTreeBaseline, changedSinceBaseline, treeChangesSinceBaseline } from "./tree-baseline";
import { parseTotals } from "./verify-suite";

/**
 * The invoker that runs when a behavior matches (PR 7).
 *
 * Until this existed, `activateBehaviorPipeline` was called with no
 * invoker, so `LocalEventMatcher` defaulted to `() => undefined`: a
 * matching event was translated, matched, and then handed to a stub.
 * Every guarantee built on top of dispatch — mode enforcement, the
 * protected-path write boundary, snapshots, the retry budget, commit
 * policy — was reachable only from tests, because the last link in the
 * chain did nothing.
 */

/** Supplies a candidate fix for a failure. In production this is the agent. */
export type FixProvider = (
  invocation: BehaviorInvocation,
  issue: IssueKeyInput,
) => FixCandidate | undefined | Promise<FixCandidate | undefined>;

/** Supplies a constitution change implied by a failure, if any. */
export type ConstitutionProvider = (
  invocation: BehaviorInvocation,
  issue: IssueKeyInput,
) => ConstitutionChange | undefined | Promise<ConstitutionChange | undefined>;

export interface BehaviorRunRecord {
  behavior: string;
  issue: IssueKeyInput;
  outcome?: AttemptOutcome;
  /** Present when a propose-mode behavior produced a reviewable patch. */
  proposal?: { issue: string; writes: { path: string; contents: string }[]; reason: string };
  constitution?: { status: string; detail: string };
  /**
   * Paths (outside runtime state) that changed while the fix provider ran.
   * Not attributable: the provider writing outside its contract and a
   * concurrent edit look the same. Present only when non-empty.
   */
  treeDrift?: string[];
  note?: string;
}

export interface BehaviorRunnerOptions {
  rootDir: string;
  /**
   * Getter, not an array: activation compiles the packages that this
   * invoker needs, so binding eagerly would capture an empty list.
   */
  compiled: () => readonly CompiledBehaviorPackage[];
  proposeFix?: FixProvider;
  proposeConstitutionChange?: ConstitutionProvider;
  approval?: ApprovalGate;
  /** Applies an APPROVED constitution change in place (br-9uqd). */
  applyConstitutionChange?: (
    change: ConstitutionChange,
    rootDir?: string,
  ) => AppliedChange | Promise<AppliedChange>;
  /** Optional delivery of an already-applied change; no longer a gate. */
  openPullRequest?: (change: ConstitutionChange) => PullRequestRef | Promise<PullRequestRef>;
  /** Overrides suite execution; defaults to spawning the declared command. */
  runSuite?: (command: string, signal: AbortSignal) => SuiteResult | Promise<SuiteResult>;
  /** Records what happened, for inspection by the session. */
  records?: BehaviorRunRecord[];
  /** Called after a record is finalized, for observability. */
  onRecord?: (record: BehaviorRunRecord) => void;
}

/** Parses a jest/mix/pytest-style summary into a pass/fail count. */
export function parseSuiteOutput(output: string, exitCode: number): SuiteResult {
  // Every jest summary, not the first: `npm test` prints one per workspace,
  // and a pass in the first must not vouch for a failure in the fifth. A
  // suite that could not load counts as a failure (br-srbd), and so does a
  // non-zero exit with no failing test reported.
  const jest = parseTotals(output);
  if (jest.runs > 0) {
    let failures = jest.failed + jest.failedSuites;
    if (failures === 0 && exitCode !== 0) failures = 1;
    return { failures, targetPasses: failures === 0, output };
  }
  const mix = /(\d+)\s+tests?,\s+(\d+)\s+failures?/.exec(output);
  if (mix) {
    const failures = Number(mix[2]);
    return { failures, targetPasses: failures === 0, output };
  }
  // No recognised summary: trust the exit code rather than guessing zero,
  // which would let an unparsed run vouch for a fix.
  return { failures: exitCode === 0 ? 0 : 1, targetPasses: exitCode === 0, output };
}

function spawnSuite(rootDir: string, command: string, signal: AbortSignal): Promise<SuiteResult> {
  return new Promise<SuiteResult>((resolve) => {
    let out = "";
    const child = spawn(command, { cwd: rootDir, shell: true, signal });
    child.stdout?.on("data", (d) => (out += String(d)));
    child.stderr?.on("data", (d) => (out += String(d)));
    child.on("error", () => resolve({ failures: 1, targetPasses: false, output: out }));
    child.on("close", (code) => resolve(parseSuiteOutput(out, code ?? 1)));
  });
}

export function createBehaviorInvoker(options: BehaviorRunnerOptions): BehaviorInvoker {
  const records = options.records ?? [];

  return async (invocation: BehaviorInvocation) => {
   const finish = (r: BehaviorRunRecord) => options.onRecord?.(r);
    const payload = (invocation.event.payload ?? {}) as Record<string, unknown>;
    // The repository the FAILING COMMAND ran in, not the extension host's.
    // br-x36p: these were the same value in practice only when the user
    // happened to be working in the repo under repair. When they were not,
    // fix-agent children wrote into the maintainer's main checkout on the
    // strength of a failure observed in a different worktree. The fallback
    // is the configured root, which is the old behaviour for events that
    // carry no cwd.
    const root = eventCwd(invocation.event) ?? options.rootDir;
    const issue: IssueKeyInput = {
      testId: String(payload.toolName ?? "suite") + " > " + String(payload.command ?? "unknown"),
      failureOutput: String(payload.output ?? payload.command ?? ""),
    };

    const record: BehaviorRunRecord = { behavior: invocation.behavior.metadata.name, issue };
    records.push(record);

    const compiled = options.compiled().find(
      (c) => c.manifest.metadata.name === invocation.behavior.metadata.name,
    );
    if (!compiled) {
      record.note = "no compiled package for this behavior";
      finish(record);
      return;
    }

    // 1. Attempt a fix, if a provider offers a candidate. The baseline is
    // taken BEFORE the provider runs: it can take minutes, the session keeps
    // editing meanwhile, and AutofixLoop's own snapshot is taken at apply
    // time -- too late to see anything that changed during generation.
    const baseline = options.proposeFix ? captureTreeBaseline(root) : undefined;
    const candidate = await options.proposeFix?.(invocation, issue);
    const stale = candidate && baseline
      ? changedSinceBaseline(baseline, candidate.writes.map((w) => w.path))
      : [];
    // Before/after check around the provider, independent of its tool
    // allowlist: a provider replies, it never writes. Runs with or without a
    // candidate -- a child that wrote and then replied nothing parseable is
    // exactly the case an allowlist gap would produce.
    const drift = baseline ? treeChangesSinceBaseline(baseline) : [];
    if (drift && drift.length > 0) record.treeDrift = drift;
    const listed = (paths: readonly string[]) =>
      paths.slice(0, 10).join(", ") + (paths.length > 10 ? ` (+${paths.length - 10} more)` : "");
    if (candidate && stale.length > 0) {
      // Not applied, and nothing is restored: these edits are not ours to
      // undo. The candidate was computed from content that no longer exists.
      record.outcome = {
        status: "rejected",
        attempt: 0,
        issue: issueKey(issue),
        reason:
          `working tree changed at ${stale.join(", ")} while the fix was being generated; ` +
          `candidate not applied (nothing written, nothing restored)`,
        restored: [],
      };
    } else if (candidate && drift && drift.length > 0) {
      record.outcome = {
        status: "rejected",
        attempt: 0,
        issue: issueKey(issue),
        reason:
          `working tree changed while the fix was being generated (${listed(drift)}); ` +
          `a fix provider must not write and a concurrent edit cannot be told apart from one -- ` +
          `candidate not applied (nothing written, nothing reverted)`,
        restored: [],
      };
    } else if (candidate) {
      if (!baseline) {
        record.note = "pre-provider baseline unavailable (not a git work tree); staleness not checked";
      } else if (!drift) {
        record.note = "post-provider tree check unavailable; provider writes not checked";
      }
      const testCommand = compiled.manifest.execution.test_command;
      const loop = new AutofixLoop({
        guard: createMutationGuard(compiled),
        snapshot: () => new WorkspaceSnapshot(root),
        applyWrite: (write) => {
          // Writes still route through the guard inside the loop; this
          // only performs one already-authorized write.
          const fs = require("node:fs") as typeof import("node:fs");
          const path = require("node:path") as typeof import("node:path");
          const abs = path.resolve(root, write.path);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, write.contents);
        },
        runSuite: (signal) =>
          options.runSuite
            ? options.runSuite(testCommand ?? "npm test", signal)
            : testCommand
              ? spawnSuite(root, testCommand, signal)
              : { failures: 1, targetPasses: false, output: "no declared test_command" },
        approval: options.approval,
      });

      record.outcome = await loop.attempt(issue, candidate);

      // TRD-018: a `propose` behavior is denied direct writes by
      // design. That is not a dead end -- it is the point. The
      // candidate becomes a human-reviewable proposal artifact instead
      // of being discarded, which is what "emit a proposal artifact
      // instead" actually requires.
      if (record.outcome.status === "rejected" && /mode: propose/.test(record.outcome.reason)) {
        record.proposal = {
          issue: record.outcome.issue,
          writes: candidate.writes.map((w) => ({ path: w.path, contents: w.contents })),
          reason: record.outcome.reason,
        };
      }
    } else {
      record.note = drift && drift.length > 0
        ? `no fix candidate offered; working tree changed while the provider ran (${listed(drift)}) ` +
          `-- cannot attribute, nothing reverted`
        : "no fix candidate offered";
    }

    // 2. Propose a constitution change, if the investigation implies one AND
    //    the behavior is actually allowed to.
    //
    // The capability gate is not a formality here. This call was
    // unconditional, which was harmless only while the provider defaulted to
    // undefined: the moment a real default was wired, EVERY run of EVERY
    // behavior spawned a second agent subprocess to ask about the
    // constitution -- including behaviors that declare no interest in it.
    // Observed as behavior-window.e2e hanging on a fixture whose
    // mutation_classes are [artifact.write] alone.
    //
    // mutation_classes is the behavior's own declaration of what it may
    // change. Asking a model whether to amend the constitution, on behalf of
    // a behavior that was never granted constitution.propose, is exactly the
    // ungoverned-capability problem MutationGuard exists to prevent -- and
    // it costs a model call per run to do it.
    const mayPropose =
      compiled.manifest.capabilities.mutation_classes.includes("constitution.propose");
    const change = mayPropose ? await options.proposeConstitutionChange?.(invocation, issue) : undefined;

    // Every outcome of this step is recorded, including the ones where
    // nothing happens (br-zcxb). Previously a falsy `change` fell through
    // silently, so the log could not tell these apart:
    //
    //   the behavior was never granted constitution.propose
    //   no provider was configured
    //   the provider ran and judged that no rule change was warranted
    //
    // They need different fixes and looked identical -- as an absent field.
    // That is how "the constitution step never fires" became a believable
    // reading of a run in which it may well have fired and correctly
    // declined: a typo'd operator does not imply a constitutional rule.
    //
    // "skipped" is not a failure. It is the capability gate working.
    if (!change) {
      record.constitution = !mayPropose
        ? {
            status: "skipped",
            detail: "behavior does not declare constitution.propose",
          }
        : !options.proposeConstitutionChange
          ? {
              status: "unavailable",
              detail: "constitution.propose granted but no rule provider is configured",
            }
          : {
              status: "none",
              detail: "rule provider ran and implied no constitution change",
            };
    }
    if (change) {
      // The PR backend is no longer required: approval now APPLIES the
      // change (br-9uqd), and delivery is optional. What is still required
      // is a way to ask a human and a way to write the file.
      if (!options.approval || !options.applyConstitutionChange) {
        record.constitution = {
          status: "declined",
          detail: "constitution change implied but no approval gate or applier is configured",
        };
        finish(record);
        return;
      }
      const proposal = new ConstitutionProposal({
        approval: options.approval,
        applyChange: (change) => options.applyConstitutionChange!(change, root),
        openPullRequest: options.openPullRequest,
      });
      const result = await proposal.propose(change);
      record.constitution =
        result.status === "applied"
          ? {
              status: "applied",
              detail: result.pr
                ? `${result.applied.detail}; delivered as ${result.pr.url}`
                : result.deliveryError
                  ? `${result.applied.detail}; delivery failed: ${result.deliveryError}`
                  : result.applied.detail,
            }
          : result.status === "failed"
            ? { status: "failed", detail: `constitution change approved but not applied: ${result.reason}` }
            : { status: "declined", detail: result.reason };
    }

    finish(record);
  };
}
