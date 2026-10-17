# @sunstone-partners/ensemble-pi

Pi runtime support — translates Ensemble YAML sources into Pi coding agent artifacts.

## Overview

`ensemble-pi` is the translation layer between the Ensemble plugin ecosystem and the
[Pi coding agent](https://github.com/mariozechner/pi). It reads Ensemble YAML command
definitions, agent manifests, and skill files from the monorepo and emits Pi-compatible
artifacts: prompt templates, agent definitions, skill directories, and an agent mesh reference.

The generated output lives inside this package and is loaded by Pi at runtime via the
`pi` manifest field in `package.json`.

## Installation

**From the Pi package registry:**

```bash
pi install @sunstone-partners/ensemble-pi
```

**Local development install:**

```bash
pi install ./packages/pi
```

### Native OMP delegation

Oh My Pi (OMP) loads this package through the same `pi` manifest. The agent
transformer maps an explicitly declared `Task` tool to OMP's native `task` tool.
OMP uses that lowercase name to infer spawn permission when `spawns` is absent;
its normal spawn-policy and recursion-depth guards still apply. Agents whose
source does not declare `Task` or `task` are not granted delegation.

In OMP, invoke the generated workflow skills, for example:

```text
/skill:ensemble-create-trd <prd-path>
```

The package supplies agent definitions, not a delegation implementation for
runtimes without a native `task` tool. This mapping does not configure model
routing or change approval gates.

## Generated Artifacts

| Directory / File | Count | Description |
|-----------------|-------|-------------|
| `prompts/` | 38 files + `prompts/_hidden/` (8) | Prompt templates (one per Ensemble command outside the self-contained packages below; invoked `/ensemble-<cmd>`). `_hidden/` holds commands that are reachable only through a dispatcher; `package.json` `pi.prompts` is `./prompts/*.md` (non-recursive) so Pi does not register them |
| `agents/` | 34 files | Agent definition markdown (one per Ensemble agent) |
| `skills/` | one per skill | Skill documentation copied from all packages except `assessment` (see below) |
| `AGENTS.md` | 1 file | Agent mesh reference extracted from the monorepo |

All artifact counts reflect the current state after running `npm run generate:pi` from
the monorepo root. The `skills/` count is not pinned here; it varies as skills are added.

> **Assessment is not bundled.** The `assessment` package (`assess-*`,
> `architecture-overview-report`, `ai-readiness-diagnostic-report`,
> `assessment-report-suite`, `assessment-scoring-conflation-audit`) is excluded from
> `skills/` by the skill-copier. It ships as its own Pi package,
> `@sunstone-partners/ensemble-assessment`, together with its `/ensemble-assess` command
> (generated into `packages/assessment/prompts/`, not into `prompts/` here, because that prompt
> names skills this package does not contain). There is no dependency between the two
> packages, so install both if you want the workflow skills and assessments:
>
> ```bash
> pi install @sunstone-partners/ensemble-pi
> pi install @sunstone-partners/ensemble-assessment
> ```

### Self-contained packages

`SELF_CONTAINED_PI_PACKAGES` (`src/self-contained-packages.ts`) names the packages that are
installed as Pi packages of their own; today that is `assessment`. Listing a package there does two
things together, keyed by package directory and never by command name:

- the skill-copier skips its skills, so installing both packages never registers a skill twice;
- its commands are generated into the package itself (`<package>/prompts/` and the wrapper skills
  in `<package>/skills/`) by `generateSelfContainedPackages`, and `generate()` leaves them out of
  this package. Dispatcher refs resolve only within one package's own commands, so a command can
  never point at a prompt that package does not ship.

The wrapper skills of a self-contained package carry `user-invocable: false`: that package is also
a Claude Code plugin whose real command comes from the same YAML, and Claude Code would otherwise
list the Pi/OMP wrapper beside it. Pi and OMP ignore the key.

To add a package: list it in `SELF_CONTAINED_PI_PACKAGES`, give its `package.json` the `pi-package`
keyword and a `pi` manifest with `skills: ["./skills"]` and `prompts: ["./prompts/*.md"]` (the
non-recursive glob; a bare `./prompts` also registers `prompts/_hidden/`), and add `prompts/` to
its `files`. `tests/self-contained-packages.test.ts` checks the manifest and that nothing of the
package reaches this one. `npm run generate:pi` runs both generators (`generateAll`).

## Usage

**Standard (via monorepo root):**

```bash
npm run generate:pi
```

**Direct CLI (after building):**

```bash
node packages/pi/dist/index.js
node packages/pi/dist/index.js --dry-run --verbose
node packages/pi/dist/index.js --validate
```

## CLI Flags

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview all file writes without writing to disk |
| `--verbose` | Emit detailed progress for each transformer step |
| `--validate` | Validate generated output against Pi schema rules; exit 1 on errors |

Flags can be combined: `--dry-run --verbose` previews all output with full logging.

## Development

```bash
# Build TypeScript
npm run build

# Run tests
npm test

# Regenerate Pi artifacts from current Ensemble sources
npm run generate

# Validate versions are in sync (package.json vs plugin.json)
npm run validate:version
```

The `generate` script calls `node dist/index.js` after `build`. Run `npm run build &&
npm run generate` after any source changes.

## Architecture

```
Ensemble YAML sources (packages/*/commands/*.yaml, agents/*.yaml, skills/)
          |
          v
  Generator orchestrator (src/generator.ts)
          |
    ┌─────┴──────────────────────────────┐
    |             Transformer pipeline    |
    |  command-transformer   → prompts/  |
    |  agent-transformer     → agents/   |
    |  skill-copier          → skills/   |
    |  agents-md-generator   → AGENTS.md |
    └────────────────────────────────────┘
          |
          v
     Pi artifact output (this package)
```
**Transformer responsibilities:**

- **command-transformer** — converts Ensemble YAML `phases`/`steps`/`actions` into Pi
  prompt template markdown (for a self-contained Pi package, into that package's own
  `prompts/`)
- **agent-transformer** — converts YAML agent definitions into Pi agent markdown with
  Pi-compatible tool lists
- **skill-copier** — propagates `SKILL.md` files from all packages (except `pi`, `full`
  and the self-contained Pi packages) into `skills/`
- **agents-md-generator** — extracts the agent mesh overview from `packages/CLAUDE.md`
## Contributing

Bug reports and feature requests: [https://github.com/Sunstone-Partners/ensemble/issues](https://github.com/Sunstone-Partners/ensemble/issues)

See the [main ensemble repository](https://github.com/Sunstone-Partners/ensemble) for
development conventions, commit standards, and the PR process.

## License

MIT
