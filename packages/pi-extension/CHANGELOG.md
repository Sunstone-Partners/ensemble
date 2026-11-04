# Changelog

All notable changes to `@sunstone-partners/ensemble-pi-extension` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Model role check (`src/model-roles.ts`). When an Ensemble agent asks for the OMP tier role `high` or `medium` and `modelRoles` does not set it, the extension now says so loudly instead of OMP staying quiet. It handles OMP's `before_subagent_spawn` event, which carries the model list after OMP has applied `task.agentModelOverrides` and the role expansion, so it reads no settings or agent file and never fires for a configured role or a pinned agent. With a fallback model that resolves, the agent still runs and you get one warning per session. With nothing to fall back to, the spawn is refused with a message naming the missing `modelRoles.<role>` keys, `~/.omp/agent/config.yml` and an example, instead of OMP's "No model selected" and its advice to `/login`. Measured on omp 18.16.0; Pi and older OMP never emit the event and keep the quiet fallback.

### Changed

- `activate()` now registers one handler, for `before_subagent_spawn`, in every session, including repositories with no dispatcher YAML or hooks file, where it registered nothing before. The handler says nothing unless a spawn asked for an unset tier role. The installed shim's comment and the installer's closing message say so.
