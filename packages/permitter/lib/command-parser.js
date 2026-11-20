/**
 * Command parser module for Permitter.
 *
 * Handles:
 * - Shell tokenization with quote handling
 * - Operator detection (&&, ||, ;, |)
 * - Environment variable stripping
 * - Wrapper command stripping (timeout, env, etc.)
 * - Subshell extraction (bash -c "...")
 *
 * @module command-parser
 */

'use strict';

// Commands that are wrappers and should be stripped
const WRAPPER_COMMANDS = new Set(['timeout', 'time', 'nice', 'nohup', 'env']);

// Commands that are skipped entirely
const SKIP_COMMANDS = new Set(['export', 'set', 'unset', 'local', 'declare', 'typeset']);

// Commands that create or change a variable. Their options decide how the
// value is interpreted, so the ones the parser cannot follow are refused.
const DECLARATION_COMMANDS = new Set(['declare', 'typeset', 'local']);

// Environment variables that change how a command is resolved or parsed.
// PATH controls executable lookup, LD_* / DYLD_* inject code into the
// process, IFS changes how words are split, BASH_ENV / ENV make a shell
// source a file before it runs anything. A command that assigns one of them
// is refused instead of having the assignment silently stripped.
const DANGEROUS_ASSIGNMENT_VARS = new Set(['PATH', 'IFS', 'BASH_ENV', 'ENV']);

// Operators that split commands
// '&' (background) and '|&' (pipe stdout+stderr) also start a new command.
const OPERATORS = new Set(['&&', '||', ';', '|', '&', '|&']);

// Redirection operators whose target is a file path. Only /dev/null targets are
// considered safe (see checkRedirections).
const REDIRECT_OPERATORS = new Set(['>', '>>', '<', '&>', '&>>']);

// Tokenizer states
const State = {
  NORMAL: 'NORMAL',
  SINGLE_QUOTE: 'SINGLE_QUOTE',
  DOUBLE_QUOTE: 'DOUBLE_QUOTE',
  ESCAPE: 'ESCAPE'
};

/**
 * Check that every quote in a command is closed.
 *
 * An unbalanced quote means the real word boundaries are unknown, so the
 * command is refused instead of being classified from a guess. Quote
 * characters inside a comment are counted as well: a stray apostrophe in a
 * comment ("git status # don't") is exactly the shape that hides a tail from
 * the parser, so it is treated as unsafe.
 *
 * @param {string} command - Raw command string
 * @throws {Error} If a quote is left open
 */
function checkQuoteBalance(command) {
  let state = State.NORMAL;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (state === State.NORMAL) {
      if (char === '\\') {
        i++; // escaped character, never a quote delimiter
      } else if (char === "'") {
        state = State.SINGLE_QUOTE;
      } else if (char === '"') {
        state = State.DOUBLE_QUOTE;
      }
    } else if (state === State.SINGLE_QUOTE) {
      // No escaping inside single quotes
      if (char === "'") {
        state = State.NORMAL;
      }
    } else if (char === '\\') {
      i++; // escaped character inside double quotes
    } else if (char === '"') {
      state = State.NORMAL;
    }
  }

  if (state !== State.NORMAL) {
    throw new Error('Unbalanced quote not supported');
  }
}

/**
 * Tokenize a Bash command string.
 *
 * Uses a state machine to properly handle:
 * - Single-quoted strings (no escaping)
 * - Double-quoted strings (backslash escaping)
 * - Unquoted whitespace as token separator
 * - Multi-character operators (&&, ||)
 * - Comments: a '#' that begins a word runs to the end of the line
 *
 * @param {string} command - Raw command string
 * @returns {string[]} Array of tokens
 */
