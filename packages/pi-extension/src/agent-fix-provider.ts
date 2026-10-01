import { execFile } from "node:child_process";
import { classifyPath, eventCwd } from "@sunstone-partners/ensemble-agent-core";
import { FixProvider } from "./behavior-runner";
import { CandidateWrite, FixCandidate } from "./autofix-loop";
import { createFixSandbox } from "./fix-sandbox";

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
  /** Injectable for tests. rootDir is the repo the failing command ran in (br-x36p). */
  readonly run?: (prompt: string, signal: AbortSignal, rootDir: string) => Promise<string>;
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
  /**
   * Reports why no candidate came back, when the reason is the harness
   * rather than the model. Without it, a broken sandbox and a model with
   * nothing to suggest are the same line in the log.
   */
  readonly onDiagnostic?: (reason: string) => void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The wire protocol, appended to EVERY fix prompt.
 *
 * Not the behavior's to override (br-cxn8, observed live). A behavior that
 * ships its own fix-prompt.md replaces the whole body, and the one in the
 * trial repo said "Repair the SOURCE so it passes" and "your change is
 * verified by re-running the exact command" -- both of which describe an
 * agent that EDITS FILES. The child is spawned with read-only tools and its
 * reply is parsed as a patch, so the agent did as it was told, found it had
 * no way to write, and explained itself in prose:
 *
 *   "this session has no tool that can edit files in the working tree...
 *    I have no edit or shell tool."
 *
 * Diagnosis correct, fix correct, reply unparseable, loop dead. The strategy
 * is the behavior's business; how the answer comes back is not.
 */
const RESPONSE_CONTRACT = [
  "",
  "---",
  "",
  "HOW TO REPLY. This part is fixed by the runtime and overrides anything",
  "above that contradicts it.",
  "",
  "Do NOT use any tool to change this repository, even if one appears",
  "available to you. Your REPLY is the patch; something else applies it.",
  "",
  "(Stated as a directive, not as a fact about your environment: the child",
  "really can see write-capable tools despite the allowlist -- br-33co -- and",
  "an instruction a model can check and disprove undermines the rest.)",
  "",
  "Reply with ONLY a fenced json block of this exact shape, and nothing else:",
  "```json",
  '{ "writes": [ { "path": "relative/path.ts", "contents": "<entire new file>" } ] }',
  "```",
  "",
  "Return the COMPLETE new contents of each file you change, not a diff.",
  'If you cannot find a real fix, reply with { "writes": [] } and nothing else.',
].join("\n");

/**
 * Renders the prompt sent to the fixing agent.
 *
 * The STRATEGY text is a fallback. Fix strategy is judgment, and judgment
 * belongs in the behavior package beside its trigger and capabilities, not
 * hardcoded here where every behavior shares one approach it cannot
 * specialize. A behavior supplies its own by adding `fix-prompt.md`;
 * `{{testId}}` and `{{failureOutput}}` are substituted.
 *
 * The RESPONSE CONTRACT is appended regardless, because it is not strategy:
 * it is the interface between this process and the next one.
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
    ].join("\n");

  return `${body}\n${RESPONSE_CONTRACT}`
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

/**
 * Tools the fixing agent may use. Its contract is to READ the repository and
 * REPLY with a patch; AutofixLoop alone authorizes and applies writes.
 *
 * This is enforcement, not instruction. The child runs with
 * `--no-extensions` (otherwise it recurses into this extension), which also
 * means no tool grants, MutationGuard, write boundary or runtime log apply
 * inside it. With its default tool set it is a full agent in the LIVE
 * repository -- observed: a behavior whose manifest granted no edit tool had
 * its source changed on disk by this child, and the governed rejection that
 * followed "restored" the already-changed file. Probed live against omp:
 * with this list, `edit`/`bash` are absent and `write` refuses filesystem
 * paths ("limited to the xd:// device transport"), so a direct write leaves
 * the tree unchanged even when the child is told to make it.
 */
export const FIX_AGENT_TOOLS = ["read", "grep", "glob"] as const;

export function fixAgentArgs(rootDir: string, prompt: string): string[] {
  return [
    "-p",
    "--no-session",
    // Without this the child loads this extension and recurses.
    "--no-extensions",
    `--tools=${FIX_AGENT_TOOLS.join(",")}`,
    `--cwd=${rootDir}`,
    prompt,
  ];
}

export function createAgentFixProvider(options: AgentFixProviderOptions): FixProvider {
  const mutationClass = options.mutationClass ?? "artifact.write";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const runAgent =
    options.run ??
    ((prompt: string, signal: AbortSignal, rootDir: string) =>
      new Promise<string>((resolve, reject) => {
        // The child runs in a DISPOSABLE mirror of the tree, never the live
        // repository (br-r3om). It is spawned --no-extensions, so nothing we
        // built applies inside it: no grants, no MutationGuard, no write
        // boundary, no log. Rules cannot be enforced in a process we do not
        // control, so it is given nothing of value to write to instead.
        // br-x36p: the sandbox is built from the repo the FAILING COMMAND ran
        // in. Using the extension host's root here is how fix-agent children
        // came to write into the maintainer's main checkout over a failure
        // observed in a different worktree.
        //
        // br-boam: the callback matters as much as the root. A sandbox that
        // cannot be built fails closed and reports "no fix candidate offered"
        // -- indistinguishable from a model with nothing to say. Both sides
        // of this conflict are load-bearing.
        const sandbox = createFixSandbox(rootDir, (reason) => options.onDiagnostic?.(reason));
        if (!sandbox) {
          // Fail CLOSED. Falling back to the live repo would silently
          // restore the ungoverned behaviour, at the exact moment something
          // is already wrong.
          reject(new Error("fix sandbox could not be created; refusing to run the agent"));
          return;
        }

        const child = execFile(
          options.command ?? "omp",
          // dev's arg helper (it also restricts --tools), aimed at the
          // disposable worktree rather than the live tree (br-r3om). Keeping
          // either side alone loses something: HEAD's tool restriction, or
          // the containment that makes an ungoverned child harmless.
          fixAgentArgs(sandbox.dir, prompt),
          { cwd: sandbox.dir, signal, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
          (error, stdout) => {
            sandbox.cleanup();
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
        // The repo the FAILING COMMAND ran in, not the extension host's
        // (br-x36p).
        eventCwd(invocation.event) ?? options.rootDir,
      );
      const candidate = parseFixReply(reply, mutationClass);
      if (!candidate) {
        // Carry the evidence. "could not be parsed" without the reply sends
        // the next person to reproduce a NON-DETERMINISTIC model output,
        // which may well parse fine on the retry -- as it did the first time
        // this was chased by hand.
        const shown = reply.length > 600 ? `${reply.slice(0, 600)}...[${reply.length} bytes]` : reply;
        options.onDiagnostic?.(`agent replied, but no fix candidate could be parsed from it; reply was: ${shown}`);
      }
      return candidate;
    } catch (error) {
      // A provider that throws would abort dispatch; "no candidate" is the
      // correct degraded answer and is already handled downstream. But it
      // must not be a SILENT one: "no candidate offered" and "the harness
      // broke before the model was asked" looked identical in the log, and
      // that cost two live runs to tell apart (br-boam).
      options.onDiagnostic?.(`fix provider failed: ${(error as Error).message}`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
}
