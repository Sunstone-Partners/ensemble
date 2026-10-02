/**
 * What the Ensemble extension needs from the host it runs in, and how one
 * run of the REAL `omp` binary shows each need is met (TRD-031 / REQ-024).
 *
 * WHY OMP GETS ITS OWN LIST. OMP loads the same extension bundle as Pi and
 * reads the same behavior YAML. That is precisely the argument AC-024-1
 * rules out: shared inputs are not evidence of shared behavior. Pi's own
 * suite drives a FAKE Pi surface (`tests/support/harness.ts`), so a green
 * Pi run says nothing about OMP. Every entry here is something the
 * extension's source relies on -- a `pi.on` name it subscribes to, a field
 * it reads from an event, an API it calls, the argument a tool's `execute`
 * reads -- checked against what an OMP process actually did, never against
 * `@earendil-works/pi-coding-agent`'s types: type definitions describe that
 * package, not the binary executing us.
 *
 * A capability OMP lacks is NOT worked around (AC-024-2). It goes in
 * `OMP_GAPS` with what it costs, and the suite reports it as unsupported
 * (a Jest todo, never a pass). A recorded gap that OMP turns out to provide
 * fails the run, so the list cannot drift in either direction.
 *
 * WHAT `-p` CANNOT SHOW. Runs are non-interactive (`omp -p`), where OMP
 * reports `ctx.hasUI === false`, so every approval prompt fails closed and
 * interactive approval on OMP is NOT verified here. The suite checks that
 * `hasUI` is a boolean the extension can branch on, and that the UI members
 * exist; whether a prompt reaches a human is out of reach of this run.
 */

/** One JSON line the probe extension writes while OMP runs it. */
export type ProbeRecord = { readonly kind: string } & Record<string, unknown>;

/** A tool message the model received, as the fake model recorded it. */
export interface ModelToolMessage {
  readonly toolCallId: string;
  readonly content: string;
}

/** One lifecycle event as the probe saw it, with the fields the extension reads. */
export interface ObservedEvent {
  readonly name: string;
  readonly toolName: unknown;
  readonly toolCallId: unknown;
  readonly isError: unknown;
  readonly prompt: unknown;
}

/** How OMP invoked a tool the probe registered. */
export interface ObservedExecute {
  readonly toolCallIdType: string;
  /** Argument index of the AbortSignal, -1 when none. */
  readonly abortSignalAt: number;
  /** Argument index of the context carrying `sessionManager.getSessionId`, -1 when none. */
  readonly ctxAt: number;
  /** `typeof` what that context's `sessionManager.getSessionId()` returned. */
  readonly ctxSessionIdType: string;
}

/** What one OMP run showed, reduced to the facts the capabilities read. */
export interface HostObservation {
  readonly events: readonly ObservedEvent[];
  /** Members of the ExtensionAPI object OMP passed to the extension. */
  readonly api: readonly string[];
  /** Members of `ctx.ui` at session start. */
  readonly ui: readonly string[];
  /** `ctx.hasUI` at session start, as OMP supplied it. */
  readonly hasUI: unknown;
  /** `pi.getFlag` for a flag registered with default `false` and passed on the command line. */
  readonly cliFlag: unknown;
  /** `typeof ctx.sessionManager.getSessionId()` at session start. */
  readonly sessionIdType: string;
  /** Tools the host lists once the probe has registered its own. */
  readonly tools: readonly string[];
  /** Commands the host lists once the probe has registered its own. */
  readonly commands: readonly string[];
  readonly execute: ObservedExecute | undefined;
  /** Every tool_result the extension saw, with the fields `pi-events.ts` reads. */
  readonly toolResults: readonly { toolName: unknown; toolCallId: unknown; command: unknown; isError: unknown; text: string }[];
  /** Id of the call the probe blocked in `tool_call`. */
  readonly blockedCallId: string | undefined;
  /** True when the blocked command's side effect happened anyway. */
  readonly blockedCommandRan: boolean;
  /** True when a slash command registered by the extension ran. */
  readonly commandRan: boolean;
  /** Every tool message the model received during the run. */
  readonly modelToolMessages: readonly ModelToolMessage[];
}