function tokenize(command) {
  if (!command || typeof command !== 'string') {
    return [];
  }

  const tokens = [];
  let current = '';
  let state = State.NORMAL;
  let prevState = State.NORMAL;
  let inQuotedSection = false; // Track if we've been in a quoted section for this token

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const nextChar = command[i + 1];

    switch (state) {
      case State.NORMAL:
        if (char === '$' && (nextChar === "'" || nextChar === '"')) {
          // ANSI-C quoting ($'...') and locale quoting ($"...") are not
          // implemented by the tokenizer: their word boundaries can differ
          // from the shell's, so the command is refused instead of being
          // classified from a guess.
          throw new Error('ANSI-C quoting not supported');
        } else if (char === "'") {
          // Enter single-quote mode
          state = State.SINGLE_QUOTE;
          inQuotedSection = true;
        } else if (char === '"') {
          // Enter double-quote mode
          state = State.DOUBLE_QUOTE;
          inQuotedSection = true;
        } else if (char === '\\') {
          // Escape next character
          prevState = state;
          state = State.ESCAPE;
        } else if (char === '\n' || char === '\r') {
          // Newline is a command separator, exactly like ';'
          if (current || inQuotedSection) {
            tokens.push(current);
            current = '';
            inQuotedSection = false;
          }
          tokens.push(';');
        } else if (char === '(' || char === ')') {
          // Subshell, grouping, arithmetic, function definitions
          throw new Error('Subshell/grouping not supported');
        } else if (/\s/.test(char)) {
          // Whitespace ends current token
          if (current || inQuotedSection) {
            tokens.push(current);
            current = '';
            inQuotedSection = false;
          }
        } else if (char === '#' && current === '' && (i === 0 || /[ \t\n;|&]/.test(command[i - 1]))) {
          // A '#' that begins a word starts a comment that runs to the end of
          // the line. The newline is left in place so it still separates
          // commands: a later line is never swallowed by a comment.
          // Only space, tab and newline separate words in the shell, so a '#'
          // after any other character (non-breaking space, vertical tab,
          // form feed, carriage return) is an ordinary argument and the rest
          // of the line stays a separate command.
          while (i < command.length && command[i] !== '\n') {
            i++;
          }
          i--; // the loop increment lands back on the newline (or the end)
          continue;
        } else if ((char === '>' || char === '<') && /^(>>?|<)&(\d+|-)/.test(command.slice(i))) {
          // fd duplication/close such as 2>&1, >&2, <&0, 2>&-: no file involved
          const m = /^(>>?|<)&(\d+|-)/.exec(command.slice(i));
          if (m[2] !== '-' && !/^[012]$/.test(m[2])) {
            // fd N>2 may be an inherited open file; its target is not analyzable
            throw new Error('Redirection to an arbitrary file descriptor not supported');
          }
          const prefix = /^\d+$/.test(current) ? current : '';
          if (current && !prefix) {
            tokens.push(current);
          }
          current = '';
          tokens.push(prefix + m[0]);
          i += m[0].length - 1;
        } else if (char === '&' && nextChar === '>') {
          // &> and &>> redirect stdout+stderr to a file
          if (current) {
            tokens.push(current);
            current = '';
          }
          if (command[i + 2] === '>') {
            tokens.push('&>>');
            i += 2;
          } else {
            tokens.push('&>');
            i++;
          }
        } else if (char === '|' && nextChar === '&') {
          if (current) {
            tokens.push(current);
            current = '';
          }
          tokens.push('|&');
          i++;
        } else if (char === '&' && nextChar === '&') {
          // && operator
          if (current) {
            tokens.push(current);
            current = '';
          }
          tokens.push('&&');
          i++; // Skip next char
        } else if (char === '|' && nextChar === '|') {
          // || operator
          if (current) {
            tokens.push(current);
            current = '';
          }
          tokens.push('||');
          i++; // Skip next char
        } else if (char === ';') {
          // ; operator
          if (current) {
            tokens.push(current);
            current = '';
          }
          tokens.push(';');
        } else if (char === '|') {
          // | operator (single pipe)
          if (current) {
            tokens.push(current);
            current = '';
          }
          tokens.push('|');
        } else if (char === '>' && nextChar === '>') {
          // >> redirection
          if (current) {
            tokens.push(current);
            current = '';
          }
          tokens.push('>>');
          i++; // Skip next char
        } else if (char === '>' || char === '<') {
          // Single redirection
          if (current) {
            tokens.push(current);
            current = '';
          }
          tokens.push(char);
        } else if (char === '&' && !/\d/.test(current) && current !== '') {
          // Background operator at end of token
          tokens.push(current);
          current = '';
          tokens.push('&');
        } else if (char === '&') {
          // Standalone & or part of fd redirect like 2>&1
          if (current) {
            tokens.push(current);
            current = '';
          }
          tokens.push('&');
        } else {
          current += char;
        }
        break;

      case State.SINGLE_QUOTE:
        if (char === "'") {
          // Exit single-quote mode (no escaping inside single quotes)
          state = State.NORMAL;
        } else {
          current += char;
        }
        break;

      case State.DOUBLE_QUOTE:
        if (char === '"') {
          // Exit double-quote mode
          state = State.NORMAL;
        } else if (char === '\\') {
          // Escape handling inside double quotes
          prevState = state;
          state = State.ESCAPE;
        } else {
          current += char;
        }
        break;

      case State.ESCAPE:
        // Add escaped character and return to previous state
        current += char;
        state = prevState;
        break;
    }
  }

  // Handle remaining token
  if (current || inQuotedSection) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Check for unsafe constructs that should cause deferral.
 *
 * Detects:
 * - Command substitution: $() and ``
 * - Heredocs: <<
 * - Process substitution: <() and >()
 *
 * @param {string} command - Raw command string
 * @throws {Error} If unsafe construct detected
 */
