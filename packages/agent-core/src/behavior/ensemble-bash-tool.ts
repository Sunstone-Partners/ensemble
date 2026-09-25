import { spawnSync } from "node:child_process";
import { ToolDescriptor } from "../tools";
import { BashApprovalPolicy } from "./bash-approval";

export interface EnsembleBashResult {
  stdout: string;
  stderr: string;
  /** The REAL exit status of the command, not of a downstream pipeline stage. */
  exitCode: number;
  approved: boolean;
  /** Present when the command was refused, so the model learns why. */
  denialReason?: string;
  /**
   * True when the command contains a shell pipeline/list, meaning exitCode
   * is the status of its LAST stage and a failing earlier stage is hidden.
   * See br-hneq: `npx jest | tail` reports success while tests fail.
   */
  exitCodeMayBeMasked: boolean;
}

/**
 * Detects constructs that make the observed exit status not the status of
 * the interesting command. Conservative and syntactic: it exists to LABEL
 * uncertainty, never to decide whether a command is safe. `||` is excluded
 * because it already implies the author is handling failure.
 */
export function exitCodeMayBeMasked(command: string): boolean {
  const withoutStrings = command.replace(/'[^']*'|"[^"]*"/g, "");
  return /\||;|&&/.test(withoutStrings);
}

export interface EnsembleBashOptions {
  readonly cwd: string;
  readonly policy: BashApprovalPolicy;
  readonly timeoutMs?: number;
}

/**
 * `ensemble.bash` -- a shell tool that asks before it runs.
 *
 * Two properties native `bash` cannot give us:
 *
 * 1. A decision point BEFORE execution, for effects the corrective write
 *    boundary can never undo (network, push, deletions outside the repo).
 * 2. The command's true exit status, because we spawn it ourselves rather
 *    than reading a shell's report of the last pipeline stage.
 *
 * This only constrains anything while native `bash` is absent from the
 * behavior's `capabilities.tools` -- grant enforcement is what removes the
 * alternative. Granting both makes this tool optional and therefore inert.
 */
export function createEnsembleBashTool(
  options: EnsembleBashOptions,
): ToolDescriptor<Record<string, unknown>, EnsembleBashResult> {
  return {
    name: "ensemble.bash",
    description:
      "Run a shell command, subject to approval. Use this instead of `bash`. " +
      "Returns the command's true exit code.",
    async execute(args: Record<string, unknown>): Promise<EnsembleBashResult> {
      const command = typeof args.command === "string" ? args.command : "";
      if (command.trim() === "") {
        return {
          stdout: "",
          stderr: "no command given",
          exitCode: 2,
          approved: false,
          denialReason: "empty command",
          exitCodeMayBeMasked: false,
        };
      }

      const decision = await options.policy.decide(command);
      if (!decision.allowed) {
        const reason =
          decision.reason === "remembered-deny"
            ? "previously denied for this session (deny-always)"
            : decision.reason === "no-approver"
              ? "no approver available in a non-interactive session"
              : "denied by the user";
        return {
          stdout: "",
          stderr: `ensemble.bash refused to run: ${reason}`,
          exitCode: 126,
          approved: false,
          denialReason: reason,
          exitCodeMayBeMasked: false,
        };
      }

      const run = spawnSync(command, {
        cwd: options.cwd,
        shell: true,
        encoding: "utf8",
        timeout: options.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });

      return {
        stdout: run.stdout ?? "",
        stderr: run.stderr ?? "",
        // A signal-killed command has a null status; reporting 0 there would
        // read as success.
        exitCode: run.status ?? (run.signal ? 137 : 1),
        approved: true,
        exitCodeMayBeMasked: exitCodeMayBeMasked(command),
      };
    },
  };
}
