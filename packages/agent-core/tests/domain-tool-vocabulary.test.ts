import { ToolRegistry } from "../src/tools";
import {
  recordObservationTool,
  domainToolVocabulary,
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
      const accepted = result.result as { status: string; event: { type: string } };
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
