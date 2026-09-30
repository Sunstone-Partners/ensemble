/**
 * Types for the `new-feature` orchestrating workflow's run index.
 *
 * See docs/TRD/TRD-2026-d6bbf322-new-feature-workflow.md (TRD-001, Component
 * Design's data contracts) for the authoritative shape this file implements.
 */

/**
 * Fixed stage sequence, in PRD stage order. A run advances through these
 * stages strictly in order and never skips or reorders (REQ-002).
 */
export type Stage =
  | "prd_create"
  | "prd_refine"
  | "trd_create"
  | "trd_refine"
  | "beads_plan"
  | "implementation_approval"
  | "implementation"
  | "pr_approval"
  | "pr_create"
  | "done";

/**
 * Outcome recorded for the current stage. `approval_wait` marks a run
 * halted at a human-approval checkpoint (implementation_approval,
 * pr_approval); `decline` marks a stage the user explicitly declined to
 * advance past; `failure` marks a stage that errored.
 */
export interface StageOutcome {
  kind: "success" | "decline" | "failure" | "approval_wait";
  detail?: string;
  recordedAt: string;
}

/**
 * Exact artifact lineage: which document a given stage produced, and the
 * exact path/documentId/version to pass to the next stage (never a
 * freshly-globbed path).
 */
export interface ArtifactRef {
  type: "prd" | "trd";
  path: string;
  documentId: string;
  version: string;
  producingStage: string;
  recordedAt: string;
}

/**
 * A single `new-feature` run: checkpointed, resumable state for one
 * PRD -> TRD -> beads -> implementation -> PR workflow instance.
 */
export interface RunRecord {
  runId: string;
  projectRoot: string;
  status: "active" | "paused" | "completed" | "abandoned";
  stage: Stage;
  stageOutcome: StageOutcome;
  artifacts: ArtifactRef[];
  beadRefs: string[];
  implementationApprovedAt: string | null;
  prApprovedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Fixed stage order; index N+1 is the only legal successor of index N. */
export const STAGE_ORDER: readonly Stage[] = [
  "prd_create",
  "prd_refine",
  "trd_create",
  "trd_refine",
  "beads_plan",
  "implementation_approval",
  "implementation",
  "pr_approval",
  "pr_create",
  "done",
];
