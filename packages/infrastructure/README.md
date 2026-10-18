# @sunstone-partners/ensemble-infrastructure

Infrastructure management for AWS, Kubernetes, Docker, Helm, Fly.io

## Installation

```bash
claude plugin install @sunstone-partners/ensemble-infrastructure
```

## Dependencies

Stack detection (`detect-stack`: framework, test runner, infrastructure tooling and cloud provider) ships in
`@sunstone-partners/ensemble-core`, not in this package. The infrastructure agents run
`skills/detect-stack/detect-stack.js --axis=cloud` and `--axis=tooling` at task start to choose between the
`aws`, `helm`, `kubernetes` and `flyio` skills, so install `ensemble-core` as well:

```bash
claude plugin install @sunstone-partners/ensemble-core
```

Pi has no plugin dependency mechanism, so there too `ensemble-core` must be installed alongside this package.

## Description

Part of the ensemble plugin ecosystem for Claude Code. This plugin provides infrastructure management for aws, kubernetes, docker, helm, fly.io.

## Features

- TBD (to be populated during plugin extraction)

## Usage

After installation, this plugin's agents, commands, and skills will be automatically available in Claude Code.

## Documentation

See the [main ensemble repository](https://github.com/Sunstone-Partners/ensemble) for complete documentation.

## License

MIT
