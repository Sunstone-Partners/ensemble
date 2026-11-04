import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../src/extension";
import {
  SPAWN_EVENT,
  TIER_ROLES,
  aliasRole,
  assessSpawn,
  buildNotice,
  createSpawnHandler,
  registerModelRoleCheck,
  unresolvedTierRoles,
} from "../src/model-roles";
import type { Notable, SpawnResult } from "../src/model-roles";

/**
 * The model-role check: an Ensemble agent whose OMP tier role is not set is reported loudly when it is about to start.
 *
 * Every `patterns` array below is what a real omp 18.16.0 delivered in `before_subagent_spawn`, with an isolated
 * agent directory and `tiertest-high` (`model: "@high,@default"`) as the agent. The comment on each says which
 * configuration produced it:
 *   A  no modelRoles                       ["@high"]
 *   B  default only                        ["@high", "fakellm/fake-default"]
 *   C  default, high, medium               ["fakellm/fake-high", "fakellm/fake-default"]
 *   D  nothing set, agent pinned by task.agentModelOverrides   ["fakellm/fake-pinned"]
 *   E  default names a model that is not available             ["@high", "fakellm/does-not-exist"]
 * The fake `ctx.models.resolve` answers what that omp answered for them: a pattern resolves only when the test lists it.
 */

const PACKAGE_ROOT = resolve(__dirname, "..");
const GENERATED_AGENTS = resolve(PACKAGE_ROOT, "..", "pi", "agents");

/** `ctx.models.resolve` of a host whose available models are exactly `available`. Anything else resolves to nothing. */
function fakeModels(available: Record<string, string>) {
  return {
    resolve: jest.fn((spec: string) => {
      const name = available[spec];
      if (name === undefined) return undefined;
      const slash = name.indexOf("/");
      return { provider: name.slice(0, slash), id: name.slice(slash + 1), name };
    }),
  };
}

interface CtxOptions {
  /** True in the interactive TUI; false in print mode. */
  hasUI?: boolean;
  /** `ctx.agent.kind`: "main" for the user-facing session, "sub" for a child agent. */
  kind?: "main" | "sub";
  sessionId?: string;
  notify?: jest.Mock;
}

function fakeCtx(available: Record<string, string>, options: CtxOptions = {}) {
  const notify = options.notify ?? jest.fn();
  const models = fakeModels(available);
  const ctx = {
    hasUI: options.hasUI ?? true,
    ui: { notify },
    models,
    agent: { kind: options.kind ?? "main", name: options.kind === "sub" ? "tech-lead-orchestrator" : "main" },
    sessionManager: { getSessionId: () => options.sessionId ?? "session-1" },
  };
  return { ctx, notify, models };
}

const spawnEvent = (agent: string, patterns: string[]) => ({ type: SPAWN_EVENT, agent, invocationKind: "task", patterns, spawnKey: "k" });

let stderrText: string[] = [];
beforeEach(() => {
  stderrText = [];
  jest.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrText.push(String(chunk));
    return true;
  });
});
afterEach(() => jest.restoreAllMocks());

const FAKE_DEFAULT = { "fakellm/fake-default": "fakellm/fake-default" };

describe("aliasRole", () => {
  it("reads the role from an OMP role alias, with or without a thinking suffix", () => {
    expect(aliasRole("@high")).toBe("high");
    expect(aliasRole("@medium:xhigh")).toBe("medium");
    expect(aliasRole(" @high ")).toBe("high");
  });

  it("does not take a bare word or a model id for a role: OMP matches `high` as a model-name substring", () => {
    expect(aliasRole("high")).toBeUndefined();
    expect(aliasRole("openrouter/openai/o3-mini-high")).toBeUndefined();
    expect(aliasRole("fakellm/fake-high")).toBeUndefined();
    expect(aliasRole("@")).toBeUndefined();
    expect(aliasRole("")).toBeUndefined();
  });
});

