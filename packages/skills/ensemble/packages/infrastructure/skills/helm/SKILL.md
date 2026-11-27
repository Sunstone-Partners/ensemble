---
name: helm
description: "Use when creating, linting or deploying Helm charts (templates, values, releases); not for raw Kubernetes manifests."
---

# Helm conventions

Auth comes from the active kubeconfig: pass `--kube-context` and `--namespace` explicitly and confirm the context before install/upgrade.

Gotchas:
- Validate in order: `helm lint`, `helm template ... | kubectl apply --dry-run=server -f -`, then `helm upgrade --install`.
- Non-interactive deploys: `helm upgrade --install <rel> <chart> -n <ns> --create-namespace --atomic --wait --timeout 5m -f values.yaml`; `--atomic` rolls back on failure.
- Never put secrets in `values.yaml`; reference existing Secrets or an external secret operator.
- Quote string values in templates (`{{ .Values.x | quote }}`); use `required` for mandatory values and `toYaml | nindent` for blocks.
- Add a checksum annotation of ConfigMaps/Secrets to pods so config changes roll them.
- Bump `version` for chart changes and keep `appVersion` separate; `helm dependency update` after editing dependencies.
- `helm uninstall`/`rollback` need user approval.
