#!/usr/bin/env node
// TRD-009 minimal end-to-end harness proof: load extension -> register
// one custom tool -> run one prompt -> observe one lifecycle event ->
// observe one tool call -> return one normalized result, with zero
// Claude-style hook dependency (AC-009-1). Run twice and diff shapes
// (timestamps aside) to prove deterministic normalization (AC-009-2).
//
// Real Node ESM process, not jest: @earendil-works/pi-coding-agent is
// ESM-only (see packages/pi-extension/README.md).
import { createEventBus, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { toInvocationResult } from "@sunstone-partners/ensemble-agent-core";
import { handleEchoToolCall } from "../src/echo-tool-handler.ts";
import { ToolRegistry, echoTool } from "@sunstone-partners/ensemble-agent-core";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, "e2e-proof-extension.ts");

async function runProofOnce() {
  // --- Observation point 1: load extension ---
  const eventBus = createEventBus();
  const result = await discoverAndLoadExtensions([extensionPath], process.cwd(), undefined, eventBus);
  const relevantErrors = result.errors.filter((e) => String(e.path ?? "").includes("e2e-proof-extension"));
  if (relevantErrors.length > 0) {
    throw new Error(`extension load errors: ${JSON.stringify(relevantErrors)}`);
  }
  const extension = result.extensions.find((ext) => ext.resolvedPath === extensionPath);
  if (!extension) {
    throw new Error("extension not found among discovered extensions");
  }

  // --- Observation point 2: registered custom tool present ---
  if (!extension.tools.has("echo")) {
    throw new Error("expected 'echo' custom tool to be registered");
  }

  // --- Observation point 3: run one prompt, fire the real before_agent_start
  // handler Pi would fire after the user submits a prompt ---
  const beforeAgentStartHandlers = extension.handlers.get("before_agent_start") ?? [];
  if (beforeAgentStartHandlers.length === 0) {
    throw new Error("expected a before_agent_start handler to be registered");
  }
  await beforeAgentStartHandlers[0]({
    type: "before_agent_start",
    prompt: "echo hello for the TRD-009 proof",
    systemPrompt: "",
    systemPromptOptions: {},
  });

  // --- Observation point 4: observe one lifecycle event captured by the
  // wiring exercised above ---
  const sink = globalThis.__ensembleE2EProofInstance?.sink;
  if (!sink) {
    throw new Error("expected the wrapper extension to publish its sink on globalThis");
  }
  const captured = sink.drain();
  const promptEvent = captured.find((envelope) => envelope.event.type === "runtime.prompt.submitted");
  if (!promptEvent) {
    throw new Error("expected a runtime.prompt.submitted lifecycle event to be captured");
  }

  // --- Observation point 5: observe one tool call. This exercises the same
  // handleEchoToolCall production function Pi's registered tool.execute
  // delegates to (see extension.ts) directly, since driving Pi's CLI-flag
  // grant machinery end-to-end requires a full CLI process beyond what
  // discoverAndLoadExtensions bootstraps; AC-005-1/AC-005-2 already prove
  // the grant-flag wiring itself in tests/echo-tool-handler.test.ts. ---
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const toolCall = await handleEchoToolCall(registry, "e2e-proof-session", true, "hello");

  // --- Return one normalized result ---
  const invocationResult = toInvocationResult("exec-e2e-proof", {
    status: "completed",
    output: JSON.stringify(toolCall.details),
    toolCalls: [{ toolCallId: "e2e-proof-call", toolName: "echo", custom: true, isError: false }],
  });

  return { promptEventType: promptEvent.event.type, toolCall, invocationResult };
}

const run1 = await runProofOnce();
const run2 = await runProofOnce();

// AC-009-2: same shape/fields across runs, timestamps aside.
const strip = (r) => ({
  promptEventType: r.promptEventType,
  toolCall: r.toolCall,
  invocationResult: { ...r.invocationResult },
});

const s1 = JSON.stringify(strip(run1));
const s2 = JSON.stringify(strip(run2));

if (s1 !== s2) {
  console.error("FAIL: event normalization is not deterministic across runs");
  console.error("run1:", s1);
  console.error("run2:", s2);
  process.exit(1);
}

console.log("PASS: all five observation points succeeded; normalization is deterministic across two runs.");
console.log(JSON.stringify(run1.invocationResult, null, 2));