/** The scripted run, so capabilities can name what was asked of OMP. */
export const PROBE = {
  prompt: "run the omp conformance probe",
  echoCommand: "echo omp-conformance-probe",
  echoOutput: "omp-conformance-probe",
  /** Run only if blocking FAILS: its side effect is the evidence. */
  blockedCommand: "touch omp-conformance-blocked-marker",
  blockedMarker: "omp-conformance-blocked-marker",
  blockReason: "blocked by the omp conformance probe",
  tool: "omp_conformance_probe_tool",
  toolOutput: "omp conformance probe tool ran",
  command: "omp-conformance-probe",
  /** Registered with default false; the run passes `--<flag>`. */
  flag: "omp-conformance-probe-flag",
} as const;

export interface HostCapability {
  readonly id: string;
  /** What in the extension depends on it, so a gap names what it breaks. */
  readonly neededFor: string;
  readonly holds: (observed: HostObservation) => boolean;
}

const fired = (name: string) => (observed: HostObservation) => observed.events.some((event) => event.name === name);

const namedEvents = (observed: HostObservation, ...names: string[]) =>
  observed.events.filter((event) => names.includes(event.name));

export const REQUIRED_HOST_CAPABILITIES: readonly HostCapability[] = [
  { id: "event:session_start", neededFor: "arming and the session-start trigger (session.ts)", holds: fired("session_start") },
  { id: "event:before_agent_start", neededFor: "runtime.prompt.submitted (session.ts)", holds: fired("before_agent_start") },
  { id: "event:tool_call", neededFor: "tool-grant enforcement and runtime.tool_call.started", holds: fired("tool_call") },
  {
    id: "event:tool_execution_start",
    neededFor: "runtime.tool_call.started for every tool (session.ts)",
    holds: fired("tool_execution_start"),
  },
  {
    id: "event:tool_execution_end",
    neededFor: "runtime.tool_call.completed for every tool (session.ts)",
    holds: fired("tool_execution_end"),
  },
  {
    id: "event:tool_result",
    neededFor: "the test-failure and repository-change translations (pi-events.ts)",
    holds: fired("tool_result"),
  },
  { id: "event:agent_end", neededFor: "runtime.session.completed and end-of-run bookkeeping", holds: fired("agent_end") },
  {
    id: "event:session_shutdown",
    neededFor: "joining in-flight dispatches before the host exits (extension.ts)",
    holds: fired("session_shutdown"),
  },
  {
    id: "fields:tool_call",
    neededFor: "the grant boundary keys on tool_call's toolName (tool-grant-enforcement.ts); pi-events.ts reads toolCallId",
    holds: (observed) => {
      const calls = namedEvents(observed, "tool_call");
      return calls.length > 0 && calls.every((e) => typeof e.toolName === "string" && typeof e.toolCallId === "string");
    },
  },
  {
    id: "fields:tool_execution",
    neededFor: "runtime.tool_call.started/completed read toolName and toolCallId, and isError on the end event (pi-events.ts)",
    holds: (observed) => {
      const executions = namedEvents(observed, "tool_execution_start", "tool_execution_end");
      return (
        executions.length > 0 &&
        executions.every((e) => typeof e.toolName === "string" && typeof e.toolCallId === "string") &&
        namedEvents(observed, "tool_execution_end").every((e) => typeof e.isError === "boolean")
      );
    },
  },
  {
    id: "fields:before_agent_start",
    neededFor: "runtime.prompt.submitted carries the prompt (pi-events.ts)",
    holds: (observed) => namedEvents(observed, "before_agent_start").some((e) => e.prompt === PROBE.prompt),
  },
  {
    // `input.cwd` is deliberately not required: OMP's bash input carries a
    // cwd only when the model passes one, and pi-events.ts treats it as optional.
    id: "fields:tool_result",
    neededFor: "pi-events.ts reads toolName, toolCallId, input.command, isError and text content to recognise a failing test",
    holds: (observed) => {
      const result = observed.toolResults.find((r) => r.toolName === "bash" && r.command === PROBE.echoCommand);
      return (
        result !== undefined &&
        typeof result.toolCallId === "string" &&
        typeof result.isError === "boolean" &&
        result.text.includes(PROBE.echoOutput)
      );
    },
  },
  {
    id: "api:registerTool",
    neededFor: "the governed tools a behavior uses (extension.ts, behavior-loader.ts)",
    holds: (observed) => observed.api.includes("registerTool") && observed.tools.includes(PROBE.tool) && observed.execute !== undefined,
  },
  {
    id: "tool:abort-signal",
    neededFor: "cancelling a governed tool: execute reads the AbortSignal as its third argument",
    holds: (observed) => observed.execute?.abortSignalAt === 2,
  },
  {
    id: "tool:execute-context",
    neededFor:
      "governed tools read ctx.sessionManager.getSessionId() from execute's fifth argument and the call id from its first (extension.ts, behavior-loader.ts)",
    holds: (observed) =>
      observed.execute?.ctxAt === 4 &&
      observed.execute.ctxSessionIdType === "string" &&
      observed.execute.toolCallIdType === "string",
  },
  {
    id: "api:registerCommand",
    neededFor: "/ensemble-status, /ensemble-approve and per-behavior commands",
    holds: (observed) => observed.commandRan && observed.commands.includes(PROBE.command),
  },
  {
    id: "api:registerFlag+cli",
    neededFor: "--ensemble-tool-grant: OMP must parse a flag an extension registered and return it from getFlag (extension.ts)",
    holds: (observed) => observed.api.includes("registerFlag") && observed.cliFlag === true,
  },
  {
    id: "ctx:sessionManager.getSessionId",
    neededFor: "attributing lifecycle events to their session (extension.ts, behavior-loader.ts)",
    holds: (observed) => observed.sessionIdType === "string",
  },
  {
    id: "ctx:ui-members",
    neededFor: "SessionUiBridge calls notify, confirm, select and setStatus (session-ui.ts); not that a prompt reaches a human",
    holds: (observed) => ["notify", "confirm", "select", "setStatus"].every((member) => observed.ui.includes(member)),
  },
  {
    id: "ctx:hasUI",
    neededFor: "every approval prompt branches on ctx.hasUI, and SessionUiBridge.capture drops a ctx whose hasUI is not a boolean",
    holds: (observed) => typeof observed.hasUI === "boolean",
  },
  {
    id: "tool_call:block",
    neededFor:
      "denying an ungranted tool at the runtime boundary (constitution Rule 5): the call must not run and the model must see why",
    holds: (observed) =>
      observed.blockedCallId !== undefined &&
      !observed.blockedCommandRan &&
      observed.modelToolMessages.some(
        (message) => message.toolCallId === observed.blockedCallId && message.content.includes(PROBE.blockReason),
      ),
  },
];

