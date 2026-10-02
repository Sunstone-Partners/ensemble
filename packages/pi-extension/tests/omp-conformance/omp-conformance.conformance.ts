import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  HostObservation,
  ModelToolMessage,
  OMP_GAPS,
  PROBE,
  REQUIRED_HOST_CAPABILITIES,
  conformanceCases,
  observe,
  staleGaps,
} from "./host-capabilities";
import { OmpRun, buildExtensionShim, findOmp, ompVersion, runOmp, runProblem, startFakeModel } from "./omp-host";

/**
 * OMP host conformance (TRD-031 / REQ-024). Run it with
 *
 *     npm run test:omp-conformance -w packages/pi-extension
 *
 * It is deliberately NOT part of `npm test`. Pi's suite drives a fake Pi
 * surface; this one drives the real `omp` binary, and its results are OMP's
 * alone -- every describe title names the omp version it exercised, and
 * nothing here reads a Pi result. With no `omp` available it fails instead of
 * passing: a conformance claim needs a conformance run.
 */

const PROBE_EXTENSION = join(__dirname, "probe-extension.ts");

const bin = findOmp();
if (!bin) {
  throw new Error(
    "OMP conformance NOT RUN: no omp binary (set OMP_BIN or put omp on PATH). This suite reports OMP " +
      "support only from a real OMP run, so it fails rather than passing without one.",
  );
}
const omp: string = bin;
const version = ompVersion(omp);
// The report is titled with this version; a binary that does not identify
// itself as omp would produce a conformance run attributed to nothing.
if (!/^omp\/\d/.test(version)) {
  throw new Error(`OMP conformance NOT RUN: ${omp} does not identify as omp (--version printed "${version}").`);
}

