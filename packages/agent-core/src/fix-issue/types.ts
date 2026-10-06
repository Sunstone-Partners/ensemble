/**
 * Types for the `fix-issue` workflow's run index.
 *
 * See docs/TRD/TRD-2026-87e64cc6-command-surface-consolidation-data-model.md
 * (TRD-015, "IssueRunRecord"/"IssueArtifactRef") for the authoritative shape
 * this file implements. Structurally parallel to, but never joined with,
 * `new-feature/types.ts`'s `RunRecord` -- an issue run never references or
 * is referenced by a feature run (REQ-002).
 */

import type { StageOutcome } from "../new-feature/types";

// `StageOutcome` is reused as-is per the data-model doc ("the existing
// {...} type from new-feature/types.ts, imported as-is -- no issue-specific
// fork"); re-exported here so callers of this module never need to reach
// into `new-feature/types` directly.
export type { StageOutcome };

/**
 * Fixed stage sequence -- one entry per fix-issue.yaml's own named workflow
 * phases (Analysis & Planning, Execution, Validation & Delivery), plus the
 * terminal `done`.
 */
export type IssueStage = "analysis_planning" | "execution" | "validation_delivery" | "done";

/**
 * A reference to an artifact a fix-issue run produced. Looser than the
 * feature workflow's closed `"prd" | "trd"` union because fix-issue's own
 * output shape isn't fixed by this TRD.
 */
export interface IssueArtifactRef {
  /** Free-form label, e.g. "investigation-notes", "fix-plan". */
  type: string;
  path: string;
  recordedAt: string;
}

/**
 * A single `fix-issue` run: checkpointed, resumable state for one
 * investigate -> fix -> validate workflow instance.
 */
export interface IssueRunRecord {
  runId: string;
  projectRoot: string;
  /**
   * The issue report or description this run started from; persisted so a
   * later-session dispatch has input even without prior chat history
   * (mirrors `RunRecord.idea`).
   */
  issueDescription: string;
  status: "active" | "paused" | "completed" | "abandoned";
  stage: IssueStage;
  stageOutcome: StageOutcome;
  artifacts: IssueArtifactRef[];
  /** Bead IDs, and `pr:<url>`-prefixed PR references -- same convention as `RunRecord.beadRefs`. */
  beadRefs: string[];
  prApprovedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Fixed stage order; index N+1 is the only legal successor of index N. */
export const ISSUE_STAGE_ORDER: readonly IssueStage[] = [
  "analysis_planning",
  "execution",
  "validation_delivery",
  "done",
];
