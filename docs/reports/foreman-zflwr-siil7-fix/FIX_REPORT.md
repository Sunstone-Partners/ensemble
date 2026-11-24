
Two corrections to my recorded plan state: the assertions at `security.test.js:1277-1286` and `:1589` are **deliberate security tests that already pass** (`env bash -c "…"` must stay unexpanded + not auto-allowed; `normalizeSegment(['bash','-c','unset FOO; npm test'])` must return `null`). Inverting them would weaken existing security — forbidden. My fix must satisfy them instead.

Also note `checkRedirections` runs only over outer tokens, never inside `-c` strings, while `classifySegment` *does* expand them and silently drops inner redirects via `normalizeSegment` — exactly the bypass. Writing the failing tests first.
