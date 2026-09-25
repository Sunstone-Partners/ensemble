import {
  buildFixPrompt,
  parseFixReply,
  createAgentFixProvider,
} from "../src/agent-fix-provider";

const issue = { testId: "suite > case", failureOutput: "expected 3 received 2" };
const invocation = {} as never;

describe("parseFixReply", () => {
  it("extracts writes from a fenced json block", () => {
    const candidate = parseFixReply(
      'Here you go:\n```json\n{ "writes": [ { "path": "src/a.ts", "contents": "export const a = 1;" } ] }\n```\nDone.',
      "artifact.write",
    );
    expect(candidate).toEqual({
      writes: [{ path: "src/a.ts", contents: "export const a = 1;", mutationClass: "artifact.write" }],
    });
  });

  it("accepts bare json with no fence", () => {
    expect(parseFixReply('{"writes":[{"path":"a.ts","contents":"x"}]}', "artifact.write")?.writes).toHaveLength(1);
  });

  it("returns undefined for prose, so no patch is invented from unparseable output", () => {
    expect(parseFixReply("I could not work out the fix, sorry.", "artifact.write")).toBeUndefined();
  });

  it("returns undefined when writes is empty or missing", () => {
    expect(parseFixReply('```json\n{"writes":[]}\n```', "artifact.write")).toBeUndefined();
    expect(parseFixReply('```json\n{"notes":"hi"}\n```', "artifact.write")).toBeUndefined();
  });

  it("REFUSES absolute paths", () => {
    // The write boundary would revert the damage afterwards; refusing here
    // means it never lands at all.
    expect(
      parseFixReply('```json\n{"writes":[{"path":"/etc/passwd","contents":"x"}]}\n```', "artifact.write"),
    ).toBeUndefined();
  });

  it("REFUSES path traversal out of the repo", () => {
    expect(
      parseFixReply('```json\n{"writes":[{"path":"../../secrets.txt","contents":"x"}]}\n```', "artifact.write"),
    ).toBeUndefined();
    expect(
      parseFixReply('```json\n{"writes":[{"path":"src/../../x.ts","contents":"x"}]}\n```', "artifact.write"),
    ).toBeUndefined();
  });

  it("REFUSES writes to test files, guardrails and the constitution", () => {
    // The prompt asks the model not to touch these. Asking is not enforcing:
    // a confused or adversarial reply must be refused structurally, before
    // the write lands, not reverted a moment after it does.
    for (const path of [
      "packages/agent-core/tests/live-e2e.test.ts",
      "src/thing.spec.js",
      "packages/agent-core/src/behavior/protected-paths.ts",
      "packages/agent-core/src/behavior/write-boundary-monitor.ts",
      "docs/standards/constitution.md",
    ]) {
      const reply = '```json\n{"writes":[{"path":"' + path + '","contents":"x"}]}\n```';
      expect(parseFixReply(reply, "artifact.write")).toBeUndefined();
    }
  });

  it("still ACCEPTS ordinary source files", () => {
    expect(
      parseFixReply('```json\n{"writes":[{"path":"src/math.ts","contents":"x"}]}\n```', "artifact.write"),
    ).toBeDefined();
  });

  it("REFUSES a write whose contents is not a string", () => {
    expect(
      parseFixReply('```json\n{"writes":[{"path":"a.ts","contents":42}]}\n```', "artifact.write"),
    ).toBeUndefined();
  });
});

describe("buildFixPrompt", () => {
  it("names the failing test and forbids editing tests", () => {
    const prompt = buildFixPrompt(issue.testId, issue.failureOutput);
    expect(prompt).toContain("suite > case");
    expect(prompt).toContain("expected 3 received 2");
    expect(prompt).toMatch(/never the test/i);
  });

  it("truncates enormous failure output rather than sending it all", () => {
    const prompt = buildFixPrompt("t", "x".repeat(50_000));
    expect(prompt.length).toBeLessThan(12_000);
  });
});

describe("createAgentFixProvider", () => {
  it("returns the parsed candidate from the agent reply", async () => {
    const provider = createAgentFixProvider({
      rootDir: "/tmp",
      run: async () => '```json\n{"writes":[{"path":"src/a.ts","contents":"fixed"}]}\n```',
    });
    const candidate = await provider(invocation, issue);
    expect(candidate?.writes[0]).toMatchObject({ path: "src/a.ts", contents: "fixed" });
  });

  it("returns undefined when the agent process fails, instead of throwing", async () => {
    // A throwing provider would abort dispatch entirely; "no candidate" is
    // the correct degraded answer and is already handled downstream.
    const provider = createAgentFixProvider({
      rootDir: "/tmp",
      run: async () => {
        throw new Error("spawn failed");
      },
    });
    await expect(provider(invocation, issue)).resolves.toBeUndefined();
  });

  it("passes the failure output through to the agent", async () => {
    let seen = "";
    const provider = createAgentFixProvider({
      rootDir: "/tmp",
      run: async (prompt) => {
        seen = prompt;
        return "{}";
      },
    });
    await provider(invocation, issue);
    expect(seen).toContain("expected 3 received 2");
  });
});

describe("fix strategy lives in the behavior package, not in code", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d: string) => rmSync(d, { recursive: true, force: true })));

  it("uses the invoking behavior's fix-prompt.md when it ships one", async () => {
    const root = mkdtempSync(join(tmpdir(), "fixp-"));
    dirs.push(root);
    mkdirSync(join(root, "my-behavior"), { recursive: true });
    writeFileSync(
      join(root, "my-behavior", "fix-prompt.md"),
      "BESPOKE STRATEGY for {{testId}}: {{failureOutput}}",
    );

    let seen = "";
    const provider = createAgentFixProvider({
      rootDir: "/tmp",
      behaviorsDir: root,
      run: async (prompt: string) => {
        seen = prompt;
        return "{}";
      },
    });

    await provider({ behavior: { metadata: { name: "my-behavior" } } } as never, issue);
    expect(seen).toContain("BESPOKE STRATEGY for suite > case");
    expect(seen).toContain("expected 3 received 2");
    // The built-in default must NOT be what was sent.
    expect(seen).not.toContain("Fix the SOURCE, never the test");
  });

  it("falls back to the default when the behavior ships no prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "fixp-"));
    dirs.push(root);
    let seen = "";
    const provider = createAgentFixProvider({
      rootDir: "/tmp",
      behaviorsDir: root,
      run: async (prompt: string) => {
        seen = prompt;
        return "{}";
      },
    });
    await provider({ behavior: { metadata: { name: "absent" } } } as never, issue);
    expect(seen).toContain("Fix the SOURCE, never the test");
  });
});