describe("unresolvedTierRoles", () => {
  it("lists the tier roles the host left as aliases, once each and in order", () => {
    expect(unresolvedTierRoles(["@high"])).toEqual(["high"]);
    expect(unresolvedTierRoles(["@medium", "fakellm/fake-default", "@high:high", "@medium"])).toEqual(["medium", "high"]);
  });

  it("finds nothing when the host expanded every role to a model, or when an agent is pinned", () => {
    expect(unresolvedTierRoles(["fakellm/fake-high", "fakellm/fake-default"])).toEqual([]); // C
    expect(unresolvedTierRoles(["fakellm/fake-pinned"])).toEqual([]); // D
    expect(unresolvedTierRoles([])).toEqual([]);
  });

  it("ignores an unexpanded alias for a role that is not a tier: that role is not Ensemble's to report", () => {
    expect(unresolvedTierRoles(["@review", "fakellm/fake-default"])).toEqual([]);
  });
});

describe("assessSpawn", () => {
  const resolverFor = (available: Record<string, string>) => (spec: string) => available[spec];

  it("is quiet when the tier role is configured (C)", () => {
    const resolve = resolverFor({ "@high": "fakellm/fake-high", "@medium": "fakellm/fake-medium", "fakellm/fake-high": "fakellm/fake-high", ...FAKE_DEFAULT });
    expect(assessSpawn("code-reviewer", ["fakellm/fake-high", "fakellm/fake-default"], resolve)).toEqual({ kind: "quiet" });
  });

  it("is quiet for an agent pinned by task.agentModelOverrides, although neither role resolves (D)", () => {
    const resolve = resolverFor({ "fakellm/fake-pinned": "fakellm/fake-pinned" }); // @high and @default resolve to nothing
    expect(assessSpawn("code-reviewer", ["fakellm/fake-pinned"], resolve)).toEqual({ kind: "quiet" });
  });

  it("is a fallback when the tier role is unset but the fallback model resolves (B), and names the model it runs on", () => {
    const resolve = resolverFor({ ...FAKE_DEFAULT, "@medium": "fakellm/fake-default" });
    expect(assessSpawn("code-reviewer", ["@high", "fakellm/fake-default"], resolve)).toEqual({
      kind: "fallback",
      agent: "code-reviewer",
      asked: ["high"],
      unusable: ["high"],
      runsOn: "fakellm/fake-default",
    });
  });

  it("is unstartable when nothing in the list resolves (A), and notes that default is unusable too", () => {
    expect(assessSpawn("code-reviewer", ["@high"], () => undefined)).toEqual({
      kind: "unstartable",
      agent: "code-reviewer",
      asked: ["high"],
      unusable: ["high", "medium"],
      defaultUnusable: true,
    });
  });

  it("is unstartable when the fallback names a model that is not available (E), while default itself is not the problem", () => {
    const assessment = assessSpawn("code-reviewer", ["@high", "fakellm/does-not-exist"], resolverFor({ "@default": "fakellm/fake-default" }));
    expect(assessment).toMatchObject({ kind: "unstartable", asked: ["high"], defaultUnusable: false });
  });

  it("also reports the other tier roles that have no usable model, so one edit of the config fixes them all", () => {
    const assessment = assessSpawn("backend-developer", ["@medium", "fakellm/fake-default"], resolverFor({ ...FAKE_DEFAULT }));
    expect(assessment).toMatchObject({ kind: "fallback", asked: ["medium"], unusable: ["high", "medium"] });
  });

  it("is quiet for an agent that asks for a role that is not a tier, even when nothing resolves", () => {
    expect(assessSpawn("reviewer", ["@review"], () => undefined)).toEqual({ kind: "quiet" });
  });
});

