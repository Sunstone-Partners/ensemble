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
