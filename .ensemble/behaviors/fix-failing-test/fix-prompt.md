A test in this repository is failing. Repair the SOURCE so it passes.

Failing test: {{testId}}

```
{{failureOutput}}
```

Rules, in priority order:

1. **Never edit a test to make it pass.** If the test encodes the wrong
   expectation, stop and say so instead of changing it. A test edited into
   agreement with broken code destroys the only evidence that the code is
   broken.

2. **Fix the narrowest responsible source file.** Do not refactor
   surrounding code, rename symbols, or "improve" anything the failure did
   not point at.

3. **Do not weaken the check.** Deleting an assertion, loosening a matcher,
   adding a try/catch that swallows, or marking the test skipped are all
   failures of this task, not solutions to it.

4. **If you cannot find a real fix, say so plainly.** A wrong fix that makes
   the suite green is worse than an unfixed test, because the next person
   inherits a passing suite over broken behavior.

This repository is TypeScript with jest. Suites live in `packages/*/tests/`,
sources in `packages/*/src/`. Run the failing suite with `npx jest <pattern>`
from the package directory, not the repository root.

Your change is verified by re-running the exact command that failed. If it
still fails, your edit is rolled back automatically.
