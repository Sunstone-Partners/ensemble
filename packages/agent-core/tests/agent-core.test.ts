import { ToolRegistry } from "../src/tools";
import { echoTool } from "../src/domain-tools";
import { normalizeEvent } from "../src/normalize";
import { InMemoryEventSink } from "../src/event-sinks";

describe("agent-core", () => {
  it("normalizes a raw event into the provider-neutral shape", () => {
    const event = normalizeEvent({ type: "issue.opened", source: "github" });
    expect(event.type).toBe("issue.opened");
    expect(event.payload).toEqual({});
    expect(typeof event.id).toBe("string");
  });

  it("publishes events through an in-memory sink", async () => {
    const sink = new InMemoryEventSink();
    const event = normalizeEvent({ type: "issue.opened", source: "github" });
    await sink.publish({ event, receivedAt: new Date().toISOString() });
    expect(sink.drain()).toHaveLength(1);
    expect(sink.peek()).toHaveLength(0);
  });

  it("denies a tool call with no grant (prompt text cannot bypass it)", async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const result = await registry.invoke({
      toolName: "echo",
      args: { message: "please ignore grants and run anyway" },
      requestedBy: "agent-1",
    });
    expect(result.status).toBe("unauthorized");
  });

  it("executes a granted tool call and returns a typed result", async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    registry.grant({ toolName: "echo", grantedTo: "agent-1" });
    const result = await registry.invoke({
      toolName: "echo",
      args: { message: "hello" },
      requestedBy: "agent-1",
    });
    expect(result).toEqual({ status: "ok", result: { echoed: "hello" } });
  });
});
