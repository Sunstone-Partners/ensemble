#!/usr/bin/env node
// Real activation smoke test for AC-004-1: loads the pi-extension through
// Pi's actual extension loader (discoverAndLoadExtensions) and confirms it
// activates with no load-time errors and registers the expected tool.
//
// Run directly (not through jest): jiti-loaded TypeScript, and
// @earendil-works/pi-coding-agent is ESM-only, so this must run as a real
// Node ESM process rather than under jest's CommonJS resolver.
//
// discoverAndLoadExtensions also auto-discovers from standard Pi locations
// on this machine, so the result may contain more than our one extension —
// we find ours by resolvedPath rather than assuming array length 1.
import { createEventBus, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, "..", "src", "extension.ts");

const eventBus = createEventBus();
const result = await discoverAndLoadExtensions([extensionPath], process.cwd(), undefined, eventBus);

const relevantErrors = result.errors.filter((e) => String(e.path ?? "").includes("pi-extension"));
if (relevantErrors.length > 0) {
  console.error("FAIL: extension load errors:", relevantErrors);
  process.exit(1);
}

const ours = result.extensions.find((ext) => ext.resolvedPath === extensionPath);
if (!ours) {
  console.error(
    `FAIL: our extension not found among ${result.extensions.length} discovered extensions. Resolved paths:`,
    result.extensions.map((ext) => ext.resolvedPath),
  );
  process.exit(1);
}

if (!ours.tools.has("echo")) {
  console.error("FAIL: expected 'echo' tool to be registered, got:", [...ours.tools.keys()]);
  process.exit(1);
}

console.log("PASS: extension activated with no load-time errors; 'echo' tool registered.");
