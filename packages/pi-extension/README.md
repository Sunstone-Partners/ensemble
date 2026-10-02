# @sunstone-partners/ensemble-pi-extension

Thin Pi-specific extension that loads the behavior runtime (`@sunstone-partners/ensemble-agent-core`)
into a live Pi session via Pi's native, documented extension mechanism
(`pi.registerTool`, `pi.on` lifecycle events). No fork or patch of Pi's
agent loop.

See `docs/architecture/ensemble-behavior-runtime-plan.md` and
`docs/TRD/TRD-2026-0fc1c1d0-behavior-runtime-pi-harness.md` (TRD-004) for
the design.

## Dependency note

This package depends on `@earendil-works/pi-coding-agent`, matching the
package actually resolved by the installed `pi` binary (0.87.1+). The
older `@mariozechner/pi-coding-agent` scope is deprecated upstream in
favor of `@earendil-works/*` — do not add a dependency on the
`@mariozechner` scope to this package.

## Testing

- `npm test` runs the jest unit suite (capability-guard behavior).
- `npm run test:smoke` runs `scripts/smoke-activate.mjs`, a real Node ESM
  subprocess that loads this extension through Pi's actual
  `discoverAndLoadExtensions` loader. This must run outside jest:
  `@earendil-works/pi-coding-agent` ships ESM-only (no `require` export
  condition), so jest's CommonJS resolver cannot load it even via a
  dynamic `import()`.

## OMP

The same extension also installs into OMP (`npm run install:extension`), but
OMP support is claimed only from OMP's own conformance run, never from Pi's
suite or from both hosts reading the same behavior YAML:

    npm run test:omp-conformance -w packages/pi-extension

It runs the real `omp` binary (`OMP_BIN`, else `omp` on `PATH`) against a
scripted model on 127.0.0.1, so model traffic never leaves the machine and
costs nothing. It checks every host capability the extension's source relies
on (`tests/omp-conformance/host-capabilities.ts`), then runs this checkout's
bundled extension inside OMP, granted and ungranted. A capability OMP lacks
goes in `OMP_GAPS` and is reported as unsupported, never passed; it is not
worked around by forking OMP. Without an `omp` binary the suite fails instead
of passing.

What it does not cover: runs are non-interactive (`omp -p`), where OMP reports
`ctx.hasUI === false`, so approval prompts fail closed there and interactive
approval on OMP is not verified.

Recorded run (update this line when re-running): omp/18.4.6, 2026-10-02. Every
required host capability was provided and no gaps are documented. The
extension armed, registered its tool and commands, ran its governed tool when
granted, denied it when not, and observed tool calls through its own
subscriptions. The suite also asserts, as observations rather than
requirements, that OMP reports no UI under `-p` and fires no `tool_result` for
a call blocked in `tool_call` (the block reason still reaches the model).