describe("buildNotice", () => {
  const unstartable: Extract<Notable, { kind: "unstartable" }> = {
    kind: "unstartable",
    agent: "code-reviewer",
    asked: ["high"],
    unusable: ["high", "medium"],
    defaultUnusable: true,
  };
  const fallback: Notable = { kind: "fallback", agent: "backend-developer", asked: ["medium"], unusable: ["medium"], runsOn: "openai/gpt-5" };

  it("names the roles, their settings keys, the file, an example block and what happens otherwise (unstartable)", () => {
    const text = buildNotice(unstartable);

    expect(text).toContain('"code-reviewer"');
    expect(text).toContain("modelRoles.default");
    expect(text).toContain("modelRoles.high");
    expect(text).toContain("modelRoles.medium");
    expect(text).toContain("~/.omp/agent/config.yml");
    expect(text.split("\n")).toEqual(expect.arrayContaining(["modelRoles:", "  default: <provider>/<model>", "  high: <provider>/<model>", "  medium: <provider>/<model>"]));
    expect(text).toContain("was not started");
    expect(text).toContain("No model selected"); // says what OMP would have done instead
    expect(text).toContain("task.agentModelOverrides"); // the way to pin one agent
  });

  it("names the model the agent runs on instead, and lists only the roles that are unusable (fallback)", () => {
    const text = buildNotice(fallback);

    expect(text).toContain("openai/gpt-5");
    expect(text).toContain("modelRoles.medium");
    expect(text).not.toContain("modelRoles.high"); // high is set, so it is not in the way
    expect(text).not.toContain("modelRoles.default"); // nor is default: the agent found its fallback
    expect(text.split("\n")).toContain("  medium: <provider>/<model>");
    expect(text.split("\n")).not.toContain("  high: <provider>/<model>");
    expect(text).toContain("~/.omp/agent/config.yml");
  });

  it("leaves default out of the example when default is set", () => {
    const text = buildNotice({ ...unstartable, defaultUnusable: false });

    expect(text.split("\n")).not.toContain("  default: <provider>/<model>");
    expect(text).toContain("modelRoles.high");
  });
});

