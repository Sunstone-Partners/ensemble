import {
  HostGap,
  ModelToolMessage,
  OMP_GAPS,
  PROBE,
  ProbeRecord,
  REQUIRED_HOST_CAPABILITIES,
  RunFacts,
  conformanceCases,
  missingCapabilities,
  observe,
  staleGaps,
} from "./host-capabilities";

/**
 * The OMP suite's bookkeeping, checked without OMP (TRD-031). The live suite
 * can only be as honest as these rules: a capability the run did not show
 * must come out missing, a documented gap must come out unsupported rather
 * than passed, and a gap OMP really provides must be caught as stale.
 */

const BLOCKED_ID = "call_0_2";

/** The records an omp 18.4.6 probe run produced, reduced to what observe() reads. */
const RECORDED: ProbeRecord[] = [
  { kind: "api", members: ["getAllTools", "getCommands", "getFlag", "on", "registerCommand", "registerFlag", "registerTool"] },
  { kind: "event", name: "session_start" },
  { kind: "session", flag: true, sessionIdType: "string", hasUI: false, ui: ["confirm", "notify", "select", "setStatus"] },
  { kind: "event", name: "before_agent_start", prompt: PROBE.prompt },
  { kind: "event", name: "tool_call", toolName: "bash", toolCallId: "call_0_0" },
  { kind: "event", name: "tool_call", toolName: "bash", toolCallId: BLOCKED_ID },
  { kind: "blocked", toolCallId: BLOCKED_ID },
  { kind: "event", name: "tool_execution_start", toolName: "bash", toolCallId: "call_0_0" },
  { kind: "tool-execute", toolCallIdType: "string", abortSignalAt: 2, ctxAt: 4, ctxSessionIdType: "string" },
  { kind: "event", name: "tool_result", toolName: "bash", toolCallId: "call_0_0", isError: false },
  { kind: "tool_result", toolName: "bash", toolCallId: "call_0_0", command: PROBE.echoCommand, isError: false, text: `${PROBE.echoOutput}\n` },
  { kind: "event", name: "tool_execution_end", toolName: "bash", toolCallId: "call_0_0", isError: false },
  { kind: "event", name: "agent_end" },
  { kind: "tools", names: ["bash", PROBE.tool] },
  { kind: "commands", names: [PROBE.command] },
  { kind: "event", name: "session_shutdown" },
  { kind: "command-ran" },
];

/** The blocked call's tool message, as the model received it. */
const MODEL_SAW: ModelToolMessage[] = [{ toolCallId: BLOCKED_ID, content: PROBE.blockReason }];
const CLEAN: RunFacts = { blockedCommandRan: false };

const missing = (
  records: readonly ProbeRecord[],
  toolMessages: readonly ModelToolMessage[] = MODEL_SAW,
  facts: RunFacts = CLEAN,
  gaps: readonly HostGap[] = OMP_GAPS,
) => missingCapabilities(observe(records, toolMessages, facts), REQUIRED_HOST_CAPABILITIES, gaps);

const withoutEvent = (name: string) => (records: readonly ProbeRecord[]) =>
  records.filter((r) => !(r.kind === "event" && r.name === name));

const patched = (match: (r: ProbeRecord) => boolean, patch: Record<string, unknown>) => (records: readonly ProbeRecord[]) =>
  records.map((r) => (match(r) ? { ...r, ...patch } : r));

const isEvent = (name: string) => (r: ProbeRecord) => r.kind === "event" && r.name === name;
const isKind = (kind: string) => (r: ProbeRecord) => r.kind === kind;

interface Knockout {
  readonly records?: (records: readonly ProbeRecord[]) => ProbeRecord[];
  readonly toolMessages?: readonly ModelToolMessage[];
  readonly facts?: RunFacts;
  /** Capabilities that legitimately fail with it, because one implies the other. */
  readonly alsoMissing?: readonly string[];
}

