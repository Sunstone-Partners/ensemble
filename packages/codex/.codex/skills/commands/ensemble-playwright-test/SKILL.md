---
name: ensemble-playwright-test
description: Automated E2E testing and error resolution using Playwright MCP integration (Codex skill for /ensemble:playwright-test)
user-invocable: true
---

# Ensemble Command: /ensemble:playwright-test

This Codex skill mirrors the Ensemble slash command `/ensemble:playwright-test`.
Follow the workflow below, adapt to the current repository, and keep outputs structured.

<!-- DO NOT EDIT - Generated from playwright-test.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Automated application testing and error resolution using Playwright MCP server
integration. Generates test specs, executes tests, captures failures, and provides
debugging context for quick resolution.

## Workflow

### Phase 1: Test Planning

**1. User Flow Identification**
   Identify critical user flows to test

**2. Test Spec Generation**
   Generate Playwright test specifications

### Phase 2: Test Execution

**1. Test Run**
   Execute Playwright tests with trace capture

   **Delegation:** @playwright-tester
   Test specifications and target application URL

**2. Result Analysis**
   Analyze test results and capture failures

### Phase 3: Error Resolution

**1. Failure Diagnosis**
   Analyze failure screenshots and traces

**2. Fix Implementation**
   Implement fixes for identified issues

## Expected Output

**Format:** Test Results and Traces

**Structure:**
- **Test Report**: Pass/fail status for all tests
- **Traces**: Playwright traces for failed tests
- **Screenshots**: Failure screenshots for debugging

## Usage

```
/ensemble:playwright-test
```
