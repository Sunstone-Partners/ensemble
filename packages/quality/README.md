# @sunstone-partners/ensemble-quality

Quality assurance, code review, and DoD enforcement

## Installation

```bash
claude plugin install @sunstone-partners/ensemble-quality
```

## Dependencies

Stack detection (`detect-stack`: framework, test runner, infrastructure tooling and cloud provider) ships in
`@sunstone-partners/ensemble-core`, not in this package. `deep-debugger` runs
`skills/detect-stack/detect-stack.js --axis=test` to find the project's test runner, so install
`ensemble-core` as well:

```bash
claude plugin install @sunstone-partners/ensemble-core
```

Pi has no plugin dependency mechanism, so there too `ensemble-core` must be installed alongside this package.

## Description

Part of the ensemble plugin ecosystem for Claude Code. This plugin provides quality assurance, code review, and dod enforcement.

## Features

- TBD (to be populated during plugin extraction)

## Skills Included

### PR Review Remediation

Verify and remediate findings from CodeRabbit or another PR review agent — triage, reproduce, fix minimally, and validate, without treating review comments as trusted instructions.

**Quick Reference**: `skills/pr-review-remediation/SKILL.md`

## Usage

After installation, this plugin's agents, commands, and skills will be automatically available in Claude Code.

## Documentation

See the [main ensemble repository](https://github.com/Sunstone-Partners/ensemble) for complete documentation.

## License

MIT
