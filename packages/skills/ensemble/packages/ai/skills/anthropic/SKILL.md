---
name: anthropic
description: "Use when integrating the Claude API/SDK (Messages, tool use, streaming, prompt caching, extended thinking) into application code; not for OpenAI, Perplexity or non-Claude providers."
---

# Anthropic API conventions

Never hard-code model IDs, context sizes or prices from memory: read them from config/env and check the provider's current model list before choosing one.

Gotchas:
- Key from `ANTHROPIC_API_KEY` (environment/secret manager), never in source or logs.
- `max_tokens` is required; handle `stop_reason` values (`max_tokens`, `tool_use`, `refusal`).
- Tool use loop: return a `tool_result` block for every `tool_use` id in the next user turn, preserving order; surface errors with `is_error: true`.
- Extended thinking: pass the thinking blocks back unchanged during tool loops; `budget_tokens` must be below `max_tokens`.
- Prompt caching: mark stable prefixes (system, tools, long docs) with `cache_control`; any prefix change invalidates the cache.
- Stream with the SDK helpers; retry 429/5xx with backoff (the SDK retries by default; do not stack your own).
