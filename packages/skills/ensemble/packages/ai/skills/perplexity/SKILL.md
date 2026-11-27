---
name: perplexity
description: "Use when calling the Perplexity Sonar API for search-grounded answers with citations; not for general LLM chat or non-search use cases."
---

# Perplexity Sonar conventions

Check Perplexity's current model list before choosing a Sonar model; do not hard-code one from memory.

Gotchas:
- Key from `PERPLEXITY_API_KEY`; the endpoint is OpenAI-compatible (`https://api.perplexity.ai`), so reuse the OpenAI SDK with a custom `base_url`.
- Citations arrive in a separate response field (`citations`/`search_results`), not inline in the message; map `[n]` markers to that list and always show sources.
- Search is built in: do not wrap it in your own tool loop. Use domain and recency filters to constrain results.
- Roles must alternate user/assistant after the system message.
- Streaming delivers citations in the final chunk(s); render them after the stream ends.
- Treat answers as search-derived, not authoritative: verify critical facts.
