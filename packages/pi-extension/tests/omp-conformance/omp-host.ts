/**
 * Runs the REAL `omp` binary for the conformance suite (TRD-031).
 *
 * Every run is sealed off from the operator's own setup: a throwaway HOME
 * and agent directory, `--no-extensions` so only the extensions under test
 * load, `--no-session`, and a minimal environment. The model is a scripted
 * OpenAI-compatible endpoint on 127.0.0.1, so model traffic never leaves the
 * machine, costs nothing, and is deterministic -- while OMP itself (its agent
 * loop, tool execution, extension host) is the real thing.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { ModelToolMessage, ProbeRecord } from "./host-capabilities";

const PACKAGE_ROOT = resolve(__dirname, "..", "..");
const PROVIDER = "ensemble-conformance";
const MODEL = "scripted";

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The OMP binary: $OMP_BIN when set, else the first executable `omp` on PATH. */
export function findOmp(): string | undefined {
  const explicit = process.env.OMP_BIN;
  if (explicit) return executable(explicit) ? explicit : undefined;
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "omp"))
    .find(executable);
}

export function ompVersion(bin: string): string {
  return spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000 }).stdout?.trim() ?? "";
}

export interface ScriptedCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface FakeModel {
  readonly baseUrl: string;
  /** Every tool message the model has received, across all requests. */
  toolMessages(): ModelToolMessage[];
  close(): Promise<void>;
}

/** A checked property read on parsed JSON: undefined unless `value` is an object. */
function get(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * A scripted chat-completions endpoint. Each request is answered from the
 * conversation it carries, not from a request counter: the Nth scripted turn
 * is served once the conversation holds N-1 assistant tool-call turns, so an
 * extra request from OMP (a retry, a title) cannot steal a turn. Once the
 * script is spent it answers with plain text, which ends OMP's run.
 */
export async function startFakeModel(turns: readonly (readonly ScriptedCall[])[]): Promise<FakeModel> {
  const seen = new Map<string, string>();
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.method !== "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model" }] }));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "request body is not JSON" } }));
        return;
      }
      const raw = get(parsed, "messages");
      const messages: unknown[] = Array.isArray(raw) ? raw : [];
      for (const message of messages) {
        if (get(message, "role") !== "tool") continue;
        const content = get(message, "content");
        seen.set(
          String(get(message, "tool_call_id") ?? ""),
          typeof content === "string"
            ? content
            : (Array.isArray(content) ? content : []).map((part: unknown) => String(get(part, "text") ?? "")).join("\n"),
        );
      }
      const turn = messages.filter((message) => get(message, "role") === "assistant" && Array.isArray(get(message, "tool_calls"))).length;
      const calls = turns[turn] ?? [];
      const base = { id: `chatcmpl-${turn}`, object: "chat.completion.chunk", created: 0, model: MODEL };
      const delta =
        calls.length > 0
          ? {
              role: "assistant",
              tool_calls: calls.map((call, index) => ({
                index,
                id: `call_${turn}_${index}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }
          : { role: "assistant", content: "conformance run complete" };
      const chunks = [
        { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: calls.length > 0 ? "tool_calls" : "stop" }] },
        { ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ];
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake model did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    toolMessages: () => [...seen].map(([toolCallId, content]) => ({ toolCallId, content })),
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  };
}

export interface OmpRunOptions {
  readonly bin: string;
  /** Working directory OMP runs in. */
  readonly repo: string;
  /** Extension files, each passed as `-e`. */
  readonly extensions: readonly string[];
  readonly prompt: string;
  readonly model: FakeModel;
  /** Extra CLI arguments, e.g. a flag an extension registered. */
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

export interface OmpRun {
  readonly exitCode: number | null;
  /** True when the run was killed for exceeding its timeout. */
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** What the probe extension recorded, when it was loaded. */
  readonly records: ProbeRecord[];
}

/** One `omp -p` run against the fake model, in a throwaway HOME. */
export async function runOmp(options: OmpRunOptions): Promise<OmpRun> {
  const home = mkdtempSync(join(tmpdir(), "omp-conformance-home-"));
  const agentDir = join(home, ".omp", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "models.yml"),
    [
      "providers:",
      `  ${PROVIDER}:`,
      `    baseUrl: ${options.model.baseUrl}`,
      "    api: openai-completions",
      "    auth: none",
      "    models:",
      `      - id: ${MODEL}`,
      "        supportsTools: true",
      "        contextWindow: 128000",
      "        maxTokens: 4096",
      "",
    ].join("\n"),
  );
  const probeLog = join(home, "probe.jsonl");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: "C.UTF-8",
    TERM: "dumb",
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: agentDir,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    OMP_CONFORMANCE_PROBE_LOG: probeLog,
  };
  const args = [
    "-p",
    "--no-session",
    "--no-extensions",
    ...options.extensions.flatMap((extension) => ["-e", extension]),
    "--model",
    `${PROVIDER}/${MODEL}`,
    // Scoped to scripted commands in a throwaway repository.
    "--approval-mode=yolo",
    ...(options.args ?? []),
    options.prompt,
  ];
  try {
    const run = await new Promise<Omit<OmpRun, "records">>((done) => {
      // Its own process group, so a timeout also ends the commands OMP spawned.
      const child = spawn(options.bin, args, { cwd: options.repo, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group already exited between the deadline and the kill.
        }
      }, options.timeoutMs ?? 45_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ exitCode: code, timedOut, stdout, stderr });
      });
    });
    const records = existsSync(probeLog)
      ? readFileSync(probeLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line): unknown => JSON.parse(line))
          .filter((value): value is ProbeRecord => typeof get(value, "kind") === "string")
      : [];
    return { ...run, records };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Why a run does not count as a clean OMP run, or undefined when it does. */
export function runProblem(run: OmpRun): string | undefined {
  if (run.timedOut) return `omp was killed after its timeout. stderr: ${run.stderr}`;
  if (run.exitCode !== 0) return `omp exited ${run.exitCode}. stderr: ${run.stderr}`;
  return undefined;
}

/**
 * Bundles THIS checkout's extension exactly as `scripts/install.mjs` does,
 * behind a loader shim with the same load/activate error reporting as the
 * shim install.mjs ships, so OMP runs the code under test rather than
 * whatever happens to be installed. Needs `bun`, and agent-core's `dist/`
 * built first (`npm run test:omp-conformance` does both).
 */
export function buildExtensionShim(outDir: string): string {
  const bundle = join(outDir, "extension.bundle.cjs");
  execFileSync("bun", ["build", "src/extension.ts", "--target=node", "--format=cjs", `--outfile=${bundle}`], {
    cwd: PACKAGE_ROOT,
    stdio: "pipe",
  });
  const shim = join(outDir, "ensemble-extension.ts");
  writeFileSync(
    shim,
    [
      'import { createRequire } from "node:module";',
      "",
      "let inner;",
      "try {",
      `  inner = createRequire(${JSON.stringify(bundle)})(${JSON.stringify(bundle)});`,
      "  inner = inner?.default ?? inner;",
      "} catch (e) {",
      '  console.error("[ensemble] extension failed to load:", e?.message ?? e);',
      "}",
      "",
      "export default function (pi) {",
      '  if (typeof inner !== "function") return;',
      "  try {",
      "    inner(pi);",
      "  } catch (e) {",
      '    console.error("[ensemble] extension failed to activate:", e?.message ?? e);',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  return shim;
}
