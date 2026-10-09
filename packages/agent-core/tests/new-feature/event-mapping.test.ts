import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEventMapping, validateEventPayload } from "../../src/new-feature/event-mapping";
import { findActive, resolveByArtifact } from "../../src/new-feature/run-index";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ensemble-event-mapping-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadEventMapping default-deny (TRD-012)", () => {
  it("AC-009-1: returns null when no event-mapping.json file exists", () => {
    expect(loadEventMapping(root)).toBeNull();
  });

  it("AC-009-1: with no config, no run is created by an event -- findActive shows nothing new", () => {
    // There is no event-delivery entry point to invoke here (that is
    // TRD-013, wired in new-feature.yaml's prose, not a run-index.ts
    // function) -- what this file's default-deny state guarantees is that
    // nothing under RunIndexStore's ownership is touched as a side effect
    // of loading a (non-existent) config. The manual entry path (TRD-005)
    // is what actually calls createRun(), and remains untouched either way.
    expect(loadEventMapping(root)).toBeNull();
    expect(findActive(root)).toBeUndefined();
  });

  it("loads a valid config when the file is present", () => {
    mkdirSync(join(root, ".ensemble", "new-feature"), { recursive: true });
    writeFileSync(
      join(root, ".ensemble", "new-feature", "event-mapping.json"),
      JSON.stringify({ allowedEventTypes: ["issue.opened"] }),
    );

    const mapping = loadEventMapping(root);
    expect(mapping).toEqual({ allowedEventTypes: ["issue.opened"], reviewRequired: true });
  });
});

describe("validateEventPayload review gate and invalid-payload rejection (TRD-013)", () => {
  const mapping = { allowedEventTypes: ["issue.opened"], reviewRequired: true as const };

  it("AC-009-3: a disallowed event type is rejected, naming the pending step", () => {
    const result = validateEventPayload(mapping, { type: "push", source: "github", summary: "add a widget" });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("not in this project's allowedEventTypes") });
  });

  it("AC-009-3: an incomplete payload (missing summary) is rejected, naming the pending step", () => {
    const result = validateEventPayload(mapping, { type: "issue.opened", source: "github", summary: "" });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("missing a non-empty summary") });
  });

  it("AC-009-3: an incomplete payload (missing source) is rejected, naming the pending step", () => {
    const result = validateEventPayload(mapping, { type: "issue.opened", source: "", summary: "add a widget" });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("missing a non-empty source") });
  });

  it("AC-009-1: no config at all rejects every payload with the default-deny reason", () => {
    const result = validateEventPayload(null, { type: "issue.opened", source: "github", summary: "add a widget" });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("default-deny") });
  });

  it("AC-009-2: an accepted (valid) payload never itself creates a PRD or a run -- validation has no RunIndexStore side effect, so a subsequent decline in the review step leaves nothing behind", () => {
    const result = validateEventPayload(mapping, { type: "issue.opened", source: "github", summary: "add a widget" });
    expect(result).toEqual({ ok: true });
    expect(findActive(root)).toBeUndefined();
  });
});

describe("boundary validation precedes state mutation (TRD-018)", () => {
  const mapping = { allowedEventTypes: ["issue.opened"], reviewRequired: true as const };

  it("AC-014-1: a malformed event payload (disallowed type) is rejected with no RunIndexStore write as a side effect -- no run file is created under .ensemble/new-feature/", () => {
    const result = validateEventPayload(mapping, { type: "push", source: "github", summary: "add a widget" });
    expect(result.ok).toBe(false);

    expect(findActive(root)).toBeUndefined();
    expect(existsSync(join(root, ".ensemble", "new-feature"))).toBe(false);
  });

  it("AC-014-1: a malformed event payload (missing summary) is rejected before any state change", () => {
    const result = validateEventPayload(mapping, { type: "issue.opened", source: "github", summary: "" });
    expect(result.ok).toBe(false);

    expect(findActive(root)).toBeUndefined();
    expect(existsSync(join(root, ".ensemble", "new-feature"))).toBe(false);
  });

  it("AC-014-1: a disallowed artifact path (TRD-005's boundary) resolves to undefined rather than creating/mutating anything", () => {
    // resolveByArtifact() is the boundary function for TRD-005's --path
    // input; a path no run has ever indexed is rejected (undefined) by
    // the boundary function itself, the same guarantee
    // validateEventPayload() provides for event payloads.
    const resolved = resolveByArtifact(root, "docs/PRD/not-indexed-by-anything.md");
    expect(resolved).toBeUndefined();
    expect(findActive(root)).toBeUndefined();
    expect(existsSync(join(root, ".ensemble", "new-feature"))).toBe(false);
  });
});

describe("config-only behavior change, no code change required (TRD-020)", () => {
  it("AC-014-3: editing allowedEventTypes between two invocations (simulated by two loadEventMapping() calls) changes which event types are accepted, with no code change", () => {
    const configPath = join(root, ".ensemble", "new-feature", "event-mapping.json");
    mkdirSync(join(root, ".ensemble", "new-feature"), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ allowedEventTypes: ["issue.opened"] }));

    // "Invocation 1": load the config and check a payload.
    const firstMapping = loadEventMapping(root);
    const firstResult = validateEventPayload(firstMapping, { type: "pull_request.opened", source: "github", summary: "add a widget" });
    expect(firstResult).toEqual({ ok: false, reason: expect.stringContaining("not in this project's allowedEventTypes") });

    // Only the config file changes between invocations -- no code path
    // here is edited or re-deployed.
    writeFileSync(configPath, JSON.stringify({ allowedEventTypes: ["issue.opened", "pull_request.opened"] }));

    // "Invocation 2": a fresh loadEventMapping() call (never cached from
    // invocation 1) picks up the edit immediately.
    const secondMapping = loadEventMapping(root);
    const secondResult = validateEventPayload(secondMapping, { type: "pull_request.opened", source: "github", summary: "add a widget" });
    expect(secondResult).toEqual({ ok: true });
  });
});
