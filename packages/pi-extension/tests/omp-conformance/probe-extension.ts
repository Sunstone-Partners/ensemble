/**
 * Loaded INTO a real `omp` process by the conformance suite (`-e <this file>`),
 * never imported by Jest. It records what the host actually does -- which
 * events fire and with which fields, which API members exist, how a
 * registered tool is invoked, what a CLI flag reads as -- as JSON lines in
 * $OMP_CONFORMANCE_PROBE_LOG, for `observe()` to read.
 *
 * It types the host as `unknown` on purpose: the point is to find out what
 * OMP provides, so it must not assume Pi's ExtensionAPI shape. It imports
 * only `node:` builtins and the shared constants, because OMP resolves an
 * extension's relative imports but not bare package specifiers.
 */
import { appendFileSync } from "node:fs";
import { PROBE } from "./host-capabilities";

const LOG = process.env.OMP_CONFORMANCE_PROBE_LOG ?? "";

function record(kind: string, detail: Record<string, unknown> = {}): void {
  if (LOG) appendFileSync(LOG, JSON.stringify({ kind, ...detail }) + "\n");
}

/** A checked property read: undefined unless `value` is an object. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

type Callable = (...args: unknown[]) => unknown;

/** The host's `name` method bound to it, or undefined when the host has none. */
function method(host: unknown, name: string): Callable | undefined {
  const candidate = field(host, name);
  if (typeof candidate !== "function") return undefined;
  return (...args: unknown[]): unknown => Reflect.apply(candidate, host, args);
}

/** Names out of whatever list shape the host returns: strings, `{ name }` objects, or a Map. */
function names(listing: unknown): string[] {
  const entries = listing instanceof Map ? [...listing.keys()] : Array.isArray(listing) ? listing : [];
  return entries
    .map((entry) => (typeof entry === "string" ? entry : field(entry, "name")))
    .filter((name): name is string => typeof name === "string");
}

function textOf(content: unknown): string {
  return (Array.isArray(content) ? content : [])
    .filter((part) => field(part, "type") === "text")
    .map((part) => String(field(part, "text") ?? ""))
    .join("\n");
}

/** `typeof` what the context's session manager reports as the session id, or "absent". */
function sessionIdTypeOf(ctx: unknown): string {
  const getSessionId = method(field(ctx, "sessionManager"), "getSessionId");
  return getSessionId ? typeof getSessionId() : "absent";
}

const EVENTS = [
  "session_start",
  "before_agent_start",
  "tool_call",
  "tool_execution_start",
  "tool_execution_end",
  "tool_result",
  "agent_end",
  "session_shutdown",
];

export default function probe(host: unknown): void {
  const prototype = typeof host === "object" && host !== null ? Object.getPrototypeOf(host) : null;
  const members = [
    ...new Set([
      ...(typeof host === "object" && host !== null ? Object.keys(host) : []),
      ...(prototype ? Object.getOwnPropertyNames(prototype) : []),
    ]),
  ].sort();
  record("api", { members });

  // Default false, like --ensemble-tool-grant: only the command line can make it true.
  method(host, "registerFlag")?.(PROBE.flag, { description: "conformance probe", type: "boolean", default: false });

  const objectSchema = method(field(field(host, "typebox"), "Type"), "Object");
  method(host, "registerTool")?.({
    name: PROBE.tool,
    label: "OMP conformance probe",
    description: "Records how the host invokes a registered tool. Takes no arguments.",
    parameters: objectSchema ? objectSchema({}) : { type: "object", properties: {} },
    async execute(...args: unknown[]) {
      const ctxAt = args.findIndex((arg) => method(field(arg, "sessionManager"), "getSessionId") !== undefined);
      record("tool-execute", {
        toolCallIdType: typeof args[0],
        abortSignalAt: args.findIndex((arg) => arg instanceof AbortSignal),
        ctxAt,
        ctxSessionIdType: ctxAt >= 0 ? sessionIdTypeOf(args[ctxAt]) : "absent",
      });
      return { content: [{ type: "text", text: PROBE.toolOutput }], details: {} };
    },
  });

  method(host, "registerCommand")?.(PROBE.command, {
    description: "OMP conformance probe command",
    handler: async () => record("command-ran"),
  });

  const on = method(host, "on");
  for (const name of EVENTS) {
    on?.(name, async (event: unknown, ctx: unknown) => {
      record("event", {
        name,
        toolName: field(event, "toolName"),
        toolCallId: field(event, "toolCallId"),
        isError: field(event, "isError"),
        prompt: field(event, "prompt"),
      });
      if (name === "session_start") {
        const ui = field(ctx, "ui");
        record("session", {
          flag: method(host, "getFlag")?.(PROBE.flag),
          sessionIdType: sessionIdTypeOf(ctx),
          hasUI: field(ctx, "hasUI"),
          ui: typeof ui === "object" && ui !== null ? Object.keys(ui).sort() : [],
        });
      }
      // Keyed on toolName, as the extension's grant boundary is.
      if (name === "tool_call" && field(event, "toolName") === "bash" && field(field(event, "input"), "command") === PROBE.blockedCommand) {
        record("blocked", { toolCallId: field(event, "toolCallId") });
        return { block: true, reason: PROBE.blockReason };
      }
      if (name === "tool_result") {
        record("tool_result", {
          toolName: field(event, "toolName"),
          toolCallId: field(event, "toolCallId"),
          command: field(field(event, "input"), "command"),
          isError: field(event, "isError"),
          text: textOf(field(event, "content")),
        });
      }
      if (name === "agent_end") {
        record("tools", { names: names(method(host, "getAllTools")?.()) });
        record("commands", { names: names(method(host, "getCommands")?.()) });
      }
      return undefined;
    });
  }
}
