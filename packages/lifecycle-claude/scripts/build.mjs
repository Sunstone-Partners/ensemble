#!/usr/bin/env node
// Bundle src/main.ts (with agent-core and the Pi gate logic) into bundle/lifecycle.cjs.
// Run after changing agent-core's lifecycle-hooks or the pi-extension gate; the bundle is committed
// because a Claude Code plugin is installed from the repository without a build step.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_CORE = join(PKG, "..", "agent-core");
if (!existsSync(join(AGENT_CORE, "dist", "index.js"))) {
  execFileSync("npx", ["tsc", "-p", AGENT_CORE], { stdio: "inherit" });
}
execFileSync("bun", ["build", "src/main.ts", "--target=node", "--format=cjs", "--outfile=bundle/lifecycle.cjs"], {
  cwd: PKG,
  stdio: "inherit",
});
// bun's output differs between versions, so record which one built the committed bundle. The freshness test only
// compares a fresh build when the installed bun is this version; otherwise it would fail on every other bun.
const bunVersion = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
writeFileSync(join(PKG, "bundle", "BUN_VERSION"), `${bunVersion}\n`);
