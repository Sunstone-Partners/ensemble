---
name: langgraph
description: "Use when building stateful or multi-agent workflows with LangGraph (StateGraph, conditional edges, checkpointing, human-in-the-loop); not for single LLM calls or simple chains."
---

# LangGraph conventions

Check the installed `langgraph` version first: the API (`interrupt`, `Command`, prebuilt agents) moves between releases.

Gotchas:
- State is a typed schema (TypedDict/Pydantic); use reducers (`Annotated[list, add_messages]`) for fields that accumulate, otherwise nodes overwrite them.
- Nodes return partial state updates, not the full state, and must not mutate their input.
- Every cycle needs an exit condition plus a `recursion_limit`.
- Persistence: compile with a checkpointer and pass `thread_id` in `config`; human-in-the-loop requires it.
- Human approval: use `interrupt` and resume with `Command(resume=...)`; keep node side effects idempotent because nodes re-run on resume.
- Take model names from config; do not hard-code them.
- Test nodes as plain functions before wiring the graph.