function checkUnsafe(command) {
  if (!command || typeof command !== 'string') {
    return;
  }

  // Command substitution: $()
  if (/\$\(/.test(command)) {
    throw new Error('Command substitution $() not supported');
  }

  // Command substitution: backticks
  if (/`/.test(command)) {
    throw new Error('Command substitution `` not supported');
  }

  // Heredocs: <<
  if (/<</.test(command)) {
    throw new Error('Heredocs not supported');
  }

  // Process substitution: <() and >()
  if (/<\(/.test(command) || />\(/.test(command)) {
    throw new Error('Process substitution not supported');
  }
}

/**
 * Reject redirections the parser cannot analyze safely.
 *
 * Redirection targets are stripped from segments during normalization, so an
 * allowlisted command could otherwise write to / read from arbitrary paths.
 * Allowed: fd duplication (2>&1, >&2, 2>&-) and targets of exactly /dev/null.
 * Anything else (including a redirection with no literal target) throws, which
 * makes the hook fall through to the normal permission dialog.
 *
 * @param {string[]} tokens - Tokens from tokenize()
 * @throws {Error} If an unsafe redirection is present
 */
function checkRedirections(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (!REDIRECT_OPERATORS.has(tokens[i])) {
      continue;
    }
    const target = tokens[i + 1];
    if (target !== '/dev/null') {
      throw new Error('Redirection to a path not supported');
    }
  }
}

/**
 * Split tokens by operator tokens.
 *
 * @param {string[]} tokens - Array of tokens
 * @returns {string[][]} Array of token segments (each segment is a command)
 */
function splitByOperators(tokens) {
  if (!tokens || tokens.length === 0) {
    return [];
  }

  const segments = [];
  let current = [];

  for (const token of tokens) {
    if (OPERATORS.has(token)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      // Operators are not included in segments
    } else {
      current.push(token);
    }
  }

  // Add final segment
  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

/**
 * Environment assignment: `NAME=value` or bash's append form `NAME+=value`.
 *
 * The base name (the identifier in front of the subscript and `=` or `+=`)
 * is what decides whether the assignment is dangerous, so it is captured
 * on its own: `PATH[0]=/evil` mutates PATH just like `PATH=/evil`.
 * The subscript and the value are captured as well, because bash reads
 * both as arithmetic expressions.
 * `A+B=c` is not an assignment in bash (invalid identifier) and does not
 * match here either.
 *
 * @type {RegExp}
 */
const ENV_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[[^\]]*\])*)(?:\+?=)(.*)$/;

/**
 * Split an assignment token into its parts.
 *
 * @param {string} token - Token to check
 * @returns {{name: string, subscript: string, value: string}|null} Parts, or null when the token is not an assignment
 */
function envAssignmentParts(token) {
  if (!token || typeof token !== 'string') {
    return null;
  }
  const match = ENV_ASSIGNMENT_RE.exec(token);
  if (!match) {
    return null;
  }
  return { name: match[1], subscript: match[2], value: match[3] };
}

/**
 * Get the variable name an assignment token sets.
 *
 * @param {string} token - Token to check
 * @returns {string|null} Variable name, or null when the token is not an assignment
 */
function envAssignmentName(token) {
  const parts = envAssignmentParts(token);
  return parts ? parts.name : null;
}

/**
 * Check if token is an environment variable assignment.
 *
 * @param {string} token - Token to check
 * @returns {boolean} True if token is a VAR=value or VAR+=value format
 */
function isEnvAssignment(token) {
  return envAssignmentName(token) !== null;
}

/**
 * Check if a variable must not be assigned by a command.
 *
 * @param {string} name - Variable name without '='
 * @returns {boolean} True if assigning the variable is unsafe
 */
function isDangerousAssignmentVar(name) {
  return DANGEROUS_ASSIGNMENT_VARS.has(name) ||
    name.startsWith('LD_') ||
    name.startsWith('DYLD_');
}

/**
 * Refuse an assignment to a variable that changes command behaviour.
 *
 * @param {string} name - Variable name without '='
 * @throws {Error} If the variable must not be assigned
 */
function assertSafeAssignmentVar(name) {
  if (isDangerousAssignmentVar(name)) {
    throw new Error(`Dangerous variable assignment not supported: ${name}`);
  }
}

/**
 * Refuse a VAR=value (or VAR+=value) token that changes command behaviour.
 *
 * @param {string} token - VAR=value or VAR+=value token
 * @throws {Error} If the assignment targets a dangerous variable
 */
function assertSafeAssignment(token) {
  const parts = envAssignmentParts(token);
  if (parts === null) {
    return;
  }
  assertSafeAssignmentVar(parts.name);
  if (parts.subscript && !/^\[\d+\]$/.test(parts.subscript)) {
    // Bash evaluates an array subscript as an arithmetic expression, so
    // `a[PATH=0]=x` assigns PATH inside the subscript. Only a plain index
    // is understood here, so anything else is refused.
    throw new Error(`Subscripted assignment not supported: ${token}`);
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(parts.value)) {
    // The value of a variable with the integer attribute is evaluated as an
    // arithmetic expression, and there `n+=PATH=0` assigns PATH. The parser
    // cannot see the attribute, so a value that looks like an assignment is
    // refused.
    throw new Error(`Arithmetic assignment not supported: ${token}`);
  }
}

/**
 * Check whether a token can expand to a value the parser cannot see.
 *
 * A single-quoted string is inert in bash, so only an expansion outside
 * single quotes counts.
 *
 * @param {string} token - Token to check
 * @returns {boolean} True if the token contains an active expansion
 */
function hasExpansion(token) {
  if (!token || typeof token !== 'string') {
    return false;
  }
  const outsideSingleQuotes = token.replace(/'[^']*'/g, '');
  return outsideSingleQuotes.includes('$') || outsideSingleQuotes.includes('`');
}

/**
 * Refuse a skipped command that changes a variable the parser cannot trust.
 *
 * `export PATH=/evil`, `declare IFS=$x` and `unset PATH` change the
 * environment of every command that follows them on the same line, so the
 * segment is refused instead of being skipped.
 *
 * @param {string[]} tokens - Tokens of the segment, first token is the command
 * @throws {Error} If the command changes a dangerous variable
 */
function assertSafeSkipCommand(tokens) {
  const command = tokens[0];
  const rest = tokens.slice(1);

  for (const token of rest) {
    if (isEnvAssignment(token)) {
      assertSafeAssignment(token);
    } else if (hasExpansion(token)) {
      // `export "$X"` expands before bash runs it, so the variable it sets
      // cannot be established here: the segment is refused instead of
      // being skipped.
      throw new Error(`dynamic ${command} argument not supported: ${token}`);
    }
  }

  if (command === 'unset') {
    for (const token of rest) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
        assertSafeAssignmentVar(token);
      }
    }
  }
}

