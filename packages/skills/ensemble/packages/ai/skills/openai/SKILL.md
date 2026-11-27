---
name: openai
description: "Use when integrating the OpenAI API/SDK (Chat Completions, Responses, embeddings, tool calling, streaming) into application code; not for Anthropic, Perplexity or other providers."
---

# OpenAI API conventions

Never hard-code model IDs, token limits or prices: take the model name from config and check the provider's current model list when choosing one.

Gotchas:
- Key from `OPENAI_API_KEY` in the environment; never commit or log it.
- Prefer the Responses API for new agentic work; keep Chat Completions where the codebase already uses it. Do not mix them in one flow.
- Tool calls: return one `tool` message (or function_call_output) per call id; validate arguments as JSON before executing; use strict structured outputs/JSON schema instead of parsing free text.
- Embeddings: one model per index; changing the model means re-embedding everything. Batch inputs.
- Streaming: accumulate tool-call argument deltas by index before parsing.
- Handle 429 with exponential backoff and respect `Retry-After`; set per-request timeouts.
