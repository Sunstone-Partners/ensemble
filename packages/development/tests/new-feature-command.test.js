/**
 * Unit tests for new-feature.yaml command structure (TRD-003)
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const FIXED_STAGE_ORDER = [
  'prd_create',
  'prd_refine',
  'trd_create',
  'trd_refine',
  'beads_plan',
  'implementation_approval',
  'implementation',
  'pr_approval',
  'pr_create',
  'done',
];

describe('New-Feature Command', () => {
  let commandYaml;
  let yamlContent;

  beforeAll(() => {
    const commandPath = path.join(__dirname, '../commands/new-feature.yaml');
    yamlContent = fs.readFileSync(commandPath, 'utf-8');
    commandYaml = yaml.load(yamlContent);
  });

  describe('Metadata', () => {
    test('has valid metadata structure', () => {
      expect(commandYaml.metadata).toBeDefined();
      expect(commandYaml.metadata.name).toBe('ensemble:new-feature');
      expect(commandYaml.metadata.category).toBe('implementation');
      expect(commandYaml.metadata.source).toBe('sunstone');
    });
  });

  describe('AC-002-1: fixed stage order', () => {
    test('constraints declare the exact PRD stage sequence, in order, with no gaps', () => {
      const orderConstraint = commandYaml.constraints.find((c) => c.includes('Stage order is fixed'));
      expect(orderConstraint).toBeDefined();
      for (const stage of FIXED_STAGE_ORDER) {
        expect(orderConstraint).toContain(stage);
      }
      // Every stage name appears in declared order (not just present-anywhere).
      const positions = FIXED_STAGE_ORDER.map((stage) => orderConstraint.indexOf(stage));
      const sorted = [...positions].sort((a, b) => a - b);
      expect(positions).toEqual(sorted);
    });

    test('Stage Resolution phase dispatch table lists every stage exactly once, in fixed order', () => {
      const phase = commandYaml.workflow.phases.find((p) => p.name === 'Stage Resolution');
      expect(phase).toBeDefined();
      const dispatchStep = phase.steps.find((s) => s.title === 'Dispatch to the Eligible Stage');
      expect(dispatchStep).toBeDefined();

      const lines = dispatchStep.instructions.split('\n').map((l) => l.trim());
      const dispatchedStages = FIXED_STAGE_ORDER.filter((stage) =>
        lines.some((l) => l.startsWith(`${stage} `) || l.startsWith(`${stage}-`)),
      );
      expect(dispatchedStages).toEqual(FIXED_STAGE_ORDER);
    });
  });

  describe('AC-002-3: no skip-ahead on stray files', () => {
    test('Load Current Checkpoint step derives the eligible stage from RunIndexStore state, and explicitly forbids consulting the filesystem', () => {
      const phase = commandYaml.workflow.phases.find((p) => p.name === 'Stage Resolution');
      const loadStep = phase.steps.find((s) => s.title === 'Load Current Checkpoint');
      expect(loadStep).toBeDefined();

      // The only two ways ELIGIBLE_STAGE is derived: from stageOutcome.kind
      // (success -> next stage) or from the current stage itself (not yet
      // succeeded -> same stage). Neither branch may consult the filesystem.
      expect(loadStep.instructions).toMatch(/stageOutcome\.kind/);
      expect(loadStep.instructions).toMatch(/ELIGIBLE_STAGE/);
      expect(loadStep.instructions).toMatch(/Never consult the filesystem/i);
      expect(loadStep.instructions).toMatch(/regardless of what files already exist on disk/i);
    });

    test('a non-success stageOutcome keeps the eligible stage pinned to the current stage, not a later one', () => {
      const phase = commandYaml.workflow.phases.find((p) => p.name === 'Stage Resolution');
      const loadStep = phase.steps.find((s) => s.title === 'Load Current Checkpoint');
      // Exercises exactly the TRD-003-TEST scenario in prose form: a run
      // parked at trd_create (outcome not success) with a stray
      // beads_plan-looking file present must still resolve to trd_create.
      expect(loadStep.instructions).toMatch(
        /\(and only it\) is what runs next/,
      );
    });
  });

  describe('Optional PR branch', () => {
    test('pr_approval and pr_create are reserved stage slots, not unconditionally executed', () => {
      const orderConstraint = commandYaml.constraints.find((c) => c.includes('pr_approval'));
      expect(orderConstraint).toContain('only entered if a PR was requested');
      expect(orderConstraint).toContain('completion without a PR request is a valid terminal state');
    });
  });

  describe('AC-001-1/2/3: Entry Point Resolution (TRD-005)', () => {
    let entryPhase;

    beforeAll(() => {
      entryPhase = commandYaml.workflow.phases.find((p) => p.name === 'Entry Point Resolution');
    });

    test('phase exists and runs before Stage Resolution', () => {
      expect(entryPhase).toBeDefined();
      const stagePhase = commandYaml.workflow.phases.find((p) => p.name === 'Stage Resolution');
      expect(entryPhase.order).toBeLessThan(stagePhase.order);
    });

    test('AC-001-1: idea input creates exactly one run via RunIndexStore.createRun and prints its identifier', () => {
      const step = entryPhase.steps.find((s) => s.title === 'Idea Input -- Start a New Run');
      expect(step).toBeDefined();
      expect(step.instructions).toMatch(/RunIndexStore\.createRun\(projectRoot, idea\)/);
      expect(step.instructions).toMatch(/print the new run's identifier/);
      expect(step.instructions).toMatch(/prd_create/);
    });

    test('AC-008-1: createRun() rejection (RUN_ALREADY_ACTIVE) is handled without creating a second run', () => {
      const step = entryPhase.steps.find((s) => s.title === 'Idea Input -- Start a New Run');
      expect(step.instructions).toMatch(/RUN_ALREADY_ACTIVE/);
      expect(step.instructions).toMatch(/no new run is created/);
    });

    test('AC-001-2: a matched artifact path resumes that run at its recorded stage', () => {
      const step = entryPhase.steps.find((s) => s.title === 'Artifact-Path Input -- Resume an Indexed Run');
      expect(step).toBeDefined();
      expect(step.instructions).toMatch(/RunIndexStore\.resolveByArtifact\(projectRoot, path\)/);
      expect(step.instructions).toMatch(/Found:.*run's recorded stage/s);
    });

    test('AC-001-3: an unindexed artifact path is rejected; no run is created or advanced', () => {
      const step = entryPhase.steps.find((s) => s.title === 'Artifact-Path Input -- Resume an Indexed Run');
      expect(step.instructions).toMatch(/Not found:.*Create no run; advance nothing/s);
      expect(step.instructions).toMatch(/only.*resumed/is);
    });
  });

  describe('AC-003-1/2: --skip-refine rejection (TRD-006)', () => {
    test('rejects --skip-refine and equivalents before any stage runs, naming both mandatory refinement stages and the standalone commands', () => {
      const entryPhase = commandYaml.workflow.phases.find((p) => p.name === 'Entry Point Resolution');
      const step = entryPhase.steps.find((s) => s.title === 'Reject Unsupported Flags Before Any Stage Runs');
      expect(step).toBeDefined();
      expect(step.instructions).toMatch(/--skip-refine/);
      expect(step.instructions).toMatch(/mandatory/);
      expect(step.instructions).toMatch(/refine-prd/);
      expect(step.instructions).toMatch(/refine-trd/);
      expect(step.instructions).toMatch(/unmodified/);
      // This check must run first (order: 1), before createRun/resolveByArtifact steps.
      expect(step.order).toBe(1);
    });
  });

  describe('AC-006-2/3: explicit-retry-only resume (TRD-008)', () => {
    let entryPhase;
    let executePhase;

    beforeAll(() => {
      entryPhase = commandYaml.workflow.phases.find((p) => p.name === 'Entry Point Resolution');
      executePhase = commandYaml.workflow.phases.find((p) => p.name === 'Execute Stage');
    });

    test('AC-006-3: a bare resume of a failed run asks for explicit confirmation before re-dispatching, never auto-retries', () => {
      const step = entryPhase.steps.find((s) => s.title === 'No Arguments -- Resume Active or Show Status');
      expect(step).toBeDefined();
      expect(step.instructions).toMatch(/stageOutcome\.kind is "failure"/);
      expect(step.instructions).toMatch(/do NOT proceed to Stage Resolution on a\s*\n\s*bare invocation alone/);
      expect(step.instructions).toMatch(/no mutate\(\)\s*\n\s*call is made merely by viewing this prompt/);
    });

    test('AC-006-2: retry re-executes only the parked stage; earlier stages are never re-executed or re-derived', () => {
      const step = executePhase.steps.find((s) => s.title === 'Explicit-Retry-Only Resume of a Failed Stage');
      expect(step).toBeDefined();
      expect(step.instructions).toMatch(/only that stage's artifact\/outcome/);
      expect(step.instructions).toMatch(/never re-executed or\s*\n\s*re-derived by a retry/);
      expect(step.instructions).toMatch(/remain blocked/);
    });

    test('failure handling step defers to the confirmation gate for what counts as an explicit retry', () => {
      const failStep = executePhase.steps.find((s) => s.title === 'Handle Stage Failure');
      expect(failStep).toBeDefined();
      expect(failStep.instructions).toMatch(/AC-006-3/);
      expect(failStep.instructions).toMatch(/Do not advance, do not retry/);
    });
  });

  describe('AC-007-1/2: decline/edit handling (TRD-009)', () => {
    let recordStep;

    beforeAll(() => {
      const executePhase = commandYaml.workflow.phases.find((p) => p.name === 'Execute Stage');
      recordStep = executePhase.steps.find((s) => s.title === 'Record the Stage Outcome');
    });

    test('AC-007-1: a decline keeps the run at the current stage and asks for the needed correction', () => {
      expect(recordStep.instructions).toMatch(/stageOutcome to \{ kind: "decline"/);
      expect(recordStep.instructions).toMatch(/stage does not advance/);
      expect(recordStep.instructions).toMatch(/Ask\s*\n\s*the user for the correction\/input needed to continue/);
    });

    test('AC-007-2: an edit/regenerate request preserves the prior artifact and blocks dependent stages until acceptance', () => {
      expect(recordStep.instructions).toMatch(/edit\/regenerate request/);
      expect(recordStep.instructions).toMatch(/preserving the prior version/);
      expect(recordStep.instructions).toMatch(/do NOT advance `stage` and do NOT set\s*\n\s*stageOutcome\.kind to "success"/);
      expect(recordStep.instructions).toMatch(/No dependent stage may be dispatched/);
    });
  });

  describe('AC-012-1/2: --status reporting (TRD-011)', () => {
    let statusStep;

    beforeAll(() => {
      const entryPhase = commandYaml.workflow.phases.find((p) => p.name === 'Entry Point Resolution');
      statusStep = entryPhase.steps.find((s) => s.title === 'No Arguments -- Resume Active or Show Status');
    });

    test('AC-012-1: --status is read-only and always prints the five required fields', () => {
      expect(statusStep.instructions).toMatch(/If `status` is true/);
      expect(statusStep.instructions).toMatch(/No stage executes and no mutate\(\) call is made/);
      expect(statusStep.instructions).toMatch(/run identifier, current stage, last\s*\n\s*stageOutcome\.kind/);
      expect(statusStep.instructions).toMatch(/every recorded artifacts\[\] and\s*\n\s*beadRefs\[\] reference/);
      expect(statusStep.instructions).toMatch(/status is always\s*\n\s*read-only and never proceeds to Stage Resolution/);
    });

    test('AC-012-1: falls back to the most recent terminal run when none is active', () => {
      expect(statusStep.instructions).toMatch(/no dedicated "most recent terminal run" query/);
      expect(statusStep.instructions).toMatch(/pick the one with the latest updatedAt/);
    });

    test('AC-012-2: a completed run with no PR never implies one was created', () => {
      expect(statusStep.instructions).toMatch(/Never imply a PR was created or/);
      expect(statusStep.instructions).toMatch(/STATUS_RUN\.prApprovedAt is\s*\n\s*non-null AND a PR reference is present/);
      expect(statusStep.instructions).toMatch(/TRD-017's "pr:" prefix/);
      expect(statusStep.instructions).toMatch(/if either is missing, state\s*\n\s*plainly that no PR exists/);
    });
  });

  describe('AC-013-2: generated command is discoverable in each runtime (TRD-021)', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const markdownPath = path.join(repoRoot, 'packages/development/commands/ensemble/new-feature.md');
    const piPath = path.join(repoRoot, 'packages/pi/prompts/ensemble-new-feature.md');
    const codexPath = path.join(repoRoot, 'packages/codex/.codex/skills/commands/ensemble-new-feature/SKILL.md');
    const fixIssueMarkdownPath = path.join(repoRoot, 'packages/development/commands/ensemble/fix-issue.md');

    test('the product-command markdown file exists, carries the DO NOT EDIT banner, and has name/category frontmatter', () => {
      expect(fs.existsSync(markdownPath)).toBe(true);
      const content = fs.readFileSync(markdownPath, 'utf8');
      expect(content).toMatch(/DO NOT EDIT - Generated from new-feature\.yaml/);
      expect(content).toMatch(/name:\s*"ensemble:new-feature"/);
      expect(content).toMatch(/category:\s*"implementation"/);
    });

    test('the pi prompt file exists and carries its generator/source marker', () => {
      expect(fs.existsSync(piPath)).toBe(true);
      const content = fs.readFileSync(piPath, 'utf8');
      expect(content).toMatch(/Generated by ensemble-pi generator/);
      expect(content).toMatch(/Source: new-feature\.yaml/);
      expect(content).toMatch(/Command: ensemble-new-feature/);
    });

    test('the codex skill file exists, carries codex frontmatter, and is user-invocable', () => {
      expect(fs.existsSync(codexPath)).toBe(true);
      const content = fs.readFileSync(codexPath, 'utf8');
      expect(content).toMatch(/name:\s*ensemble-new-feature/);
      expect(content).toMatch(/user-invocable:\s*true/);
    });

    test('AC-013-2: new-feature appears alongside fix-issue in the product-command runtime (no separate catalog/manifest -- same file-presence discovery mechanism both commands share)', () => {
      expect(fs.existsSync(fixIssueMarkdownPath)).toBe(true);
      expect(fs.existsSync(markdownPath)).toBe(true);
    });
  });
});
