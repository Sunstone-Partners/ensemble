import { ToolRegistry, echoTool } from "@sunstone-partners/ensemble-agent-core";

export interface EchoToolCallResult {
  content: { type: "text"; text: string }[];
  details: unknown;
}

/**
 * Core call-handling logic for the registered `echo` tool, extracted
 * from `extension.ts` so both grant branches (AC-005-1 granted/executes,
 * AC-005-2 ungranted/denied) are directly unit-testable without going
 * through Pi's CLI flag parsing. `extension.ts` wires `granted` to a
 * real `pi.registerFlag`/`pi.getFlag` CLI flag — not to anything the
 * agent's own prompt or tool-call arguments can set.
 */
export async function handleEchoToolCall(
  registry: ToolRegistry,
  sessionId: string,
  granted: boolean,
  message: string,
): Promise<EchoToolCallResult> {
  if (granted) {
    registry.grant({ toolName: echoTool.name, grantedTo: sessionId });
  }

  const result = await registry.invoke({
    toolName: echoTool.name,
    args: { message },
    requestedBy: sessionId,
  });

  if (result.status === "unauthorized") {
    throw new Error(`unauthorized: ${result.reason}`);
  }
  if (result.status === "error") {
    throw new Error(result.error);
  }

  return { content: [{ type: "text", text: JSON.stringify(result.result) }], details: result.result };
}