describe("the before_subagent_spawn handler", () => {
  describe("a tier role that is unset and nothing to fall back to (A)", () => {
    it("refuses the spawn with the message, and shows the user the same message once", () => {
      const handler = createSpawnHandler();
      const { ctx, notify } = fakeCtx({});

      const result = handler(spawnEvent("code-reviewer", ["@high"]), ctx) as SpawnResult;

      expect(result.block).toBe(true);
      expect(result.reason).toContain("modelRoles.high");
      expect(result.reason).toContain("modelRoles.default");
      expect(result.reason).toContain("~/.omp/agent/config.yml");
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(result.reason, "error");
      expect(stderrText).toEqual([]);
    });

    it("refuses every such spawn, but tells the user only once per session", () => {
      const handler = createSpawnHandler();
      const { ctx, notify } = fakeCtx({});

      const first = handler(spawnEvent("code-reviewer", ["@high"]), ctx) as SpawnResult;
      const second = handler(spawnEvent("architect", ["@high"]), ctx) as SpawnResult;

      expect(first.block).toBe(true);
      expect(second.block).toBe(true); // each refused spawn must get its reason: it is the model's only way to know why the job failed
      expect(second.reason).toContain('"architect"');
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("refuses when the fallback names a model that is not available (E)", () => {
      const handler = createSpawnHandler();
      const { ctx } = fakeCtx({});

      const result = handler(spawnEvent("code-reviewer", ["@high", "fakellm/does-not-exist"]), ctx) as SpawnResult;

      expect(result.block).toBe(true);
    });
  });

  describe("a tier role that is unset but the fallback model resolves (B)", () => {
    it("lets the spawn run and warns the user once, naming the model it runs on", () => {
      const handler = createSpawnHandler();
      const { ctx, notify } = fakeCtx(FAKE_DEFAULT);

      const first = handler(spawnEvent("code-reviewer", ["@high", "fakellm/fake-default"]), ctx);
      const second = handler(spawnEvent("architect", ["@high", "fakellm/fake-default"]), ctx);

      expect(first).toBeUndefined();
      expect(second).toBeUndefined();
      expect(notify).toHaveBeenCalledTimes(1);
      const [message, level] = notify.mock.calls[0];
      expect(level).toBe("warning");
      expect(message).toContain("fakellm/fake-default");
      expect(message).toContain("modelRoles.high");
      expect(message).toContain("~/.omp/agent/config.yml");
    });

    it("warns again in a new session, and again when the set of roles in the way changes", () => {
      const handler = createSpawnHandler();
      const patterns = ["@medium", "fakellm/fake-default"];

      const one = fakeCtx({ ...FAKE_DEFAULT, "@high": "fakellm/fake-high" }, { sessionId: "s1" });
      handler(spawnEvent("backend-developer", patterns), one.ctx);
      handler(spawnEvent("backend-developer", patterns), one.ctx);
      const two = fakeCtx({ ...FAKE_DEFAULT, "@high": "fakellm/fake-high" }, { sessionId: "s2" });
      handler(spawnEvent("backend-developer", patterns), two.ctx);
      const changed = fakeCtx({ ...FAKE_DEFAULT }, { sessionId: "s2" }); // high went unusable in the same session
      handler(spawnEvent("backend-developer", patterns), changed.ctx);

      expect(one.notify).toHaveBeenCalledTimes(1);
      expect(two.notify).toHaveBeenCalledTimes(1);
      expect(changed.notify).toHaveBeenCalledTimes(1);
    });
  });

  describe("quiet cases", () => {
    it("says nothing and blocks nothing when the tier role is configured (C)", () => {
      const handler = createSpawnHandler();
      const { ctx, notify } = fakeCtx({ "fakellm/fake-high": "fakellm/fake-high", ...FAKE_DEFAULT });

      expect(handler(spawnEvent("code-reviewer", ["fakellm/fake-high", "fakellm/fake-default"]), ctx)).toBeUndefined();
      expect(notify).not.toHaveBeenCalled();
      expect(stderrText).toEqual([]);
    });

    it("says nothing and blocks nothing for an agent pinned by task.agentModelOverrides while no role is set (D)", () => {
      const handler = createSpawnHandler();
      const { ctx, notify } = fakeCtx({ "fakellm/fake-pinned": "fakellm/fake-pinned" });

      expect(handler(spawnEvent("code-reviewer", ["fakellm/fake-pinned"]), ctx)).toBeUndefined();
      expect(notify).not.toHaveBeenCalled();
      expect(stderrText).toEqual([]);
    });

    it("says nothing for a spawn that names no role at all, such as a plain agent", () => {
      const handler = createSpawnHandler();
      const { ctx, notify } = fakeCtx({});

      expect(handler(spawnEvent("explore", []), ctx)).toBeUndefined();
      expect(handler(spawnEvent("explore", ["@smol"]), ctx)).toBeUndefined();
      expect(notify).not.toHaveBeenCalled();
      expect(stderrText).toEqual([]);
    });
  });

  describe("where the user is told", () => {
    it("writes to stderr, and not to the UI, when the host has no UI (print mode)", () => {
      const handler = createSpawnHandler();
      const { ctx, notify } = fakeCtx(FAKE_DEFAULT, { hasUI: false });

      handler(spawnEvent("code-reviewer", ["@high", "fakellm/fake-default"]), ctx);

      expect(notify).not.toHaveBeenCalled();
      expect(stderrText.join("")).toContain("modelRoles.high");
    });

    it("falls back to stderr when the host's UI throws", () => {
      const handler = createSpawnHandler();
      const { ctx } = fakeCtx(FAKE_DEFAULT, {
        notify: jest.fn(() => {
          throw new Error("ui is gone");
        }),
      });

      expect(() => handler(spawnEvent("code-reviewer", ["@high", "fakellm/fake-default"]), ctx)).not.toThrow();
      expect(stderrText.join("")).toContain("modelRoles.high");
    });

    it("does not tell the user from a child agent's session, which has no UI and whose stderr would corrupt the parent's TUI", () => {
      const handler = createSpawnHandler();
      const refused = fakeCtx({}, { kind: "sub", hasUI: false });
      const fellBack = fakeCtx(FAKE_DEFAULT, { kind: "sub", hasUI: false, sessionId: "child" });

      const result = handler(spawnEvent("backend-developer", ["@medium"]), refused.ctx) as SpawnResult;
      const fallback = handler(spawnEvent("backend-developer", ["@medium", "fakellm/fake-default"]), fellBack.ctx);

      expect(result.block).toBe(true); // the child's model still learns why its spawn failed
      expect(fallback).toBeUndefined();
      expect(refused.notify).not.toHaveBeenCalled();
      expect(fellBack.notify).not.toHaveBeenCalled();
      expect(stderrText).toEqual([]);
    });
  });

  describe("when the host is not what the check expects", () => {
    it("stays out of the way of an event or context of another shape, and never throws", () => {
      const handler = createSpawnHandler();
      const { ctx } = fakeCtx({});

      expect(handler(undefined, ctx)).toBeUndefined();
      expect(handler({ agent: "x" }, ctx)).toBeUndefined(); // no patterns
      expect(handler({ agent: "x", patterns: ["@high", 3] }, ctx)).toBeUndefined();
      expect(handler(spawnEvent("x", ["@high"]), {})).toBeUndefined(); // no ctx.models, as on Pi
      expect(handler(spawnEvent("x", ["@high"]), { models: { resolve: "nope" } })).toBeUndefined();
      expect(stderrText).toEqual([]);
    });

    it("lets the spawn run and says the check was skipped, when resolving a model throws", () => {
      const handler = createSpawnHandler();
      const { ctx, notify } = fakeCtx({});
      ctx.models.resolve.mockImplementation(() => {
        throw new Error("registry not ready");
      });

      const result = handler(spawnEvent("code-reviewer", ["@high"]), ctx);

      expect(result).toBeUndefined();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0]).toContain("registry not ready");
      expect(notify.mock.calls[0][1]).toBe("warning");
    });
  });
});

