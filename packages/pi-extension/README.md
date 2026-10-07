# @sunstone-partners/ensemble-pi-extension

Thin Pi-specific extension providing native command completion for the
`prd`/`trd`/`issue`/`feature` dispatcher commands, via Pi's native,
documented extension mechanism (`pi.registerCommand`, `pi.sendUserMessage`).
No fork or patch of Pi's agent loop.

Each dispatcher registration (`registerDispatcherCommand` in
`src/dispatcher-commands.ts`) is a no-op in any repo that doesn't have the
corresponding YAML (`packages/product/commands/prd.yaml`,
`packages/development/commands/{trd,issue,feature}.yaml`), so this
extension loading globally in every session never pollutes an unrelated
repo's command list.

A previous version of this package also loaded a behavior-runtime/autofix
loop (test-failure observation, automated fix dispatch, constitution
proposals). That subsystem has been removed from `dev` and is retained on
the `pi-behaviors` branch for future development.

## Dependency note

This package depends on `@earendil-works/pi-coding-agent`, matching the
package actually resolved by the installed `pi` binary (0.87.1+). The
older `@mariozechner/pi-coding-agent` scope is deprecated upstream in
favor of `@earendil-works/*` — do not add a dependency on the
`@mariozechner` scope to this package.

## Testing

- `npm test` runs the jest unit suite against `dispatcher-commands.ts` and
  `extension.ts`'s native command registration.

## Installing globally

- `npm run install:extension` builds a bundle and installs a shim into
  `~/.omp/agent/extensions/`, so the dispatcher commands are available in
  every OMP/Pi session (see `scripts/install.mjs`).
- `npm run uninstall:extension` removes it.