/** One way to break each capability. Keyed by id so a new capability cannot land without one. */
const KNOCKOUTS: Record<string, Knockout> = {
  "event:session_start": { records: withoutEvent("session_start") },
  "event:before_agent_start": { records: withoutEvent("before_agent_start"), alsoMissing: ["fields:before_agent_start"] },
  "event:tool_call": { records: withoutEvent("tool_call"), alsoMissing: ["fields:tool_call"] },
  "event:tool_execution_start": { records: withoutEvent("tool_execution_start") },
  "event:tool_execution_end": { records: withoutEvent("tool_execution_end") },
  "event:tool_result": { records: withoutEvent("tool_result") },
  "event:agent_end": { records: withoutEvent("agent_end") },
  "event:session_shutdown": { records: withoutEvent("session_shutdown") },
  "fields:tool_call": { records: patched(isEvent("tool_call"), { toolName: undefined }) },
  "fields:tool_execution": { records: patched(isEvent("tool_execution_end"), { isError: undefined }) },
  "fields:before_agent_start": { records: patched(isEvent("before_agent_start"), { prompt: "something else" }) },
  "fields:tool_result": { records: patched(isKind("tool_result"), { toolCallId: undefined }) },
  "api:registerTool": { records: patched(isKind("api"), { members: ["getFlag", "on", "registerCommand", "registerFlag"] }) },
  "tool:abort-signal": { records: patched(isKind("tool-execute"), { abortSignalAt: 4 }) },
  "tool:execute-context": { records: patched(isKind("tool-execute"), { ctxAt: 3 }) },
  "api:registerCommand": { records: (records) => records.filter((r) => r.kind !== "command-ran") },
  "api:registerFlag+cli": { records: patched(isKind("session"), { flag: false }) },
  "ctx:sessionManager.getSessionId": { records: patched(isKind("session"), { sessionIdType: "absent" }) },
  "ctx:ui-members": { records: patched(isKind("session"), { ui: ["notify", "select", "setStatus"] }) },
  "ctx:hasUI": { records: patched(isKind("session"), { hasUI: undefined }) },
  "tool_call:block": { facts: { blockedCommandRan: true } },
};

describe("OMP conformance bookkeeping (TRD-031)", () => {
  it("passes a run that shows every required capability", () => {
    expect(missing(RECORDED)).toEqual([]);
  });

  it("has a knockout for every required capability", () => {
    expect(Object.keys(KNOCKOUTS).sort()).toEqual(REQUIRED_HOST_CAPABILITIES.map((c) => c.id).sort());
  });

  it.each(Object.entries(KNOCKOUTS))("reports %s missing when the run does not show it", (id, knockout) => {
    const expected = REQUIRED_HOST_CAPABILITIES.map((c) => c.id).filter((c) => c === id || knockout.alsoMissing?.includes(c));

    const actual = missing(knockout.records?.(RECORDED) ?? RECORDED, knockout.toolMessages ?? MODEL_SAW, knockout.facts ?? CLEAN);

    expect(actual).toEqual(expected);
  });

  it("does not count a block as working when the model never saw the reason, or saw it for another call", () => {
    expect(missing(RECORDED, [])).toEqual(["tool_call:block"]);
    expect(missing(RECORDED, [{ toolCallId: "call_0_0", content: PROBE.blockReason }])).toEqual(["tool_call:block"]);
  });

  it("turns a documented gap into an unsupported case that is never verified", () => {
    const gap: HostGap = {
      id: "OMP-GAP-EXAMPLE",
      capability: "event:tool_result",
      summary: "tool results are not delivered to extensions",
      observedIn: "omp/0.0.0",
    };

    const entry = conformanceCases(REQUIRED_HOST_CAPABILITIES, [gap]).find((c) => c.capability.id === "event:tool_result");
    expect(entry).toMatchObject({ kind: "unsupported", gap: { id: "OMP-GAP-EXAMPLE" } });
    // A host lacking it is neither failed nor passed for it: the case is reported as unsupported.
    expect(missing(withoutEvent("tool_result")(RECORDED), MODEL_SAW, CLEAN, [gap])).toEqual([]);
  });

  it("calls a recorded gap stale when OMP provides it, or when it names nothing required", () => {
    const gaps: HostGap[] = [
      { id: "STALE", capability: "event:tool_result", summary: "s", observedIn: "omp/0.0.0" },
      { id: "UNKNOWN", capability: "event:never-required", summary: "s", observedIn: "omp/0.0.0" },
    ];

    expect(staleGaps(observe(RECORDED, MODEL_SAW, CLEAN), REQUIRED_HOST_CAPABILITIES, gaps)).toEqual(["STALE", "UNKNOWN"]);
  });
});
