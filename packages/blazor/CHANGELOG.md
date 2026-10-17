# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.0.0] - 2025-12-09

### Added

- Initial release extracted from ensemble v3.x monolith
- Plugin structure created for modular installation

## [Unreleased]

- Plugin extraction and population (in progress)

### Changed

- `skills/SKILL.md` frontmatter `name` is now `blazor` (was `Blazor Framework`), matching the package and directory name.

### Removed

- The `dotnet-framework` skill moved to the `ensemble-dotnet` package as the `dotnet` skill. `lib/index.js` no longer takes a `skillName` argument in `loadSkill`, `getTemplate`, and `getExample`, and `skill.skills` is now `['blazor']`.
