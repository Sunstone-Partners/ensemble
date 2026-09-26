import { ToolRegistry } from "../src/tools";
import {
  recordObservationTool,
  domainToolVocabulary,
  createDomainToolVocabulary,
  defaultLocalOutbox,
  DomainToolCallResult,
} from "../src/behavior/domain-tool-vocabulary";
import { HARNESS_EVENT_TYPES, DOMAIN_TOOL_EVENT_MAPPING } from "../src/behavior/event-catalog";
import { InMemoryLocalOutboxSink, LocalOutboxSink } from "../src/behavior/outbox";

async function invokeAsGranted(toolName: string, args: Record<string, unknown>) {
  const registry = new ToolRegistry();
  registry.register(domainToolVocabulary.find((t) => t.name === toolName)!);
  registry.grant({ toolName, grantedTo: "agent-1" });
  const result = await registry.invoke({ toolName, args, requestedBy: "agent-1" });
  if (result.status !== "ok") {
    throw new Error(`unexpected registry-level status: ${result.status}`);
  }
  return result.result as DomainToolCallResult;
}

describe("typed domain tool vocabulary (TRD-015)", () => {
  it("AC-015-1: ensemble.record_observation with a payload matching behavior.observation.recorded validates and is accepted", async () => {
    const result = await invokeAsGranted("ensemble.record_observation", {
      eventType: "behavior.observation.recorded",
      payload: { summary: "observed a thing" },
      evidence: ["artifact://report/1"],
    });

    expect(result.status).toBe("accepted_locally");
    expect(result.event?.type).toBe("behavior.observation.recorded");
  });

  it("AC-015-2: a domain tool called with a runtime.* event type is rejected — the model cannot select an arbitrary event type", async () => {
    const result = await invokeAsGranted("ensemble.record_observation", {
      eventType: "runtime.session.completed",
      payload: {},
      evidence: ["artifact://x"],
    });

    expect(result.status).toBe("unauthorized");
    expect(result.reason).toMatch(/harness-owned/);
  });

  it("AC-015-2: a domain tool called with an event type outside its own permitted mapping (but valid for another tool) is rejected", async () => {
    // "test.passed" is in ensemble.record_outcome's mapping, not
    // ensemble.record_observation's — proves per-tool scoping, not just
    // a single global allowlist.
    const result = await invokeAsGranted("ensemble.record_observation", {
      eventType: "test.passed",
      payload: {},
      evidence: ["artifact://x"],
    });

    expect(result.status).toBe("unauthorized");
    expect(result.reason).toMatch(/not in ensemble\.record_observation's permitted/);
  });

  it("rejects a call with no evidence as malformed", async () => {
    const result = await invokeAsGranted("ensemble.record_observation", {
      eventType: "behavior.observation.recorded",
      payload: {},
      evidence: [],
    });

    expect(result.status).toBe("malformed");
  });

  it("no domain tool's permitted mapping includes any runtime.* harness event", () => {
    for (const permitted of Object.values(DOMAIN_TOOL_EVENT_MAPPING)) {
      for (const harnessType of HARNESS_EVENT_TYPES) {
        expect(permitted).not.toContain(harnessType);
      }
    }
  });

  it("all five typed domain tools exist and are independently registerable", () => {
    expect(domainToolVocabulary.map((t) => t.name).sort()).toEqual(
      [
        "ensemble.propose_change",
        "ensemble.record_observation",
        "ensemble.record_outcome",
        "ensemble.report_blocked",
        "ensemble.request_approval",
      ].sort(),
    );
    expect(recordObservationTool.name).toBe("ensemble.record_observation");
  });
});

describe("runtime-owned event metadata (TRD-016)", () => {
  it("AC-016-1: agent-supplied event_id/occurred_at (and other reserved fields) are ignored — the runtime assigns its own", async () => {
    const result = await invokeAsGranted("ensemble.record_observation", {
      eventType: "behavior.observation.recorded",
      payload: {
        summary: "legit content",
        event_id: "agent-forged-id",
        occurred_at: "1970-01-01T00:00:00.000Z",
        session_id: "agent-forged-session",
        deduplication_key: "agent-forged-dedupe",
      },
      evidence: ["artifact://x"],
    });

    expect(result.status).toBe("accepted_locally");
    const event = result.event!;

    expect(event.id).not.toBe("agent-forged-id");
    expect(event.occurredAt).not.toBe("1970-01-01T00:00:00.000Z");
    expect(event.sessionId).toBe("agent-1"); // runtime-derived requestedBy, not the forged value
    expect(event.deduplicationKey).not.toBe("agent-forged-dedupe");
    const payload = event.payload;
    expect(payload.event_id).toBeUndefined();
    expect(payload.occurred_at).toBeUndefined();
    expect(payload.session_id).toBeUndefined();
    expect(payload.summary).toBe("legit content");
  });

  it("AC-016-2: executionId and sessionId are consistently runtime-derived across two invocations of the same tool", async () => {
    const registry = new ToolRegistry();
    registry.register(domainToolVocabulary.find((t) => t.name === "ensemble.record_observation")!);
    registry.grant({ toolName: "ensemble.record_observation", grantedTo: "session-abc" });

    const executionId = "exec-shared-123";
    const request1 = {
      toolName: "ensemble.record_observation",
      args: {
        eventType: "behavior.observation.recorded",
        payload: { summary: "first" },
        evidence: ["artifact://a"],
      },
      requestedBy: "session-abc",
      executionId,
    };
    const request2 = { ...request1, args: { ...request1.args, payload: { summary: "second" } } };

    const registryResult1 = await registry.invoke(request1);
    const registryResult2 = await registry.invoke(request2);
    if (registryResult1.status !== "ok" || registryResult2.status !== "ok") {
      throw new Error("expected ok registry status");
    }
    const result1 = registryResult1.result as DomainToolCallResult;
    const result2 = registryResult2.result as DomainToolCallResult;

    expect(result1.event?.executionId).toBe(executionId);
    expect(result2.event?.executionId).toBe(executionId);
    expect(result1.event?.correlationId).toBe(executionId);
    expect(result1.event?.sessionId).toBe("session-abc");
    expect(result2.event?.sessionId).toBe("session-abc");
    expect(request1.args).not.toHaveProperty("executionId");
    expect(request1.args).not.toHaveProperty("sessionId");
  });

  it("AC-016-2: two different executions of the same tool get distinct, runtime-generated execution ids when none is supplied", async () => {
    const result1 = await invokeAsGranted("ensemble.record_observation", {
      eventType: "behavior.observation.recorded",
      payload: {},
      evidence: ["artifact://a"],
    });
    const result2 = await invokeAsGranted("ensemble.record_observation", {
      eventType: "behavior.observation.recorded",
      payload: {},
      evidence: ["artifact://b"],
    });
    expect(result1.event?.executionId).not.toBe(result2.event?.executionId);
  });
});

describe("local outbox with distinguished acceptance states (TRD-017)", () => {
  it("AC-017-1: in local-only mode, a successful call is always status 'accepted_locally', never 'accepted_by_foreman'", async () => {
    const result = await invokeAsGranted("ensemble.record_observation", {
      eventType: "behavior.observation.recorded",
      payload: {},
      evidence: ["artifact://a"],
    });
    expect(result.status).toBe("accepted_locally");
  });

  it("AC-017-1: the accepted event is appended to the local outbox before returning", async () => {
    const outbox = new InMemoryLocalOutboxSink();
    const [tool] = createDomainToolVocabulary(outbox);
    const registry = new ToolRegistry();
    registry.register(tool);
    registry.grant({ toolName: tool.name, grantedTo: "agent-1" });

    await registry.invoke({
      toolName: tool.name,
      args: {
        eventType: "behavior.observation.recorded",
        payload: {},
        evidence: ["artifact://a"],
      },
      requestedBy: "agent-1",
    });

    expect(outbox.peek()).toHaveLength(1);
    expect(outbox.peek()[0].type).toBe("behavior.observation.recorded");
  });

  it("AC-017-2: when the local outbox cannot write, the result is 'rejected', never a false 'accepted_locally' claim", async () => {
    const failingOutbox: LocalOutboxSink = {
      async append() {
        throw new Error("simulated disk-full failure");
      },
    };
    const [tool] = createDomainToolVocabulary(failingOutbox);
    const registry = new ToolRegistry();
    registry.register(tool);
    registry.grant({ toolName: tool.name, grantedTo: "agent-1" });

    const registryResult = await registry.invoke({
      toolName: tool.name,
      args: {
        eventType: "behavior.observation.recorded",
        payload: {},
        evidence: ["artifact://a"],
      },
      requestedBy: "agent-1",
    });
    if (registryResult.status !== "ok") throw new Error("expected ok registry status");
    const result = registryResult.result as DomainToolCallResult;

    expect(result.status).toBe("rejected");
    expect(result.status).not.toBe("accepted_locally");
    expect(result.reason).toMatch(/simulated disk-full failure/);
  });

  it("the module-level default singleton tools share one default in-memory outbox", async () => {
    await invokeAsGranted("ensemble.record_outcome", {
      eventType: "test.passed",
      payload: {},
      evidence: ["artifact://a"],
    });
    expect(defaultLocalOutbox.peek().some((e) => e.type === "test.passed")).toBe(true);
  });
});
