# fix-issue PR body template

Template for the PR body `/ensemble:fix-issue` builds in PR Creation (REQ-002). It is graded by this skill with `PR_BODY=<body>` and `AGENT_AUTHORED=true` before the PR is created.

`PR_BODY = '<## Problem\n{what was wrong}\n\n## Solution\n{the approach}\n\n## Changes\n- {file}: {what changed}\n\n## Testing\n{commands actually run and their result, plus the regression test added}\n\n## Risk\n{what could break, blast radius, severity; "Low: <reason>" when low}\n\n## How to revert\n{the exact undo, plus any data, migration or config step revert alone does not undo}\n\n## Checklist\n- [x] Tests pass locally\n\nFixes #{issue-number}\n\nDirected by: @<the GitHub login of the person who asked for this fix, never the agent>>'`
