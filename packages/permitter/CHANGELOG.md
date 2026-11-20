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
- Bash's append assignment form `NAME+=value` is now recognised as an assignment, so `export LD_PRELOAD+=/tmp/evil.so; git status` (also `declare`/`typeset`/`set`/`local`) is refused like the plain `=` form instead of being auto-allowed with the assignment silently dropped.
- The parser strips only bash word separators (space, tab, newline) before parsing, instead of every JavaScript whitespace character, so a leading non-breaking space, vertical tab, form feed, carriage return, byte order mark or line separator can no longer move a `#` to the start of the command and hide the rest of the line.
- An assignment that carries a subscript is matched on its variable name, so `declare PATH[0]=/tmp/evil; git status` is refused like `declare PATH=/tmp/evil; git status`.
- A declaration command whose argument expands (`export $X`, `export "$X"`, `unset $X`, `declare $X`) is refused instead of being skipped, because bash expands the name before the declaration runs and the variable it sets cannot be established: `X=PATH=/tmp/evil; export $X; git status` previously hid a PATH override from the allowlist. Literal assignments (`export FOO=bar`) stay allowed.
- A subscripted assignment whose subscript is not a plain index is refused, because bash evaluates the subscript as an arithmetic expression: `a[PATH=0]=x; git status` assigned `PATH` and was auto-allowed. A plain numeric subscript (`declare FOO[0]=bar`) stays allowed.
- A declaration that changes how a variable is interpreted is refused for the whole command line: `declare -n p=LD_PRELOAD` makes `p` an alias of `LD_PRELOAD` and `declare -i n` makes the value of `n` an arithmetic expression, so both let an assignment change `PATH` or `LD_PRELOAD` without naming them.
- An assignment whose value is itself an assignment (`n+=PATH=0`) is refused, because a variable with the integer attribute evaluates its value as an arithmetic expression and assigns `PATH`.

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
