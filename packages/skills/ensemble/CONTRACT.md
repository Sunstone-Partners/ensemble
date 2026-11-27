<!-- DO NOT EDIT - Generated from authoritative package sources by npm run generate:skills -->

# Ensemble execution contract

Read this before executing any Ensemble skill. This bundle needs no model-provider API.

- Resolve ENSEMBLE_ROOT to the absolute directory containing this file. In shell examples,
  set and export ENSEMBLE_ROOT to that path; always quote it. Resolve relative resource paths
  against the instruction file that names them, not the project working directory.
- Work on the user's target project. Tools live under ENSEMBLE_ROOT/packages; tool inputs
  and output paths belong to the project, unless a workflow explicitly says otherwise.
- Use manifest.json to map command aliases, skills, tools and role names to installed files.
  A slash command or Skill invocation means read that mapped skill and pass the stated
  arguments as ARGUMENTS. It does not require a provider command registry. Unknown aliases halt.
- Read/Write/Edit mean equivalent file operations; Bash means a shell; Glob/Grep mean file
  discovery/text search. AskUserQuestion means ask the user and wait for the answer.
  Tool names are operation descriptions, not a requirement for vendor APIs.
- Before starting, check the skill's declared required and optional capabilities and every
  concrete external CLI/service it invokes. Required unavailable operations HALT with their
  names and setup needed. Optional operations use ONLY the fallback explicitly authored in
  the workflow. Missing network, credentials, Python packages or project toolchains are not
  bundled capabilities. Never claim they were exercised merely because files were installed.
- Task/delegation requires an available agent execution mechanism and the specified role
  instructions. Independent review requires a distinct evaluator: serial self-review cannot
  replace it. If the needed mechanism or evaluator is unavailable, HALT that workflow.
- MCP/browser/service integrations require their stated service or an explicitly authored
  fallback. Claude hooks, lifecycle enforcement, permitter and runtime configuration are
  outside this portable bundle; installation does not provide them. Runtime setup commands
  appearing in source material are optional integration instructions, not portable operations.
- Never execute unresolved vendor paths or plugin-root searches. Installed tool/resource
  paths in this bundle take precedence. If no manifest entry supplies the requested artifact,
  HALT and name it instead of guessing a path or silently skipping a gate.

These mappings preserve authored approval, independence and failure requirements.