/**
 * Check if a token is a redirection operator.
 *
 * @param {string} token - Token to check
 * @returns {boolean} True if token is a redirection
 */
function isRedirection(token) {
  // Matches: >, <, >>, 2>, 2>&1, etc.
  return /^[<>]/.test(token) || /^\d+[<>]/.test(token) || token === '>>' || token === '2>&1';
}

/**
 * Normalize a command segment by stripping environment variables,
 * wrappers, skip commands, background operator, and redirections.
 *
 * @param {string[]} tokens - Token array for one command (will be mutated)
 * @returns {{executable: string, args: string}|null} Normalized command or null if skipped
 */
function normalizeSegment(tokens) {
  if (!tokens || tokens.length === 0) {
    return null;
  }

  // Clone to avoid mutating original
  tokens = [...tokens];

  // Strip leading environment variable assignments (KEY=value). An assignment
  // that changes how the command is resolved is refused, not stripped.
  while (tokens.length > 0 && isEnvAssignment(tokens[0])) {
    assertSafeAssignment(tokens[0]);
    tokens.shift();
  }

  if (tokens.length === 0) {
    return null;
  }

  // Check if command should be skipped (export, set, etc.). A skipped
  // command still changes the environment of every command that follows it
  // on the same line, so an assignment to a variable the parser cannot trust
  // is refused instead of being skipped.
  if (SKIP_COMMANDS.has(tokens[0])) {
    assertSafeSkipCommand(tokens);
    return null;
  }

  // Strip wrapper commands (timeout, time, nice, nohup, env)
  while (tokens.length > 0 && WRAPPER_COMMANDS.has(tokens[0])) {
    const wrapper = tokens.shift();

    // Handle wrapper-specific arguments
    if (wrapper === 'timeout') {
      // timeout takes a duration argument (might be number or string like "30s")
      if (tokens.length > 0 && /^\d/.test(tokens[0])) {
        tokens.shift();
      }
      // timeout also has optional flags like --signal, -k, etc.
      while (tokens.length > 0 && tokens[0].startsWith('-')) {
        tokens.shift();
        // Some flags take arguments
        if (tokens.length > 0 && !tokens[0].startsWith('-') && !/^[a-z]/i.test(tokens[0])) {
          tokens.shift();
        }
      }
      // Check for duration again after flags
      if (tokens.length > 0 && /^\d/.test(tokens[0])) {
        tokens.shift();
      }
    } else if (wrapper === 'nice') {
      // nice takes optional -n value
      if (tokens.length > 0 && tokens[0] === '-n') {
        tokens.shift();
        if (tokens.length > 0) {
          tokens.shift(); // the numeric priority
        }
      } else if (tokens.length > 0 && /^-\d+$/.test(tokens[0])) {
        tokens.shift(); // nice -10 format
      }
    } else if (wrapper === 'env') {
      // env takes options and VAR=value pairs before the command it runs.
      // Only the forms whose effect is understood are stripped: -i (ignore
      // the environment) and -u NAME (unset a variable). Every other option
      // (-C/--chdir, -S/--split-string, -0, -v, --, ...) can change what is
      // actually executed, so the segment is refused instead.
      while (tokens.length > 0) {
        const token = tokens[0];

        if (isEnvAssignment(token)) {
          assertSafeAssignment(token);
          tokens.shift();
          continue;
        }

        if (!token.startsWith('-')) {
          break; // the command env should run
        }

        if (token === '-i') {
          tokens.shift();
          continue;
        }

        if (token === '-u') {
          tokens.shift();
          const name = tokens.length > 0 ? tokens.shift() : '';
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new Error('env option not supported: -u requires a variable name');
          }
          assertSafeAssignmentVar(name);
          continue;
        }

        throw new Error(`env option not supported: ${token}`);
      }
    }
    // time and nohup don't have additional arguments to strip
  }

  if (tokens.length === 0) {
    return null;
  }

  // Handle bash -c "command" - extract the inner command
  if (tokens[0] === 'bash' || tokens[0] === 'sh') {
    // Look for -c flag
    const cIndex = tokens.indexOf('-c');
    if (cIndex !== -1 && cIndex + 1 < tokens.length) {
      // The argument after -c is the command to parse
      const innerCommand = tokens[cIndex + 1];

      // Handle empty inner command
      if (!innerCommand || innerCommand.trim() === '') {
        return null;
      }

      // The inner command is parsed on its own, so it needs its own quote
      // check: an unbalanced quote there hides words just the same.
      checkQuoteBalance(innerCommand);

      // Recursively tokenize and normalize the inner command
      const innerTokens = tokenize(innerCommand);
      const innerSegments = splitByOperators(innerTokens);

      // If there are multiple commands in the inner shell, we need to return the first
      // and the caller should handle the rest
      if (innerSegments.length > 0) {
        return normalizeSegment(innerSegments[0]);
      }
      return null;
    }
  }

  // Strip trailing & (background operator)
  while (tokens.length > 0 && tokens[tokens.length - 1] === '&') {
    tokens.pop();
  }

  if (tokens.length === 0) {
    return null;
  }

  // Strip redirections and their targets
  const cleaned = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (isRedirection(token)) {
      // Skip the redirection operator
      // Also skip the next token if it's a filename (not a command or flag)
      if (i + 1 < tokens.length && !isRedirection(tokens[i + 1])) {
        i++; // Skip the target
      }
      continue;
    }

    // Handle combined redirections like 2>&1
    if (token === '2>&1' || /^\d+>&\d+$/.test(token)) {
      continue;
    }

    cleaned.push(token);
  }

  if (cleaned.length === 0) {
    return null;
  }

  return {
    executable: cleaned[0],
    args: cleaned.slice(1).join(' ')
  };
}

