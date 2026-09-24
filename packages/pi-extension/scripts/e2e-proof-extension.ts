// Thin wrapper loaded by scripts/e2e-proof.mjs via Pi's real
// discoverAndLoadExtensions loader. jiti (Pi's TS extension loader) may
// use a module registry separate from Node's own ESM cache, so a direct
// `import()` of this file from the proof script could construct a
// second, disconnected createActivate() instance. Publishing the one
// true instance on globalThis sidesteps that: jiti still evaluates this
// module's top-level code in the same Node process/realm, so
// globalThis is guaranteed shared. Proof-script-only wiring — not part
// of the shipped package (this file lives in scripts/, not src/).
import { createActivate } from "../src/extension";

export const instance = createActivate();
globalThis.__ensembleE2EProofInstance = instance;
export default instance.activate;
