---
name: ensemble-web-metrics-dashboard
description: Generate web performance metrics dashboard with Core Web Vitals (Codex skill for /ensemble:web-metrics-dashboard)
user-invocable: true
---

# Ensemble Command: /ensemble:web-metrics-dashboard

This Codex skill mirrors the Ensemble slash command `/ensemble:web-metrics-dashboard`.
Follow the workflow below, adapt to the current repository, and keep outputs structured.

<!-- DO NOT EDIT - Generated from web-metrics-dashboard.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Generate a comprehensive web performance metrics dashboard including Core Web Vitals,
Lighthouse scores, bundle sizes, and performance recommendations for frontend applications.

## Workflow

### Phase 1: Metrics Collection

**1. Performance Testing**
   Run Lighthouse audits and collect metrics

**2. Bundle Analysis**
   Analyze JavaScript bundle sizes

### Phase 2: Dashboard Generation

**1. Metrics Dashboard**
   Generate visual dashboard with metrics

## Expected Output

**Format:** Performance Dashboard

**Structure:**
- **Core Web Vitals**: LCP, FID, CLS measurements
- **Lighthouse Scores**: Performance, accessibility, SEO scores
- **Recommendations**: Actionable performance improvements

## Usage

```
/ensemble:web-metrics-dashboard
```