/** A documented, named capability OMP lacks. */
export interface HostGap {
  /** Stable name the report and the docs cite. */
  readonly id: string;
  /** The `HostCapability.id` it concerns. */
  readonly capability: string;
  /** What the extension cannot do on OMP because of it. */
  readonly summary: string;
  /** The OMP version the gap was observed in. */
  readonly observedIn: string;
}

/**
 * Capabilities OMP was observed NOT to provide. Empty for omp 18.4.6: every
 * required capability held in its run. Host behaviors that are not gaps are
 * asserted as observations by the suite itself, so a doc citing them cites
 * the run rather than memory.
 */
export const OMP_GAPS: readonly HostGap[] = [];

/** One case the conformance suite registers. */
export type ConformanceCase =
  | { readonly kind: "verify"; readonly capability: HostCapability }
  | { readonly kind: "unsupported"; readonly capability: HostCapability; readonly gap: HostGap };

/**
 * A documented gap turns its capability into an UNSUPPORTED case -- reported
 * as such and never verified, so it can never be counted as a pass.
 * Everything else must be verified against the run.
 */
export function conformanceCases(
  capabilities: readonly HostCapability[],
  gaps: readonly HostGap[],
): ConformanceCase[] {
  return capabilities.map((capability) => {
    const gap = gaps.find((candidate) => candidate.capability === capability.id);
    return gap ? { kind: "unsupported", capability, gap } : { kind: "verify", capability };
  });
}

