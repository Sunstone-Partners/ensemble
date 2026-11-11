# Summary

<!-- What changed, and why. One short paragraph. Link the TRD/bead if there is one. -->

<!--
An agent-authored PR must name the accountable human on its own line, outside
any comment, like this:  Directed by: @your-github-login
-->

## Checklist

- [ ] Size is within ~400 changed hand-written lines (generated output excluded), or the overage is justified here:
- [ ] A new component (package, plugin, hook, guard) has its own PR and is not bundled into a refactor or audit PR
- [ ] For any removed or renamed command, skill, agent or CLI flag: consumers checked (sibling repos, `packages/pi`, `packages/codex`, `packages/opencode`) and a deprecated shim left, or the consumer change merges in the same window
- [ ] Generated artifacts regenerated (`npm run generate` and the pi/codex/opencode generators) and committed
- [ ] `npm run ci:local` run before pushing (when available)
- [ ] Every deferred review finding is classified under the `pr-review-cycle` stopping rule (blocking vs. bead for opt-in/best-effort):

## Testing

<!--
The commands you ran and what they proved; name any test you added.
Replace this comment with your answer: an unfilled section counts as missing.
-->

## Risk

<!--
What could break, who is affected, and how it would be noticed.
Call out any sensitive area touched (workflows, release gates, installers,
the generation pipeline, the constitution) -- see REVIEW.md.
-->

## How to revert

<!-- The exact revert path: a `git revert <sha>`, a flag flip, or a rollback. -->