/**
 * Strip the blanks bash treats as word separators.
 *
 * `String.trim()` also removes characters bash keeps inside a word
 * (U+00A0, U+000B, U+000C, U+FEFF, ...). Trimming those moves a following
 * '#' to the start of the command, where the tokenizer would treat the rest
 * of the line as a comment and never classify the command that runs there.
 * Only space, tab and newline separate words in bash, so only those are
 * trimmed.
 *
 * @param {string} command - Raw command string
 * @returns {string} Command without leading/trailing shell blanks
 */
function trimShellBlanks(command) {
  return command.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
}

/**
 * Refuse a command line that declares a variable the parser cannot follow.
 *
 * `declare -n p=LD_PRELOAD` makes p an alias of LD_PRELOAD, so an
 * assignment to p changes LD_PRELOAD without naming it, and `declare -i n`
 * makes the value of n an arithmetic expression, so `n+=PATH=0` assigns
 * PATH. Neither effect can be tracked, so the command line is refused.
 *
 * The guard is on the command line rather than on a single segment,
 * because the declaration and the assignment that exploits it can sit in
 * different segments of the same line.
 *
 * @param {string[][]} segments - Token segments of the command line
 * @throws {Error} If a segment declares an alias or an integer variable
 */
function assertSafeDeclarationOptions(segments) {
  for (const segment of segments) {
    if (segment.length === 0 || !DECLARATION_COMMANDS.has(segment[0])) {
      continue;
    }
    for (const token of segment.slice(1)) {
      if (token === '--') {
        break;
      }
      if (!/^-[A-Za-z]+$/.test(token)) {
        continue;
      }
      const flags = token.slice(1);
      if (flags.includes('n')) {
        throw new Error(`Nameref declaration not supported: ${token}`);
      }
      if (flags.includes('i')) {
        throw new Error(`Integer declaration not supported: ${token}`);
      }
    }
  }
}

