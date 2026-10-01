import {
  buildConstitutionPrompt,
  parseConstitutionReply,
  DEFAULT_CONSTITUTION_PROMPT,
} from "../src/agent-constitution-provider";

/**
 * The parser for step 3. Its job is mostly to say NO.
 *
 * A bad fix is caught by the suite and rolled back. A bad amendment becomes
 * a standing rule governing every future run, and nothing downstream tests
 * it -- so every ambiguity here resolves to "no amendment".
 */

describe("parseConstitutionReply", () => {
  it("accepts a well-formed amendment", () => {
    const reply = [
      "Looks systemic.",
      "```json",
      '{ "rationale": "exit status of a pipeline is not the suite\'s status",',
      '  "rule": "- Verification MUST NOT rely on the exit status of a pipeline." }',
      "```",
    ].join("\n");

    const change = parseConstitutionReply(reply, "fix-failing-test");

    expect(change).toEqual({
      behaviorName: "fix-failing-test",
      rationale: "exit status of a pipeline is not the suite's status",
      diff: "- Verification MUST NOT rely on the exit status of a pipeline.",
    });
  });

  it("accepts bare JSON with no fence", () => {
    const change = parseConstitutionReply('{"rationale":"r","rule":"- Do the thing."}', "b");
    expect(change?.diff).toBe("- Do the thing.");
  });

  it("returns nothing for the explicit refusal", () => {
    expect(parseConstitutionReply("NO_AMENDMENT", "b")).toBeUndefined();
  });

  it("prefers the refusal even when JSON is also present", () => {
    // A model that hedges must not get an amendment through by attaching
    // one to a refusal.
    const reply = 'NO_AMENDMENT\n```json\n{"rationale":"r","rule":"- x"}\n```';
    expect(parseConstitutionReply(reply, "b")).toBeUndefined();
  });

  it.each([
    ["prose", "I think we should probably add a rule about timeouts."],
    ["malformed JSON", "```json\n{rationale: 'r', rule: '- x'}\n```"],
    ["missing rule", '```json\n{"rationale":"r"}\n```'],
    ["missing rationale", '```json\n{"rule":"- x"}\n```'],
    ["empty rule", '```json\n{"rationale":"r","rule":"   "}\n```'],
    ["wrong types", '```json\n{"rationale":1,"rule":2}\n```'],
    ["empty reply", ""],
  ])("returns nothing for %s", (_label, reply) => {
    expect(parseConstitutionReply(reply, "b")).toBeUndefined();
  });
});

describe("buildConstitutionPrompt", () => {
  it("carries the command and the failure output", () => {
    const prompt = buildConstitutionPrompt("npm test", "Tests: 1 F, 2 total");

    expect(prompt).toContain("npm test");
    expect(prompt).toContain("Tests: 1 F, 2 total");
  });

  it("truncates very large output rather than sending it whole", () => {
    const prompt = buildConstitutionPrompt("npm test", "x".repeat(50_000));
    expect(prompt.length).toBeLessThan(20_000);
  });

  it("tells the model that no amendment is the usual answer", () => {
    // The instruction is load-bearing: without it the model proposes a rule
    // for every ordinary bug, and the constitution fills with noise.
    expect(DEFAULT_CONSTITUTION_PROMPT).toContain("NO_AMENDMENT");
    expect(DEFAULT_CONSTITUTION_PROMPT).toMatch(/almost always the answer is no/i);
  });
});
