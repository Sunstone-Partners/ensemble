import { spawn } from "node:child_process";
import {
  BehaviorInvocation,
  BehaviorInvoker,
  CompiledBehaviorPackage,
  createMutationGuard,
  WorkspaceSnapshot,
  ApprovalGate,
} from "@sunstone-partners/ensemble-agent-core";
import { AutofixLoop, FixCandidate, SuiteResult, AttemptOutcome } from "./autofix-loop";
import { ConstitutionProposal, ConstitutionChange, PullRequestRef } from "./constitution-proposal";
import { IssueKeyInput, issueKey } from "./issue-identity";
import { captureTreeBaseline, changedSinceBaseline } from "./tree-baseline";

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
  const jest = /Tests:\s+(?:(\d+) failed,\s+)?(?:\d+ skipped,\s+)?(\d+) passed/.exec(output);
  if (jest) {
    const failures = Number(jest[1] ?? 0);
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
    const baseline = options.proposeFix ? captureTreeBaseline(options.rootDir) : undefined;
    const candidate = await options.proposeFix?.(invocation, issue);
    const stale = candidate && baseline
      ? changedSinceBaseline(baseline, candidate.writes.map((w) => w.path))
      : [];
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
    } else if (candidate) {
      if (!baseline) {
        record.note = "pre-provider baseline unavailable (not a git work tree); staleness not checked";
      }
      const testCommand = compiled.manifest.execution.test_command;
      const loop = new AutofixLoop({
        guard: createMutationGuard(compiled),
        snapshot: () => new WorkspaceSnapshot(options.rootDir),
        applyWrite: (write) => {
          // Writes still route through the guard inside the loop; this
          // only performs one already-authorized write.
          const fs = require("node:fs") as typeof import("node:fs");
          const path = require("node:path") as typeof import("node:path");
          const abs = path.resolve(options.rootDir, write.path);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, write.contents);
        },
        runSuite: (signal) =>
          options.runSuite
            ? options.runSuite(testCommand ?? "npm test", signal)
            : testCommand
              ? spawnSuite(options.rootDir, testCommand, signal)
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
      record.note = "no fix candidate offered";
    }

    // 2. Propose a constitution change, if the investigation implies one.
    const change = await options.proposeConstitutionChange?.(invocation, issue);
    if (change) {
      if (!options.approval || !options.openPullRequest) {
        record.constitution = {
          status: "declined",
          detail: "constitution change implied but no approval gate or PR backend is configured",
        };
        finish(record);
        return;
      }
      const proposal = new ConstitutionProposal({
        approval: options.approval,
        openPullRequest: options.openPullRequest,
      });
      const result = await proposal.propose(change);
      record.constitution =
        result.status === "proposed"
          ? { status: "proposed", detail: result.pr.url }
          : { status: "declined", detail: result.reason };
    }

    finish(record);
  };
}