const scratch: string[] = [];
afterAll(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function gitRepo(files: Record<string, string>): string {
  const root = tempDir("omp-conformance-repo-");
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

/** Problems that make a run not count as a clean OMP run. */
function cleanRunProblems(...runs: OmpRun[]): string[] {
  return runs.map(runProblem).filter((problem): problem is string => problem !== undefined);
}

const echoCall = { name: "bash", arguments: { i: "Echo the probe marker", command: PROBE.echoCommand } };

describe(`OMP host conformance: ${version}, its own run (not Pi's)`, () => {
  let observed: HostObservation;
  let problems: string[];

  beforeAll(async () => {
    // One turn: a bash call, the probe's own registered tool, and a bash call
    // the probe blocks in tool_call. Then a slash command, which needs no model.
    const model = await startFakeModel([
      [echoCall, { name: PROBE.tool, arguments: {} }, { name: "bash", arguments: { i: "Blocked probe", command: PROBE.blockedCommand } }],
    ]);
    try {
      const repo = gitRepo({ "README.md": "omp conformance sandbox\n" });
      const turn = await runOmp({
        bin: omp,
        repo,
        extensions: [PROBE_EXTENSION],
        prompt: PROBE.prompt,
        model,
        args: [`--${PROBE.flag}`],
      });
      const command = await runOmp({ bin: omp, repo, extensions: [PROBE_EXTENSION], prompt: `/${PROBE.command}`, model });
      problems = cleanRunProblems(turn, command);
      observed = observe([...turn.records, ...command.records], model.toolMessages(), {
        blockedCommandRan: existsSync(join(repo, PROBE.blockedMarker)),
      });
    } finally {
      await model.close();
    }
  }, 110_000);

  it("ran omp to a clean exit", () => {
    expect(problems).toEqual([]);
  });

  for (const entry of conformanceCases(REQUIRED_HOST_CAPABILITIES, OMP_GAPS)) {
    if (entry.kind === "unsupported") {
      // Reported, never verified, never counted as a pass (AC-024-2).
      it.todo(`UNSUPPORTED ${entry.capability.id}: documented gap ${entry.gap.id} -- ${entry.gap.summary}`);
      continue;
    }
    it(`provides ${entry.capability.id}, needed for ${entry.capability.neededFor}`, () => {
      const verdict = entry.capability.holds(observed)
        ? "provided"
        : `not shown by ${version}; observed: ${JSON.stringify(observed)}`;
      expect(verdict).toBe("provided");
    });
  }

  it("records no gap this OMP build actually provides", () => {
    expect(staleGaps(observed, REQUIRED_HOST_CAPABILITIES, OMP_GAPS)).toEqual([]);
  });

  // Host behaviors that are not requirements, asserted so the docs that cite
  // them cite this run. If OMP changes, these fail and the docs must follow.
  describe("observations the docs cite", () => {
    it("reports no UI under -p, so approval prompts fail closed and are not verified here", () => {
      expect(observed.hasUI).toBe(false);
    });

    it("fires no tool_result for a call blocked in tool_call", () => {
      expect(observed.toolResults.filter((result) => result.toolCallId === observed.blockedCallId)).toEqual([]);
    });
  });
});

const OBSERVER_BEHAVIOR = `api_version: ensemble.sunstone.dev/v1
kind: Behavior
metadata:
  name: conformance-observer
  version: 1.0.0
trigger:
  event_type: test.failure.observed
policy:
  mode: propose
  timeout: 10m
capabilities:
  tools:
    - read
  mutation_classes: []
execution:
  graph: conformance-observer
outcomes:
  - test.failure.investigated
`;

const ECHO_MESSAGE = "omp-conformance-echo";

/** The model's tool message for the scripted call at `index` of the first turn. */
function messageFor(messages: readonly ModelToolMessage[], index: number): string | undefined {
  return messages.find((message) => message.toolCallId === `call_0_${index}`)?.content;
}

describe(`the Ensemble extension inside ${version}`, () => {
  let granted: OmpRun;
  let ungranted: OmpRun;
  let grantedMessages: ModelToolMessage[];
  let ungrantedMessages: ModelToolMessage[];
  let observed: HostObservation;
  let runtimeLog: unknown[];

  beforeAll(async () => {
    // This checkout's extension, bundled the way install.mjs ships it, in an
    // armed repository whose one behavior never fires (the echo succeeds).
    const shim = buildExtensionShim(tempDir("omp-conformance-build-"));
    const armedRepo = () =>
      gitRepo({
        ".ensemble/config.yaml": "behaviors:\n  armed: true\n",
        ".ensemble/behaviors/conformance-observer/behavior.yaml": OBSERVER_BEHAVIOR,
      });
    const echoTool = { name: "echo", arguments: { message: ECHO_MESSAGE } };

    const grantedRepo = armedRepo();
    const grantedModel = await startFakeModel([[echoCall, echoTool]]);
    try {
      granted = await runOmp({
        bin: omp,
        repo: grantedRepo,
        extensions: [shim, PROBE_EXTENSION],
        prompt: PROBE.prompt,
        model: grantedModel,
        args: ["--ensemble-tool-grant"],
      });
      grantedMessages = grantedModel.toolMessages();
    } finally {
      await grantedModel.close();
    }

    const ungrantedModel = await startFakeModel([[echoTool]]);
    try {
      ungranted = await runOmp({ bin: omp, repo: armedRepo(), extensions: [shim], prompt: PROBE.prompt, model: ungrantedModel });
      ungrantedMessages = ungrantedModel.toolMessages();
    } finally {
      await ungrantedModel.close();
    }

    observed = observe(granted.records, grantedMessages, { blockedCommandRan: false });
    runtimeLog = readFileSync(join(grantedRepo, ".ensemble", "runtime-log.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line));
  }, 170_000);

  it("ran omp to a clean exit, granted and ungranted", () => {
    expect(cleanRunProblems(granted, ungranted)).toEqual([]);
  });

  it("activates and arms without reporting a load, activation or capability failure", () => {
    for (const run of [granted, ungranted]) {
      expect(run.stderr).not.toMatch(/BLOCKING GAP|extension failed to (load|activate)/);
    }
    expect(runtimeLog).toContainEqual(expect.objectContaining({ kind: "activation", loaded: ["conformance-observer"] }));
  });

  it("registers its governed tool, its commands and its behavior's command with the OMP host", () => {
    expect(observed.tools).toContain("echo");
    expect(observed.commands).toEqual(expect.arrayContaining(["ensemble-status", "ensemble-approve", "conformance-observer"]));
  });

  it("runs its governed tool when the session is granted it on the command line", () => {
    // execute reads ctx.sessionManager and pi.getFlag("ensemble-tool-grant"):
    // the echo only comes back if OMP supplied both the way the source reads them.
    expect(messageFor(grantedMessages, 1)).toContain(ECHO_MESSAGE);
  });

  it("denies its governed tool at the runtime boundary when the session is not granted", () => {
    expect(messageFor(ungrantedMessages, 0)).toMatch(/unauthorized/);
  });

  it("sees OMP's tool calls through its own lifecycle subscriptions", () => {
    expect(runtimeLog).toContainEqual(
      expect.objectContaining({
        kind: "event",
        type: "runtime.tool_call.completed",
        payload: expect.objectContaining({
          toolCallId: "call_0_0",
          toolName: "bash",
          command: PROBE.echoCommand,
          isError: false,
          output: expect.stringContaining(PROBE.echoOutput),
        }),
      }),
    );
    expect(runtimeLog).toContainEqual(
      expect.objectContaining({ kind: "event", type: "runtime.prompt.submitted", payload: { prompt: PROBE.prompt } }),
    );
    expect(runtimeLog).toContainEqual(
      expect.objectContaining({
        kind: "event",
        type: "runtime.tool_call.started",
        payload: expect.objectContaining({ toolCallId: "call_0_1", toolName: "echo" }),
      }),
    );
    for (const type of ["runtime.session.started", "runtime.session.completed"]) {
      expect(runtimeLog).toContainEqual(expect.objectContaining({ kind: "event", type }));
    }
  });
});
