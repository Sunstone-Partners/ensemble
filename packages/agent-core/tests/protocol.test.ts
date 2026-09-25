import {
  toInvocationResult,
  toInvocationRequest,
  toInvocationEvent,
  assertInvocationContractVersion,
  INVOCATION_CONTRACT_SCHEMA_VERSION,
  InvocationOutcome,
} from "../src/protocol";

describe("toInvocationResult (TRD-008)", () => {
  it("AC-008-1: a completed invocation matches the versioned schema and contains only plain data", () => {
    const outcome: InvocationOutcome = {
      status: "completed",
      output: "done",
      usage: { inputTokens: 10, outputTokens: 5 },
      toolCalls: [{ toolCallId: "call-1", toolName: "echo", custom: true, isError: false }],
    };

    const result = toInvocationResult("exec-1", outcome);

    expect(result.schemaVersion).toBe(INVOCATION_CONTRACT_SCHEMA_VERSION);
    expect(result.executionId).toBe("exec-1");
    expect(result.status).toBe("completed");
    expect(result.failure).toBeUndefined();
    // AC-008-1 "contains no raw Pi-session objects": every field round-trips
    // through JSON with no loss — a raw session object (with methods,
    // circular refs, class instances) would not.
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("AC-008-2: a failed invocation sets status:'failed' and populates a NormalizedFailure", () => {
    const outcome: InvocationOutcome = {
      status: "failed",
      output: "",
      toolCalls: [],
      failure: { code: "TOOL_ERROR", message: "echo tool threw", retryable: false },
    };

    const result = toInvocationResult("exec-2", outcome);

    expect(result.status).toBe("failed");
    expect(result.failure).toEqual({
      code: "TOOL_ERROR",
      message: "echo tool threw",
      retryable: false,
    });
  });

  it("AC-008-2: refuses to build a failed result with no NormalizedFailure", () => {
    const outcome: InvocationOutcome = { status: "failed", output: "", toolCalls: [] };
    expect(() => toInvocationResult("exec-3", outcome)).toThrow(/NormalizedFailure/);
  });
});

describe("invocation contract versioning (TRD-010)", () => {
  it("AC-010-1: InvocationRequest, InvocationEvent, and InvocationResult all carry the explicit schema version", () => {
    const request = toInvocationRequest({
      executionId: "exec-1",
      prompt: "hi",
      context: {},
      tools: [],
      timeoutMs: 1000,
      attempt: 1,
    });
    const event = toInvocationEvent({
      executionId: "exec-1",
      kind: "started",
      occurredAt: new Date().toISOString(),
      payload: {},
    });
    const result = toInvocationResult("exec-1", { status: "completed", output: "", toolCalls: [] });

    expect(request.schemaVersion).toBe(INVOCATION_CONTRACT_SCHEMA_VERSION);
    expect(event.schemaVersion).toBe(INVOCATION_CONTRACT_SCHEMA_VERSION);
    expect(result.schemaVersion).toBe(INVOCATION_CONTRACT_SCHEMA_VERSION);
  });

  it("AC-010-2: a consumer checking an unrecognized schema version fails loudly instead of misreading fields", () => {
    expect(() =>
      assertInvocationContractVersion({ schemaVersion: "ensemble.sunstone.dev/invocation-contract/v0" }),
    ).toThrow(/version mismatch/i);
  });

  it("AC-010-2: a matching schema version passes the assertion", () => {
    expect(() =>
      assertInvocationContractVersion({ schemaVersion: INVOCATION_CONTRACT_SCHEMA_VERSION }),
    ).not.toThrow();
  });
});
