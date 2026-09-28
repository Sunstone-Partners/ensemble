import { execFile } from "node:child_process";
import type { ConstitutionChange } from "./constitution-proposal";
import type { IssueKeyInput } from "./issue-identity";
import { BehaviorEvent, eventCwd } from "@sunstone-partners/ensemble-agent-core";
import { createFixSandbox } from "./fix-sandbox";

/**
 * Turns a failure into a proposed constitution amendment, or nothing.
 *
 * This is the missing third step. Detection, repair and verification all
 * existed; the RULE that prevents a recurrence was never produced, so the
 * loop could fix the same class of bug forever without learning anything.
 *
 * BIAS TOWARD SILENCE, deliberately. A bad fix is caught by the suite and
 * rolled back. A bad constitution amendment is different in kind: it becomes
 * a standing rule that governs every future run, and nothing downstream
 * tests it. Most failures are ordinary bugs that imply no rule at all, so
 * "no amendment" is the correct answer nearly always, and the prompt and the
 * parser are both built to make silence the easy path.
 *
 * The reply is a model's, so it is treated as data: parsed strictly, with a
 * malformed or over-eager reply yielding undefined rather than a guess.
 */

export const DEFAULT_CONSTITUTION_PROMPT = `A test failed and was repaired.

Failing command: {{command}}

Failure output:
{{failureOutput}}

Decide whether this failure reveals a gap in the project's engineering rules
-- something that would let this CLASS of failure happen again.

Almost always the answer is NO. Ordinary bugs do not imply new rules. Propose
an amendment only when the failure shows a systemic gap: a verification that
can silently pass, a guard that does not bind, an assumption nothing checks.

If no amendment is warranted, reply with exactly:
NO_AMENDMENT

Otherwise reply with a single JSON object in a fenced block:

\`\`\`json
{
  "rationale": "one sentence on the gap this closes",
  "rule": "- The rule, imperative, testable, one or two sentences."
}
\`\`\`

The rule must constrain FUTURE work, not describe this bug.`;

export function buildConstitutionPrompt(
  command: string,
  failureOutput: string,
  template = DEFAULT_CONSTITUTION_PROMPT,
): string {
  return template
    .replace(/\{\{command\}\}/g, command)
    .replace(/\{\{failureOutput\}\}/g, failureOutput.slice(0, 8000));
}

/**
 * Extracts an amendment from a model reply.
 *
 * Returns undefined for anything doubtful: the explicit NO_AMENDMENT, an
 * unparseable reply, a missing field, or an empty rule. Silence is the safe
 * outcome, so every ambiguity resolves to it.
 */
export function parseConstitutionReply(
  reply: string,
  behaviorName: string,
): ConstitutionChange | undefined {
  if (/\bNO_AMENDMENT\b/.test(reply)) return undefined;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(reply)) !== null) blocks.push(match[1]);
  if (blocks.length === 0) blocks.push(reply);

  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.trim());
    } catch {
      continue;
    }
    const { rationale, rule } = (parsed ?? {}) as { rationale?: unknown; rule?: unknown };
    if (typeof rationale !== "string" || typeof rule !== "string") continue;
    if (!rationale.trim() || !rule.trim()) continue;

    return { behaviorName, rationale: rationale.trim(), diff: rule.trim() };
  }

  return undefined;
}

export interface AgentConstitutionProviderOptions {
  rootDir: string;
  /** Injectable for tests; defaults to a real agent subprocess. */
  run?: (prompt: string) => Promise<string>;
  template?: string;
}

/**
 * The production provider: asks a model whether the failure implies a rule.
 *
 * Failure here is NOT an error. If the agent cannot be reached, times out,
 * or answers with nonsense, the result is "no amendment" and the rest of the
 * loop continues unchanged. Step 3 producing nothing must never cost a
 * repair that already passed verification.
 */
export function createAgentConstitutionProvider(
  options: AgentConstitutionProviderOptions,
): (
  invocation: { behavior: { metadata: { name: string } }; event?: BehaviorEvent },
  issue: IssueKeyInput,
) => Promise<ConstitutionChange | undefined> {
  return async (invocation, issue) => {
    const command = issue.testId ?? "";
    const output = issue.failureOutput ?? "";
    if (!command && !output) return undefined;

    try {
      // Same root rule as the fix provider (br-x36p): the rule provider
      // reads the repository that failed, not whichever one the host
      // process happens to be sitting in.
      const run =
        options.run ??
        defaultRun(eventCwd(invocation.event) ?? options.rootDir);
      const reply = await run(buildConstitutionPrompt(command, output, options.template));
      return parseConstitutionReply(reply, invocation.behavior.metadata.name);
    } catch {
      return undefined;
    }
  };
}

function defaultRun(rootDir: string): (prompt: string) => Promise<string> {
  return (prompt: string) =>
    new Promise<string>((resolve, reject) => {
      // Contained exactly like the fix child (br-r3om): this one only needs
      // to READ, but a process we cannot govern is given a disposable tree
      // regardless of what we believe it will do.
      const sandbox = createFixSandbox(rootDir);
      if (!sandbox) {
        reject(new Error("fix sandbox could not be created; refusing to run the agent"));
        return;
      }
      const child = execFile(
        "omp",
        ["-p", "--no-session", "--no-extensions", `--cwd=${sandbox.dir}`, prompt],
        { cwd: sandbox.dir, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout) => {
          sandbox.cleanup();
          if (error && !stdout) reject(error);
          else resolve(stdout);
        },
      );
      // See agent-fix-provider: an open stdin pipe makes the agent wait for
      // piped input and ignore the argv prompt entirely.
      child.stdin?.end();
    });
}
