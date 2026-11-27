---
name: weaviate
description: "Use when building semantic, hybrid or RAG search on the Weaviate vector database (v4 Python/TypeScript client); not for other vector stores."
---

# Weaviate conventions

Use the v4 client (`weaviate.connect_to_*`) and check the server version before using newer features.

Gotchas:
- Always close the client (context manager / `client.close()`) or connections leak.
- Define collections explicitly with a vectorizer (or `none` with self-provided vectors); the vectorizer and its model cannot be changed after creation without re-indexing. Take model names from config.
- Hybrid search: tune `alpha` (0 = keyword, 1 = vector) per use case; evaluate rather than guess.
- Batch inserts with the batch context manager and check `failed_objects`/errors.
- Multi-tenancy: set it at collection creation and always pass the tenant.
- Credentials (`WEAVIATE_URL`, `WEAVIATE_API_KEY`, provider keys passed as headers) come from the environment.
