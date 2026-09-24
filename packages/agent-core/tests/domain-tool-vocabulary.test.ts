import { ToolRegistry } from "../src/tools";
import {
  recordObservationTool,
  domainToolVocabulary,
  DomainToolAccepted,
} from "../src/behavior/domain-tool-vocabulary";
import { HARNESS_EVENT_TYPES, DOMAIN_TOOL_EVENT_MAPPING } from "../src/behavior/event-catalog";

async function invokeAsGranted(toolName: string, args: Record<string, unknown>) {
  const registry = new ToolRegistry();
  registry.register(domainToolVocabulary.find((t) => t.name === toolName)!);
  registry.grant({ toolName, grantedTo: "agent-1" });
  return registry.invoke({ toolName, args, requestedBy: "agent-1" });
}

describe("typed domain tool vocabulary (TRD-015)", () => {
  it("AC-015-1: ensemble.record_observation with a payload matching behavior.observation.recorded validates and is accepted", async () => {
    const result = await invokeAsGranted("ensemble.record_observation", {
      eventType: "behavior.observation.recorded",
      payload: { summary: "observed a thing" },
      evidence: ["artifact://report/1"],
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const accepted: DomainToolAccepted = result.result as DomainToolAccepted;
      expect(accepted.status).toBe("accepted");
      expect(accepted.event.type).toBe("behavior.observation.recorded");
    }
  });

  it("AC-015-2: a domain tool called with a runtime.* event type is rejected — the model cannot select an arbitrary event type", async () => {
    const result = await invokeAsGranted("ensemble.record_observation", {
      eventType: "runtime.session.completed",
      payload: {},
      evidence: ["artifact://x"],
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toMatch(/unauthorized/);
      expect(result.error).toMatch(/harness-owned/);
    }
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

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toMatch(/not in ensemble\.record_observation's permitted/);
    }
  });

  it("rejects a call with no evidence as malformed", async () => {
    const result = await invokeAsGranted("ensemble.record_observation", {
      eventType: "behavior.observation.recorded",
      payload: {},
      evidence: [],
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toMatch(/malformed/);
    }
  });

  it("no domain tool's permitted mapping includes any runtime.* harness event", () => {
    for (const [toolName, permitted] of Object.entries(DOMAIN_TOOL_EVENT_MAPPING)) {
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

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const accepted: DomainToolAccepted = result.result as DomainToolAccepted;

    expect(accepted.event.id).not.toBe("agent-forged-id");
    expect(accepted.event.occurredAt).not.toBe("1970-01-01T00:00:00.000Z");
    expect(accepted.event.sessionId).toBe("agent-1"); // runtime-derived requestedBy, not the forged value
    expect(accepted.event.deduplicationKey).not.toBe("agent-forged-dedupe");
    // The forged raw keys must not even survive into payload verbatim.
    const payload = accepted.event.payload;
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
    const request2 = {
      ...request1,
      args: { ...request1.args, payload: { summary: "second" } },
    };

    const result1 = await registry.invoke(request1);
    const result2 = await registry.invoke(request2);

    expect(result1.status).toBe("ok");
    expect(result2.status).toBe("ok");
    if (result1.status !== "ok" || result2.status !== "ok") return;

    const accepted1: DomainToolAccepted = result1.result as DomainToolAccepted;
    const accepted2: DomainToolAccepted = result2.result as DomainToolAccepted;
    const event1 = accepted1.event;
    const event2 = accepted2.event;

    expect(event1.executionId).toBe(executionId);
    expect(event2.executionId).toBe(executionId);
    expect(event1.correlationId).toBe(executionId);
    expect(event1.sessionId).toBe("session-abc");
    expect(event2.sessionId).toBe("session-abc");
    // Never agent-supplied: neither request's args carried executionId or
    // sessionId — both came only from the runtime-controlled request object.
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

    expect(result1.status).toBe("ok");
    expect(result2.status).toBe("ok");
    if (result1.status !== "ok" || result2.status !== "ok") return;
    const accepted1: DomainToolAccepted = result1.result as DomainToolAccepted;
    const accepted2: DomainToolAccepted = result2.result as DomainToolAccepted;
    const event1 = accepted1.event;
    const event2 = accepted2.event;
    expect(event1.executionId).not.toBe(event2.executionId);
  });
});
