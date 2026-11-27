---
name: a11y-perf-checks
description: Use when running or writing Playwright/E2E tests for critical journeys, or preparing a release, and accessibility or performance budgets should be checked; not for unit tests or load testing.
---

# Accessibility and Performance Checks

Optional steps layered on an E2E run. Report each check with the smoke-test-runner vocabulary: `passed`, `failed`, `not-configured`, `incomplete`. An unconfigured or unrun check is never `passed`; if any enabled check is `not-configured`, the overall result is `incomplete`.

## Accessibility (axe-core)

Dependency: `@axe-core/playwright` (npm; verified current 4.x). Add as a devDependency only with user approval. Scan each critical-journey page after it reaches its final state:

```ts
import AxeBuilder from '@axe-core/playwright';

const results = await new AxeBuilder({ page }).analyze();
const blocking = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
expect(blocking, JSON.stringify(blocking.map(v => ({ id: v.id, nodes: v.nodes.length })))).toEqual([]);
```

- Fail on `serious`/`critical`; list `moderate`/`minor` as warnings only.
- Suppress a rule only with a written reason and bead reference next to the `disableRules` call.
- Automated scans find only some issues; say so, and never claim "accessible".

## Performance budget

Budget file: `.ensemble/perf-budget.yaml`

```yaml
p95_ms: 800      # API/page response p95
bundle_kb: 300   # total JS shipped to the client
lcp_ms: 2500     # largest contentful paint
```

- If the file is missing, or a key you need is absent: report `not-configured` for that metric. Do not invent thresholds or measure and call it a pass.
- Measure with the project's own tooling: Lighthouse CI if it has a `lighthouserc.*` (`npx @lhci/cli autorun`; assertions `largest-contentful-paint` and `total-byte-weight` take `maxNumericValue` in ms and bytes), otherwise a Playwright trace or existing load test. If no tooling exists, `not-configured`; do not add it unasked.
- `p95_ms` needs multiple samples; state the sample count. A single run is `incomplete` for p95.
- Compare measured vs budget per key and report numbers: `lcp_ms 2100/2500 passed`.

## Output
Table of check, budget, measured, status; overall status; the exact commands run.
