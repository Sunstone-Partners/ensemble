# @sunstone-partners/ensemble-product

Product management agents and workflows (PRD creation, analysis)

## Installation

```bash
claude plugin install @sunstone-partners/ensemble-product
```

## Description

Part of the ensemble plugin ecosystem for Claude Code. This plugin provides product management agents and workflows (prd creation, analysis).

## Features

- Product requirements and analysis command set.
- Adaptive planning complexity analysis via `/ensemble:analyze-complexity`.

## Adaptive Planning Complexity

`/ensemble:analyze-complexity <description>` runs a deterministic local analyzer before planning starts. It does not call a remote model in v1. The output includes score, selected depth, path, factor rationale, override state, disable state, and uncertainty.

Score bands:

- `1-3` = Simple → `fix-issue`
- `4-6` = Medium → `create-prd -> create-trd`
- `7-10` = Complex → `create-prd -> refine-prd -> create-trd -> refine-trd`

Overrides:

- `--depth simple|medium|complex` forces a planning depth for one invocation and records the original classification.
- `--no-auto-complexity` disables automatic scoring for one invocation; it uses `--depth`, then configured default depth, then Medium.
- Direct manual commands such as `/ensemble:fix-issue`, `/ensemble:create-prd`, and `/ensemble:create-trd` remain available and unchanged.

Foreman mode:

- `--foreman` is non-interactive and never prompts.
- When `FOREMAN_ARTIFACT_PATH` is set, the phase report is written to that exact path in addition to any repo-local report.

Generated artifacts:

- Edit command YAML under `packages/product/commands/`.
- Run `npm run generate` to refresh generated markdown under `packages/product/commands/ensemble/`.

## Usage

After installation, this plugin's agents, commands, and skills will be automatically available in Claude Code.

## Documentation

See the [main ensemble repository](https://github.com/Sunstone-Partners/ensemble) for complete documentation.

## License

MIT