/** Ids of verified capabilities the observation does not show. */
export function missingCapabilities(
  observed: HostObservation,
  capabilities: readonly HostCapability[],
  gaps: readonly HostGap[],
): string[] {
  return conformanceCases(capabilities, gaps)
    .filter((entry) => entry.kind === "verify" && !entry.capability.holds(observed))
    .map((entry) => entry.capability.id);
}

/**
 * Recorded gaps that the observation shows OMP actually provides, or that
 * name no required capability. Either way the record is wrong, and a wrong
 * gap record is how a later reader decides not to rely on something that
 * works -- or keeps a workaround nobody needs.
 */
export function staleGaps(
  observed: HostObservation,
  capabilities: readonly HostCapability[],
  gaps: readonly HostGap[],
): string[] {
  return gaps
    .filter((gap) => {
      const capability = capabilities.find((candidate) => candidate.id === gap.capability);
      return capability === undefined || capability.holds(observed);
    })
    .map((gap) => gap.id);
}

/** Facts the suite establishes outside the probe, from the run's working tree. */
export interface RunFacts {
  readonly blockedCommandRan: boolean;
}

/** Builds the observation from the probe's records, the model's tool messages and the run's facts. */
export function observe(
  records: readonly ProbeRecord[],
  modelToolMessages: readonly ModelToolMessage[],
  facts: RunFacts,
): HostObservation {
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const first = (kind: string) => records.find((record) => record.kind === kind);
  const newestFirst = [...records].reverse();
  const session = first("session");
  const execute = first("tool-execute");
  const blocked = first("blocked");
  return {
    events: records
      .filter((record) => record.kind === "event")
      .map((record) => ({
        name: String(record.name),
        toolName: record.toolName,
        toolCallId: record.toolCallId,
        isError: record.isError,
        prompt: record.prompt,
      })),
    api: strings(first("api")?.members),
    ui: strings(session?.ui),
    hasUI: session?.hasUI,
    cliFlag: session?.flag,
    sessionIdType: String(session?.sessionIdType ?? "absent"),
    tools: strings(newestFirst.find((record) => record.kind === "tools")?.names),
    commands: strings(newestFirst.find((record) => record.kind === "commands")?.names),
    execute: execute
      ? {
          toolCallIdType: String(execute.toolCallIdType),
          abortSignalAt: typeof execute.abortSignalAt === "number" ? execute.abortSignalAt : -1,
          ctxAt: typeof execute.ctxAt === "number" ? execute.ctxAt : -1,
          ctxSessionIdType: String(execute.ctxSessionIdType),
        }
      : undefined,
    toolResults: records
      .filter((record) => record.kind === "tool_result")
      .map((record) => ({
        toolName: record.toolName,
        toolCallId: record.toolCallId,
        command: record.command,
        isError: record.isError,
        text: typeof record.text === "string" ? record.text : "",
      })),
    blockedCallId: typeof blocked?.toolCallId === "string" ? blocked.toolCallId : undefined,
    blockedCommandRan: facts.blockedCommandRan,
    commandRan: records.some((record) => record.kind === "command-ran"),
    modelToolMessages,
  };
}
