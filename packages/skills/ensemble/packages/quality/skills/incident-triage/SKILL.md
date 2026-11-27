---
name: incident-triage
description: Use when a PRODUCTION incident, outage, or post-release regression is reported, or when asked for a postmortem; not for bugs found in development or tests (use deep-debugger).
---

# Incident Triage

Order matters: **stabilise first, diagnose second.**

## 1. Stabilise
Pick the fastest safe option and ask the user to approve before any production change: roll back, disable the feature flag, or scale/failover. For rollback follow the release-agent protocol (`/ensemble:release --rollback`). A rollback succeeded only when the previous version's tag is the one deployed AND smoke-test-runner returns `status: "passed"` against production. `incomplete` or `failed` means not recovered: say so.

## 2. Reconstruct the timeline
Collect facts with timestamps (UTC) from tools, never from memory:
- `git log --since=<window> --format='%h %cI %an %s'` and `git tag --sort=-creatordate | head`
- `gh run list --limit 20` (deploy and CI runs; `gh run view <id> --log-failed`)
- Alerts, logs, dashboards the user supplies. Mark unknowns as `unknown`; do not infer.

## 3. Diagnose
State a root-cause hypothesis with the evidence for and against it. Hand the code-level reproduction and fix to `deep-debugger` (failing test first); do not patch production code from within triage.

## 4. Postmortem
Write `docs/postmortems/<YYYY-MM-DD>-<slug>.md`, blameless (describe systems and decisions, not people). Template: `skill://incident-triage/postmortem-template.md` (read it).

## 5. Action items
List proposed items to the user first. After approval only: `br create "<action>" -t task -l postmortem` (verify flags with `br create --help`), and link bead ids in the postmortem. Do not create beads unapproved.

## Output
Current status (stabilised / not), timeline, root-cause confidence (confirmed / probable / unknown), postmortem path, bead ids.