describe("registration", () => {
  function fakePi() {
    const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
      registerTool: () => undefined,
      registerCommand: () => undefined,
      sendUserMessage: () => undefined,
      sendMessage: () => undefined,
    } as unknown as ExtensionAPI;
    return { pi, handlers };
  }

  it("registerModelRoleCheck registers one before_subagent_spawn handler and nothing else", () => {
    const { pi, handlers } = fakePi();

    registerModelRoleCheck(pi);

    expect([...handlers.keys()]).toEqual(["before_subagent_spawn"]);
    expect(handlers.get(SPAWN_EVENT)).toHaveLength(1);
  });

  describe("through activate(), as the host loads the extension", () => {
    const dirs: string[] = [];
    const originalCwd = process.cwd();
    afterAll(() => {
      process.chdir(originalCwd);
      dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
    });

    it("refuses a spawn whose tier role is unset in a repository that has nothing of Ensemble's", () => {
      const repo = mkdtempSync(join(tmpdir(), "model-roles-activate-"));
      dirs.push(repo);
      process.chdir(repo); // no dispatcher YAML, no hooks file: the other registrations are inert here
      const { pi, handlers } = fakePi();

      activate(pi);

      expect([...handlers.keys()]).toEqual([SPAWN_EVENT]);
      const { ctx, notify } = fakeCtx({});
      const [handler] = handlers.get(SPAWN_EVENT) ?? [];
      const result = handler(spawnEvent("code-reviewer", ["@high"]), ctx) as SpawnResult;
      expect(result).toEqual({ block: true, reason: expect.stringContaining("modelRoles.high") });
      expect(notify).toHaveBeenCalledTimes(1);
    });
  });
});

describe("agreement with the generated agents", () => {
  /** The `model:` frontmatter scalar of a generated Pi agent, split into its entries. */
  function modelList(file: string): string[] {
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
    const value = /^model:\s*"?([^"\n]*)"?\s*$/m.exec(frontmatter)?.[1];
    return value === undefined ? [] : value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }

  it("covers every role alias the generated agents name, apart from the `default` fallback", () => {
    // TIER_ROLES mirrors MODEL_TIER_ROLES in packages/pi/src/transformers/agent-transformer.ts. A third tier added
    // there would be invisible to the check until this list names it.
    expect(existsSync(GENERATED_AGENTS)).toBe(true);
    const aliases = readdirSync(GENERATED_AGENTS)
      .filter((name) => name.endsWith(".md"))
      .flatMap((name) => modelList(join(GENERATED_AGENTS, name)))
      .map((entry) => aliasRole(entry))
      .filter((role): role is string => role !== undefined);

    expect(aliases.length).toBeGreaterThan(0); // the generated agents do name roles, so this is not vacuous
    const unknown = [...new Set(aliases)].filter((role) => role !== "default" && !(TIER_ROLES as readonly string[]).includes(role));
    expect(unknown).toEqual([]);
  });

  it("recognises, as unresolved, exactly the tier roles the generated agents name when the host cannot expand them", () => {
    const named = new Set<string>();
    for (const name of readdirSync(GENERATED_AGENTS).filter((file) => file.endsWith(".md"))) {
      for (const role of unresolvedTierRoles(modelList(join(GENERATED_AGENTS, name)))) named.add(role);
    }

    expect([...named].sort()).toEqual([...TIER_ROLES].sort());
  });
});
