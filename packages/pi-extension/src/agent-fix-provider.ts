import { execFile } from "node:child_process";
import { classifyPath } from "@sunstone-partners/ensemble-agent-core";
import { FixProvider } from "./behavior-runner";
import { CandidateWrite, FixCandidate } from "./autofix-loop";

/**
 * A production FixProvider backed by a real model.
 *
 * WHY A SUBPROCESS
 *
 * Pi's ExtensionAPI has no completion primitive -- an extension can register
 * tools and commands and send messages into the session, but it cannot ask
 * the model a question and receive an answer. Steering the host session with
 * `sendUserMessage` would get a fix written, but it bypasses AutofixLoop
 * entirely: no mutation guard, no snapshot, no suite verification, no retry
 * budget, no commit policy. The candidate would be applied by the model's own
 * tool calls, which is exactly the ungoverned path the runtime exists to
 * replace.
 *
 * So the provider delegates to a separate agent process, gets back a
 * structured patch, and returns it as a FixCandidate. Everything downstream
 * -- authorization, snapshotting, applying, re-running the suite, rolling
 * back on failure -- then runs as designed.
 *
 * The child runs with extensions DISABLED. Without that, the child loads this
 * same extension, observes its own test failures, and dispatches its own fix
 * provider, recursively.
 */

export interface AgentFixProviderOptions {
  readonly rootDir: string;
  /** Agent executable. Default "omp". */
  readonly command?: string;
  /** Overrides process execution; tests supply a fake instead of spawning. */
  readonly run?: (prompt: string, signal: AbortSignal) => Promise<string>;
  readonly timeoutMs?: number;
  /** Mutation class recorded on each write; must be one the behavior grants. */
  readonly mutationClass?: string;
  /**
   * Directory holding behavior packages. When set, a behavior's own
   * `fix-prompt.md` overrides the built-in default, so fix strategy lives
   * beside the behavior's trigger and capabilities rather than in code.
   */
  readonly behaviorsDir?: string;
  /** Authoritative name -> package dir, from activation's discovered manifests. */
  readonly behaviorDirFor?: (behaviorName: string) => string | undefined;
  /** Explicit template, overriding both the behavior's file and the default. */
  readonly promptTemplate?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Renders the prompt sent to the fixing agent.
 *
 * The TEXT is not the point of this function -- it is a fallback. The fix
 * strategy is judgment, and judgment belongs in the behavior package beside
 * its trigger and capabilities, not hardcoded here where every behavior is
 * forced to share one strategy it cannot specialize. A behavior supplies its
 * own by adding `fix-prompt.md`; `{{testId}}` and `{{failureOutput}}` are
 * substituted.
 *
 * What stays in TypeScript is the part a prompt must not own: re-running the
 * suite, confirming the target test really passes, and rolling back when it
 * does not. That is the check on the model's own claim, so it cannot be
 * delegated to the model.
 */
export function buildFixPrompt(
  testId: string,
  failureOutput: string,
  template?: string,
): string {
  const body =
    template ??
    [
      "A test is failing. Produce a patch that makes it pass.",
      "",
      "Failing test: {{testId}}",
      "",
      "Failure output:",
      "```",
      "{{failureOutput}}",
      "```",
      "",
      "Rules:",
      "- Fix the SOURCE, never the test. Do not weaken, skip, or delete assertions.",
      "- Do not edit any file whose name ends in .test.ts, .test.js, .spec.ts or .spec.js.",
      "- Return the COMPLETE new contents of each file you change, not a diff.",
      "",
      "Reply with ONLY a fenced json block of this exact shape, and nothing else:",
      "```json",
      '{ "writes": [ { "path": "relative/path.ts", "contents": "<entire new file>" } ] }',
      "```",
    ].join("\n");

  return body
    .replace(/\{\{testId\}\}/g, testId)
    .replace(/\{\{failureOutput\}\}/g, failureOutput.slice(0, 8000));
}

/**
 * Reads a behavior's own fix prompt, if it ships one. Absent file means use
 * the default -- a behavior without a bespoke strategy is normal, not an
 * error.
 */
export function loadFixPromptTemplate(behaviorDir: string): string | undefined {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    return fs.readFileSync(path.join(behaviorDir, "fix-prompt.md"), "utf8");
  } catch {
    return undefined;
  }
}
/**
 * Extracts the candidate from a model reply. Returns undefined rather than
 * throwing or guessing: a malformed reply means "no candidate offered", which
 * the runner already handles. Inventing a partial patch from unparseable
 * output would be strictly worse than proposing nothing.
 */
