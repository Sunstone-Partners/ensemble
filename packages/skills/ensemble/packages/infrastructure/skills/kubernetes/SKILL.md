---
name: kubernetes
description: "Use when authoring, reviewing or applying Kubernetes manifests/Kustomize overlays with kubectl; not for Helm chart templating or non-Kubernetes deploys."
---

# Kubernetes conventions

Auth comes from the active kubeconfig: confirm `kubectl config current-context` before any mutating command and pass `--context`/`-n` explicitly in scripts. Never create or print secrets in plain manifests.

Gotchas:
- Validate before applying: `kubectl apply --dry-run=server -f ...` or `kubectl diff`; use `kubectl kustomize` to render overlays.
- Non-interactive rollouts: `kubectl rollout status deploy/x --timeout=120s`; use `kubectl wait --for=condition=...` instead of sleeps.
- Always set resource requests/limits, readiness and liveness probes, and a non-root `securityContext`.
- Pin image tags/digests; never `latest`.
- Use `apply` (declarative); do not `kubectl edit` managed resources.
- Destructive commands (`delete`, `drain`, `--force`) need explicit user approval.
