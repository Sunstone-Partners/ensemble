---
name: threat-model
description: Add a `## Threat Model` section to a TRD when the PRD or TRD touches authentication/authorization, PII, payments, file upload, external network exposure, or a new third-party integration. Not for TRDs limited to internal refactors, UI copy, docs, or config with none of those areas; not a code review or vulnerability scan.
---

# Threat Model

Produce a `## Threat Model` section inside the TRD (create it, or revise the existing one). Keep it proportionate: a handful of credible threats beat an exhaustive STRIDE grid. Use the TRD's real component names, not generic ones.

## Steps

1. **Confirm the trigger.** Name which of the areas above the PRD/TRD touches and cite the REQ/component. If none apply, stop and write nothing.
2. **Assets.** List what an attacker would want: data classes (credentials, PII fields, payment data, uploaded files), privileges, availability of a critical path. One line each, with where it is stored/processed.
3. **Trust boundaries.** List each crossing from the TRD architecture: internet to service, service to datastore, service to third party, tenant to tenant, unprivileged to privileged role, uploaded content to parser/renderer.
4. **STRIDE per boundary.** Table: `Boundary | STRIDE | Threat | Likelihood/Impact (L/M/H) | Mitigation | Mitigating task`.
   - Include a row only when the threat is credible for this design. Omit a STRIDE category for a boundary rather than write "N/A" or a generic entry.
   - A mitigation is a concrete control (e.g. "verify JWT audience and expiry at the gateway"), not "follow best practices".
5. **Map mitigations to tasks.** Every mitigation in the table references an existing TRD task ID, written as plain text (`TRD-014`). If no task covers it, add one in the Master Task List using that file's own task grammar (`- [ ] **TRD-NNN**` with `[satisfies ...]` and `Implementation AC:`), plus a TRD-NNN-TEST task when user-facing. Never write checkbox task lines inside the Threat Model section: the parser would read them as duplicate tasks.
6. **Residual risks.** List accepted or deferred risks, each with a reason and an owner or revisit trigger. Say "none identified" only if the table has no High-impact rows left unmitigated.

## Output shape

```
## Threat Model
### Assets
### Trust Boundaries
### Threats and Mitigations   (the table)
### Residual Risks
```

## Rules

- Do not invent facts about the system: if a boundary or data flow is unclear from the PRD/TRD, record it as an open question under Residual Risks instead of guessing.
- Do not duplicate controls already specified in the TRD; reference them.
- Before finishing, check that every mitigation task ID in the table exists in the Master Task List.
