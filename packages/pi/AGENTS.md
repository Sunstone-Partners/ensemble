# Ensemble Agent Mesh

> Generated from packages/*/.claude-plugin/plugin.json and packages/*/agents/*.yaml.

## Architecture Overview

Ensemble is a monorepo of plugin packages under `packages/`. Runtime packages (pi, codex, opencode) are generated translations of these sources.

- `ensemble-agent-core` - Shared, stage-agnostic run-index I/O primitives for the new-feature and fix-issue resumable workflows (npm library, no Claude Code skills/agents/commands)
- `ensemble-ai` - AI SDK skills for OpenAI, and other AI providers for Claude Code
- `ensemble-blazor` - Blazor frontend skills: Server and WebAssembly components, Razor, Fluent UI
- `ensemble-core` - Core orchestration and utilities for ensemble ecosystem
- `ensemble-development` - Development agents for frontend/backend implementation
- `ensemble-dotnet` - .NET backend development agents and skills (ASP.NET Core, Wolverine, MartenDB, CQRS/Event Sourcing)
- `ensemble-e2e-testing` - End-to-end testing with Playwright integration
- `ensemble-exunit` - ExUnit testing framework integration for Elixir
- `ensemble-full` - Complete ensemble ecosystem (meta-package with all plugins)
- `ensemble-git` - Git workflow automation and conventional commits
- `ensemble-guards` - Enforcement hooks: protected-branch, bypass-flag and br-close-evidence guards plus opt-in DoD stop gate
- `ensemble-infrastructure` - Infrastructure management for AWS, Kubernetes, Docker, Helm, Fly.io
- `ensemble-jest` - Jest testing framework integration
- `ensemble-lifecycle` - Run .ensemble/hooks.yaml command.start / command.end lifecycle hooks in Claude Code
- `ensemble-nestjs` - NestJS backend framework skills for Claude Code AI-Augmented Development
- `ensemble-permitter` - Smart permission expansion hook for Claude Code - semantic command matching
- `ensemble-phoenix` - Phoenix LiveView framework skills
- `ensemble-product` - Product management agents and workflows (PRD creation, analysis)
- `ensemble-pytest` - Pytest testing framework integration - Execute and generate Python tests with fixtures, parametrization, and mocking support
- `ensemble-quality` - Quality assurance, code review, and DoD enforcement
- `ensemble-rails` - Ruby on Rails backend framework skills
- `ensemble-react` - React framework skills and component development for Claude Code
- `ensemble-reqnroll` - Reqnroll + xUnit BDD bindings: fill PRD-generated step definitions test-first
- `ensemble-rspec` - RSpec testing framework integration
- `ensemble-telemetry` - Local, opt-in usage telemetry for Ensemble commands, skills and agents
- `ensemble-xunit` - xUnit testing framework integration for .NET

## Agent Mesh

24 agents, grouped by package.

### core

- `ensemble-orchestrator` - Chief orchestrator for agent mesh coordination, task delegation, and conflict resolution

### development

- `advisor` - Monitor active implementation to detect shortcuts, ensure the best solution is implemented rather than the fastest path, and intervene when an agent is silently bypassing requirements.
- `architect` - Design the technical approach for an implementation task; produce / validate the design before the builder starts; flag architectural drift during execution.
- `backend-developer` - Implement server-side logic across languages/stacks; enforce clean architecture and boundaries
- `beads-build-wave` - Depth-1 wave-runner subagent for /ensemble:beads-build. Runs exactly ONE scheduling wave by executing the ensemble:beads-build-wave command, then emits the single-line JSON summary its caller's loop reads.
- `beads-scaffold-specialist` - Design, create, audit, and repair Beads hierarchies from PRD/TRD/workstream artifacts without implementing code
- `documentation-specialist` - Technical documentation, API docs, guides, and examples
- `frontend-developer` - Framework-agnostic front-end implementation (JS/TS, React, Vue, Angular, Svelte) with accessibility and performance optimization
- `tech-lead-orchestrator` - Orchestrate traditional development methodology - plan, architect, task breakdown, develop, code-review, test loop until completion with intelligent delegation and quality loops

### dotnet

- `dotnet-backend-expert` - .NET backend specialist for ASP.NET Core APIs, Wolverine CQRS, MartenDB event sourcing, and C# patterns

### e2e-testing

- `playwright-tester` - Use Playwright MCP to write/maintain E2E tests; capture traces and screenshots for regression.

### git

- `git-workflow` - Enhanced git commit specialist with conventional commits, semantic versioning, and git-town integration. Enforces best practices and safety protocols.

### infrastructure

- `build-orchestrator` - Build system orchestrator managing CI/CD pipeline optimization, artifact creation, dependency management, and build automation across all environments.
- `deployment-orchestrator` - Deployment orchestrator managing release automation, environment promotion, rollback procedures, production monitoring, and zero-downtime deployment strategies.
- `helm-chart-specialist` - [DEPRECATED] Use infrastructure-developer with Helm skill instead. This agent now delegates to infrastructure-developer for all Helm operations with automatic skill loading.
- `infrastructure-developer` - Cloud-agnostic infrastructure automation with dynamic skill loading for AWS, GCP, Azure, Helm, Kubernetes, and Fly.io
- `infrastructure-orchestrator` - Infrastructure orchestrator managing environment provisioning, configuration management, monitoring setup, scalability planning, and cloud resource optimization
- `infrastructure-specialist` - Hands-on infrastructure provisioning specialist for Terraform, CloudFormation, Kubernetes, Docker, and cloud resource configuration. Writes IaC, configures cloud resources, and implements infrastructure security at the tactical level.
- `postgresql-specialist` - PostgreSQL database administration, SQL optimization, and schema management specialist with deep PostgreSQL expertise and seamless integration with the Claude Code agent ecosystem

### product

- `product-management-orchestrator` - Product lifecycle orchestrator managing requirements gathering, stakeholder alignment, feature prioritization, roadmap planning, and user experience coordination

### quality

- `code-reviewer` - Read-only Definition-of-Done review gate with severity-classified, ledger-shaped findings and merge-blocking rules
- `deep-debugger` - Reproduces bugs with a failing test first, then drives a TDD fix through specialist agents and quality gates
- `test-runner` - Unit and integration test execution with intelligent failure triage and debugging

### reqnroll

- `reqnroll-binding-specialist` - Fill PRD-generated Reqnroll step bindings test-first against the system under test, without ever editing the generated step-matching attributes

## Agent Delegation Protocol

Delegate through the Task tool with an explicit agent type, e.g. `Task(subagent_type="backend-developer", prompt="...")`.

- Route cross-cutting or multi-domain work through an orchestrator (`ensemble-orchestrator`, `tech-lead-orchestrator`); route single-domain work straight to the specialist.
- Pass file paths and requirements explicitly: delegates do not inherit your conversation.
- One responsibility per delegation; independent tasks run in parallel.
- Delegates report results back to the delegator; unresolved issues escalate up to the orchestrator.
- Verify delegated claims (files changed, tests passed) before reporting done.