/**
 * Parse a Bash command and extract normalized core commands.
 *
 * This is the main entry point for the parser. It:
 * 1. Checks for unsafe constructs
 * 2. Tokenizes the command
 * 3. Splits by operators
 * 4. Normalizes each segment
 *
 * @param {string} command - Raw Bash command string
 * @returns {{executable: string, args: string}[]} Array of normalized commands
 * @throws {Error} If command contains unsupported constructs
 */
function parseCommand(command) {
  if (!command || typeof command !== 'string') {
    return [];
  }

  const trimmed = trimShellBlanks(command);
  if (!trimmed) {
    return [];
  }

  // Check for unsafe constructs first
  checkUnsafe(trimmed);

  // An unbalanced quote makes the word boundaries unknowable, so the command
  // is refused rather than classified from a guess.
  checkQuoteBalance(trimmed);

  // Tokenize the command
  const tokens = tokenize(trimmed);
  if (tokens.length === 0) {
    return [];
  }

  checkRedirections(tokens);

  // Split by operators into segments
  const segments = splitByOperators(tokens);

  // A declaration the parser cannot follow is refused for the whole line
  assertSafeDeclarationOptions(segments);

  // Normalize each segment
  const commands = [];
  for (const segment of segments) {
    const normalized = normalizeSegment(segment);
    if (normalized) {
      commands.push(normalized);
    }
  }

  return commands;
}

module.exports = {
  parseCommand,
  tokenize,
  splitByOperators,
  normalizeSegment,
  checkUnsafe,
  checkRedirections,
  checkQuoteBalance,
  // Export constants for testing
  WRAPPER_COMMANDS,
  SKIP_COMMANDS,
  OPERATORS,
  DANGEROUS_ASSIGNMENT_VARS,
  State
};
