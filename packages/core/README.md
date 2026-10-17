# @sunstone-partners/ensemble-core

Core orchestration and utilities for ensemble ecosystem

## Installation

```bash
claude plugin install @sunstone-partners/ensemble-core
```

## Description

Part of the ensemble plugin ecosystem for Claude Code. This plugin provides core orchestration and utilities for ensemble ecosystem.

## Features

- TBD (to be populated during plugin extraction)

## Skills Included

### detect-stack

Detect a project's framework, test runner, infrastructure tooling and cloud provider with confidence scoring, so the matching technology skills (`react`, `jest`, `helm`, `aws`, ...) can be loaded. One CLI, `node skills/detect-stack/detect-stack.js --axis=framework|test|tooling|cloud|all`, and one output shape for all four axes. The agents of `ensemble-infrastructure` and `ensemble-quality` call it, so those plugins need this one installed.

**Quick Reference**: `skills/detect-stack/SKILL.md`

## Usage

After installation, this plugin's agents, commands, and skills will be automatically available in Claude Code.

## Documentation

See the [main ensemble repository](https://github.com/Sunstone-Partners/ensemble) for complete documentation.

## License

MIT
