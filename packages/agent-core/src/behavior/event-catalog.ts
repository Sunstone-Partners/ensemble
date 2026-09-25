/**
 * The closed, versioned event catalog (source:
 * docs/architecture/ensemble-behavior-runtime-plan.md §5). A skill,
 * command, or agent cannot invent an event type by passing a new
 * string to a generic emitter — every typed domain tool below is
 * locked to its own small, explicit subset of this catalog.
 */

export const HARNESS_EVENT_TYPES = [
  "runtime.session.started",
  "runtime.prompt.submitted",
  "runtime.tool_call.started",
  "runtime.tool_call.completed",
  "runtime.message.emitted",
  "runtime.session.completed",
  "runtime.session.failed",
  "runtime.session.cancelled",
  "runtime.session.timed_out",
  "runtime.process.exited",
] as const;

export const SEMANTIC_EVENT_TYPES = [
  "behavior.observation.recorded",
  "behavior.outcome.recorded",
  "behavior.blocked",
  "behavior.unblocked",
  "behavior.completed",
  "behavior.abandoned",
  "child_behavior.requested",
  "approval.requested",
  "change.proposed",
  "prd.created",
  "prd.refined",
  "prd.approved",
  "prd.deprecated",
  "trd.created",
  "trd.refined",
  "trd.approved",
  "trd.deprecated",
  "implementation.started",
  "implementation.progressed",
  "implementation.blocked",
  "implementation.completed",
  "implementation.abandoned",
  "trd.implementation.started",
  "trd.implementation.progressed",
  "trd.implementation.completed",
  "review.requested",
  "review.completed",
  "review.changes_requested",
  "validation.requested",
  "validation.completed",
  "release.proposed",
  "release.approved",
  "release.completed",
  "learning.observation.recorded",
  "constitution.proposed",
  "test.failure.observed",
  "test.failure.investigated",
  "test.passed",
  "test.regression_detected",
  "repository.changed",
  "repository.branch.created",
  "pull_request.proposed",
  "pull_request.opened",
  "pull_request.updated",
] as const;

export type DomainToolName =
  | "ensemble.record_observation"
  | "ensemble.record_outcome"
  | "ensemble.propose_change"
  | "ensemble.report_blocked"
  | "ensemble.request_approval";

/**
 * The wrapper — not the model — selects the permitted event type. Each
 * tool's execute() rejects any eventType outside its own list here,
 * including any runtime.* event (harness-owned, never agent-claimable).
 */
export const DOMAIN_TOOL_EVENT_MAPPING: Record<DomainToolName, readonly string[]> = {
  "ensemble.record_observation": [
    "behavior.observation.recorded",
    "prd.created",
    "prd.refined",
    "trd.created",
    "trd.refined",
    "implementation.progressed",
    "test.failure.observed",
    "test.failure.investigated",
    "review.completed",
    "validation.completed",
  ],
  "ensemble.record_outcome": [
    "behavior.outcome.recorded",
    "test.passed",
    "implementation.completed",
    "trd.implementation.completed",
    "release.completed",
  ],
  "ensemble.propose_change": [
    "change.proposed",
    "prd.refined",
    "trd.refined",
    "constitution.proposed",
    "release.proposed",
  ],
  "ensemble.report_blocked": ["behavior.blocked", "behavior.unblocked", "implementation.blocked"],
  "ensemble.request_approval": [
    "approval.requested",
    "prd.approved",
    "trd.approved",
    "release.approved",
  ],
};
