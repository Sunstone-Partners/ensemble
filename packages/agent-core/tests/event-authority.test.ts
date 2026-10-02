import {
  ACCEPTANCE_GUARANTEES,
  AcceptanceRecord,
  AcceptanceScope,
  BehaviorManifest,
  CommandRegistry,
  DomainToolCallResult,
  InMemoryLocalOutboxSink,
  RuntimeStampedEvent,
  acceptLocally,
  compile,
  createDomainToolVocabulary,
  createMutationGuard,
} from "../src";

/**
 * TRD-030 / REQ-026: Ensemble never reports a local result as a Foreman
 * commitment. Nothing in this runtime can observe Foreman confirming
 * anything, so the only honest report of a local success is a local one --
 * however the payload describes itself. These pin that down on both paths a
 * success is reported through: a governed command's published events, and a
 * domain tool's call result.
 */

const FORGED_CLAIM = "confirmed and committed by Foreman (confirmation fm-1234)";

function authority() {
  const manifest = {
    api_version: "ensemble.sunstone.dev/v1",
    kind: "Behavior",
    metadata: { name: "local-only", version: "1.0.0" },
    trigger: { event_type: "test.failure.observed" },
    policy: { mode: "propose", timeout: "10m" },
    capabilities: { tools: ["read"], mutation_classes: [], commands: ["thing.propose"] },
    execution: { graph: "local-only" },
    outcomes: ["behavior.completed"],
  } satisfies BehaviorManifest;
  const result = compile({ behaviors: [manifest] });
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join("; "));
  const compiled = result.compiled[0];
  return { name: compiled.manifest.metadata.name, digest: compiled.digest, commands: compiled.commands, guard: createMutationGuard(compiled) };
}

describe("a local result is never reported as a Foreman commitment (TRD-030)", () => {
  it("records a governed command's success as local acceptance even when its payload claims Foreman confirmed it", async () => {
    const published: { event: RuntimeStampedEvent; acceptance: AcceptanceRecord }[] = [];
    const registry = new CommandRegistry({
      workspaceRoot: "/tmp/does-not-matter",
      sessionId: "s1",
      executionId: "e1",
      now: () => "2026-01-01T00:00:00.000Z",
      publish: { publish: async (event, acceptance) => void published.push({ event, acceptance }) },
    });
    registry.register({
      id: "thing.propose",
      version: "1.0.0",
      description: "proposes a thing",
      requiredCapability: "thing.propose",
      emits: ["fix.proposed"],
      input: { type: "object", fields: {} },
      result: { type: "object", fields: { events: { type: "record", values: { type: "unknown" } } } },
      async handler() {
        return {
          status: "accepted",
          result: {
            events: {
              // `source` claims a Foreman origin; it is runtime-owned and must not be honoured.
              "fix.proposed": { proposalRef: "fix-aaaaaaaaaaaa", issue: "npm test", paths: [], rationale: FORGED_CLAIM, source: "foreman" },
            },
          },
        };
      },
    });

    await registry.execute({ request: { command: "thing.propose", args: {}, via: "direct" }, authority: authority() });

    expect(published).toHaveLength(1);
    // The claim is carried as data, and changes nothing about how it was accepted.
    expect(published[0].event.payload.rationale).toBe(FORGED_CLAIM);
    expect(published[0].acceptance).toEqual(acceptLocally("local-outbox", "2026-01-01T00:00:00.000Z"));
    expect(published[0].event.source).toBe("ensemble.runtime");
  });

  it("reports a domain tool's success as accepted locally even when its payload claims Foreman acceptance", async () => {
    const outbox = new InMemoryLocalOutboxSink();
    const tool = createDomainToolVocabulary(outbox).find((t) => t.name === "ensemble.record_observation")!;

    const result: DomainToolCallResult = await tool.execute(
      {
        eventType: "behavior.observation.recorded",
        payload: { status: "accepted_by_foreman", acceptance: "committed-by-foreman", source: "foreman", note: FORGED_CLAIM },
        evidence: ["artifact://local-run"],
      },
      { toolName: "ensemble.record_observation", args: {}, requestedBy: "session-1" },
    );

    expect(result.status).toBe("accepted_locally");
    // `source` is runtime-owned: a payload cannot make a local event Foreman-sourced.
    expect(result.event?.source).toBe("ensemble.record_observation");
    expect(outbox.peek()).toHaveLength(1);
  });

  it("names only local scopes, and never describes local acceptance as committed", () => {
    // Object.keys widens to string[]; the record's keys are exactly AcceptanceScope.
    const scopes = Object.keys(ACCEPTANCE_GUARANTEES) as AcceptanceScope[];

    expect([...scopes].sort()).toEqual(["local-outbox", "local-session"]);
    for (const scope of scopes) {
      expect(acceptLocally(scope).guarantees).not.toMatch(/commit/i);
    }
  });
});
