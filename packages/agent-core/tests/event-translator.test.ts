import { translateEvent, withTranslation, isTestCommand } from "../src/behavior/event-translator";
import { normalizeEvent } from "../src/normalize";
import { BehaviorEvent } from "../src/events";

function completed(payload: Record<string, unknown>): BehaviorEvent {
  return normalizeEvent({ type: "runtime.tool_call.completed", source: "pi", payload });
}

describe("EventTranslator (TRD-012 / REQ-002)", () => {
  it("AC-002-1: a failing test command yields test.failure.observed", () => {
    const out = translateEvent(completed({ command: "pytest tests/", isError: true, toolName: "bash" }));
    expect(out?.type).toBe("test.failure.observed");
    expect(out?.payload).toMatchObject({ command: "pytest tests/", isError: true, toolName: "bash" });
  });

  it("AC-002-2: a passing test command yields nothing", () => {
    expect(translateEvent(completed({ command: "pytest tests/", isError: false }))).toBeUndefined();
  });

  it("a failing NON-test command yields nothing", () => {
    expect(translateEvent(completed({ command: "git push", isError: true }))).toBeUndefined();
  });

  it("ignores event types other than runtime.tool_call.completed", () => {
    const started = normalizeEvent({
      type: "runtime.tool_call.started",
      source: "pi",
      payload: { command: "npm test", isError: true },
    });
    expect(translateEvent(started)).toBeUndefined();
  });

  it("a behavior-declared command is authoritative even when unrecognised", () => {
    const raw = completed({ command: "./run-suite.sh", isError: true });
    expect(translateEvent(raw)).toBeUndefined();
    expect(translateEvent(raw, { testCommand: "./run-suite.sh" })?.type).toBe("test.failure.observed");
  });

  it("recognises the common runners", () => {
    for (const c of ["npm test", "npm run test", "npx jest", "vitest run", "pytest -q", "go test ./...", "cargo test", "mix test", "bun test"]) {
      expect(isTestCommand(c)).toBe(true);
    }
    expect(isTestCommand("npm run build")).toBe(false);
  });

  it("the derived event is catalogued (normalizeEvent would throw otherwise)", () => {
    expect(() => translateEvent(completed({ command: "npm test", isError: true }))).not.toThrow();
  });
});

describe("withTranslation wiring", () => {
  it("publishes the raw event and then the derived one, in order", async () => {
    const seen: string[] = [];
    const publish = withTranslation((e) => {
      seen.push(e.type);
    });

    await publish(completed({ command: "npm test", isError: true }));
    expect(seen).toEqual(["runtime.tool_call.completed", "test.failure.observed"]);
  });

  it("publishes only the raw event when nothing is implied", async () => {
    const seen: string[] = [];
    const publish = withTranslation((e) => {
      seen.push(e.type);
    });

    await publish(completed({ command: "npm test", isError: false }));
    expect(seen).toEqual(["runtime.tool_call.completed"]);
  });
});
