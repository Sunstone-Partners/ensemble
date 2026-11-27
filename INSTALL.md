# Install Ensemble skills into a project

Point your coding agent at this repository and ask it to follow this file. The
primary distribution is a shared Agent Skills bundle, without a provider SDK or
runtime configuration. Node.js and npm build and install it; no provider API key
is needed for installation.

In this checkout, run:

```sh
npm ci
npm run generate:skills
npm run install:skills -- /absolute/path/to/your-project --dry-run
npm run install:skills -- /absolute/path/to/your-project
```

Use a project directory, not a runtime home. Inspect the dry-run result before
installing into an existing project. No global configuration is changed.

| Project path | Purpose |
| --- | --- |
| `.agents/skills/<name>/SKILL.md` | Standard skill discovery and command entry points |
| `.agents/ensemble/CONTRACT.md` | Operations, capabilities and independence requirements |
| `.agents/ensemble/manifest.json` | Command aliases, skills, roles and tool locations |
| `.agents/ensemble/packages/` | Full skill resources, tools, data and adapter manifests |
| `.agents/ensemble/roles/` | Specialist instructions without provider launch configuration |
| `.agents/ensemble/node_modules/` | Vendored tool dependencies |
| `.agents/ensemble/installed.json` | Owned-file hashes for safe updates |

The checkout may be moved or removed after installation. Installed tools resolve
their own dependencies; they do not use the checkout's `node_modules`. Run them
from the target project with explicit project input/output paths.

An agent that discovers `.agents/skills/` can use the skills normally. Without
automatic discovery, ask it to read `.agents/skills/ensemble-create-prd/SKILL.md`
and supply the desired product as ARGUMENTS. The entry links the execution
contract and full instructions. Resolve relative resources against the file
that names them. Command aliases are listed in the installed manifest.

Set `ENSEMBLE_ROOT` to the absolute installed `.agents/ensemble` directory for
shell examples using it. Manifest tool and role paths are relative to that
directory; skill paths are relative to `.agents`.

## Capabilities and limits

File operations, search, shell execution and user questions map to equivalent
operations in the host agent. Vendor-named tools and slash command registries
are not assumed. YAML capability declarations are retained in the manifest.
Check each workflow's concrete external operations before starting. Required
unavailable capabilities halt with a named reason. Use optional fallbacks only
where the source workflow explicitly supplies them.

Delegation needs an available agent execution mechanism. Independent evaluation
requires a distinct evaluator; serial self-review cannot replace it. Missing
services, CLIs, credentials, Python packages, browser access or project toolchains
must be reported. Runtime-specific setup instructions remain optional integration
instructions; unresolved paths or calls halt rather than use an improvised substitute.

`ensemble-create-prd` and `ensemble-create-trd` also need a project constitution.
They will not save their output until it passes their constitution gate, and no
mode bypasses the gate. Put the constitution at `docs/standards/constitution.md`
(preferred) or `.specify/memory/constitution.md`, with each rule under its own
heading. Without one they halt with `CONSTITUTION_CONFIG_ERROR` and write nothing.

Claude hooks, lifecycle enforcement, permitter and runtime configuration are
outside this bundle. Existing [runtime integrations](README.md#runtimes) remain
available. Installing files alone does not prove every workflow's capabilities
are available.

## Updates and conflicts

Rebuild and run the same installer. Byte-identical reinstallation writes nothing.
Updates replace unchanged owned files and remove only unchanged files the old
manifest recorded. Unrelated files, `AGENTS.md` and runtime configuration remain
untouched. Modified owned files and conflicting unowned files stop preflight
before any write. Save or explicitly remove conflicts, then retry. There is no
force-replacement mode. Symlinked target paths and invalid manifest paths are
rejected. Keep the ownership manifest with the installation.

## Development

Edit authoritative command YAML, skill sources and generator code, not generated
`packages/skills` files. Run `npm run generate:skills`, followed by
`npm run generate:skills:check`. The generated package is excluded from source
discovery. Dependency vendoring follows explicit runtime entry dependencies and
their declared npm closure from the lockfile-installed checkout. Source tests
and runtime hooks are not copied.