export function parseFixReply(reply: string, mutationClass: string): FixCandidate | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(reply)) !== null) blocks.push(match[1]);
  // A reply with no fence may still be bare JSON.
  if (blocks.length === 0) blocks.push(reply);

  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.trim());
    } catch {
      continue;
    }
    const writes = (parsed as { writes?: unknown })?.writes;
    if (!Array.isArray(writes) || writes.length === 0) continue;

    const candidate: CandidateWrite[] = [];
    for (const write of writes) {
      const path = (write as { path?: unknown }).path;
      const contents = (write as { contents?: unknown }).contents;
      if (typeof path !== "string" || typeof contents !== "string") return undefined;
      // Absolute paths and traversal escape the repo the guard reasons about.
      // The write boundary would catch the damage afterwards; refusing here
      // means it never lands at all.
      if (path.startsWith("/") || path.split(/[\\/]/).includes("..")) return undefined;
      // The prompt TELLS the model not to touch tests, guardrails or the
      // constitution. Instruction is not enforcement -- a confused or
      // adversarial reply must be refused structurally, here, before the
      // write is ever applied. The corrective write boundary would revert
      // it afterwards, but "reverted a moment later" is strictly worse than
      // "never written", and a fix that gutted a test could otherwise be
      // observed passing in the window between apply and revert.
      const verdict = classifyPath(path);
      if (verdict.protected) return undefined;
      candidate.push({ path, contents, mutationClass });
    }
    return { writes: candidate };
  }
  return undefined;
}

export function createAgentFixProvider(options: AgentFixProviderOptions): FixProvider {
  const mutationClass = options.mutationClass ?? "artifact.write";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const runAgent =
    options.run ??
    ((prompt: string, signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(
          options.command ?? "omp",
          [
            "-p",
            "--no-session",
            // Without this the child loads this extension and recurses.
            "--no-extensions",
            `--cwd=${options.rootDir}`,
            prompt,
          ],
          { cwd: options.rootDir, signal, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
          (error, stdout) => {
            // A non-zero exit still often carries a usable reply on stdout;
            // only treat it as failure when nothing came back.
            if (error && !stdout) reject(error);
            else resolve(stdout);
          },
        );
        // CRITICAL: execFile hands the child a pipe for stdin and never
        // closes it. A non-TTY stdin makes the agent conclude a prompt is
        // being piped in, so it blocks on "readPipedInput" waiting for EOF
        // and never reads argv at all -- the call hangs until the timeout
        // and reports "no candidate offered", which looks like a model
        // failure but is entirely ours. Closing stdin is what makes the
        // argv prompt take effect.
        child.stdin?.end();
      }));

  return async (invocation, issue) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // The invoking behavior's own strategy wins over the built-in default.
      const behaviorName = invocation?.behavior?.metadata?.name;
      const template =
        options.promptTemplate ??
        (behaviorName
          ? loadFixPromptTemplate(
              options.behaviorDirFor?.(behaviorName) ??
                (options.behaviorsDir ? `${options.behaviorsDir}/${behaviorName}` : ""),
            )
          : undefined);

      const reply = await runAgent(
        buildFixPrompt(issue.testId, issue.failureOutput ?? "", template),
        controller.signal,
      );
      return parseFixReply(reply, mutationClass);
    } catch {
      // A provider that throws would abort dispatch; "no candidate" is the
      // correct degraded answer and is already handled downstream.
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
}
