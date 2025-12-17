---
name: ensemble:refine-prd
description: Refine and improve existing Product Requirements Document
---

Refine and improve an existing Product Requirements Document (PRD) based on feedback or new insights.

## IMPORTANT: Document Refinement Only

**DO NOT implement, build, or execute any work described in the PRD.**

This command ONLY refines the PRD document itself. The arguments describe what should be improved in the document, not what should be built. After refining the PRD, stop and wait for user approval before any implementation begins.

## Mission

Review and enhance an existing PRD with:
- Clarification of ambiguous requirements
- Addition of missing acceptance criteria
- Improved user analysis
- Better-defined scope boundaries

## Workflow

1. **PRD Review**
   - Read and analyze existing PRD
   - Identify gaps and ambiguities
   - Note missing acceptance criteria

2. **User Interview** (REQUIRED before any changes)
   - Present identified gaps and ambiguities to the user
   - Ask clarifying questions about unclear requirements
   - Gather feedback on scope, priorities, and trade-offs
   - Confirm understanding before proceeding

   **Standard Interview Questions:**
   - Are there any requirements that are unclear or need more detail?
   - Are there missing user scenarios we should address?
   - Are the acceptance criteria complete and testable?
   - Is the scope correctly defined (in-scope vs out-of-scope)?
   - Are there any technical constraints or dependencies not captured?
   - What is the priority order of the features/requirements?
   - Are there any open questions or decisions that need resolution?

3. **Refinement** (Only after interview complete)
   - Incorporate user feedback into the document
   - Clarify ambiguous requirements based on answers
   - Add missing user scenarios identified
   - Strengthen acceptance criteria
   - Update scope boundaries

4. **Output**
   - Update PRD document with improvements
   - Document changes made in revision history
   - Present summary of updates for user approval

## Usage

```
/ensemble:refine-prd <path to PRD or feedback to incorporate>
```

Delegates to `product-management-orchestrator` for structured refinement.
