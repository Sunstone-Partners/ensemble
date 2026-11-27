---
name: flyio
description: "Use when deploying or configuring containerized apps on Fly.io (fly.toml, flyctl, regions, volumes, secrets); not for Kubernetes or AWS."
---

# Fly.io conventions

Auth: in CI and scripts use `FLY_API_TOKEN` (deploy token via `fly tokens create deploy`); never run interactive `fly auth login` in automation. Pass `-a <app>` explicitly.

Gotchas:
- `fly.toml` is the source of truth; `fly launch --no-deploy --copy-config` to avoid accidental creation, then `fly deploy --remote-only`.
- Secrets: `fly secrets set KEY=value` (use `--stage` to defer the restart); never put them in `fly.toml` `[env]`.
- Volumes are pinned to one host and region and are not replicated: create one per Machine, snapshot before risky changes, and mind `--ha=false` for single-volume apps.
- Health checks and `[http_service]` `internal_port` must match the app's listen port and `0.0.0.0` binding.
- Scale with `fly scale count/vm` and check `fly status` after deploy.
- `fly apps destroy`, volume deletion and `fly deploy --strategy immediate` need user approval.
