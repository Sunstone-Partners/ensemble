# Phoenix Framework Skill

**Framework**: Elixir + Phoenix LiveView
**Target Agent**: `backend-developer` (generic agent)
**Lazy Loading**: Framework-specific expertise loaded on-demand
**Skill Size**: SKILL.md (~20KB quick reference) + REFERENCE.md (~50KB comprehensive guide)

---

## Overview

This skill provides comprehensive Phoenix and Elixir expertise for the `backend-developer` agent, enabling it to build production-ready web applications with Phoenix LiveView, Ecto, and OTP patterns.

### What This Skill Covers

- **Phoenix Framework**: Controllers, contexts, LiveView components, channels
- **Ecto**: Schemas, changesets, queries, migrations, multi-tenancy
- **OTP Patterns**: GenServers, Supervisors, Tasks, Agents
- **LiveView**: Real-time components, forms, JS hooks, testing
- **Authentication**: Phx.Gen.Auth patterns, Guardian JWT
- **Deployment**: Releases, clustering, observability, production optimization

---

## Architecture

```
skills/phoenix-framework/
├── README.md                    # This file - overview and usage
├── SKILL.md                     # Quick reference guide (~20KB)
├── REFERENCE.md                 # Comprehensive guide (~50KB)
├── PATTERNS-EXTRACTED.md        # Pattern extraction from elixir-phoenix-expert.yaml
├── VALIDATION.md                # Feature parity validation (≥95% target)
├── templates/
│   ├── controller.template.ex   # Phoenix controller template
│   ├── context.template.ex      # Context module template
│   ├── schema.template.ex       # Ecto schema template
│   ├── migration.template.exs   # Database migration template
│   ├── liveview.template.ex     # LiveView component template
│   ├── genserver.template.ex    # GenServer template
│   └── test.template.exs        # ExUnit test template
└── examples/
    ├── blog-post-crud.example.ex        # Complete CRUD with Ecto
    ├── real-time-chat.example.ex        # LiveView real-time features
    ├── background-jobs.example.ex       # Oban background jobs
    └── README.md                        # Examples documentation
```

---

## When to Use

The `backend-developer` agent **automatically loads this skill** when it detects Phoenix/Elixir patterns:

### Detection Signals

**Primary Signals** (confidence: 0.4 each):
- `mix.exs` file with `:phoenix` dependency
- `.ex` or `.exs` files with Phoenix imports (`use Phoenix.Controller`, `use Phoenix.LiveView`)
- `lib/*/application.ex` with Phoenix endpoint in supervision tree

**Secondary Signals** (confidence: 0.2 each):
- `config/config.exs` or `config/runtime.exs` with Phoenix configuration
- `.formatter.exs` with Phoenix formatter imports
- `priv/repo/migrations/*.exs` files (Ecto migrations)
- `assets/` directory with `package.json` (Phoenix assets)

**Minimum Confidence**: 0.8 (framework detected when signals sum to ≥0.8)

---

## Usage Patterns

### Typical Workflow

1. **Framework Detection**: Agent detects Phoenix via `mix.exs` + `.ex` files
2. **Skill Loading**: SKILL.md loaded for quick reference
3. **Implementation**: Agent uses patterns, templates, examples
4. **Deep Dive**: REFERENCE.md consulted for complex scenarios
5. **Validation**: Feature parity confirmed via VALIDATION.md

### Example Task

**User Request**: "Add a real-time comment system with LiveView"

**Agent Flow**:
1. Detects Phoenix LiveView context
2. Loads Phoenix skill (SKILL.md)
3. References LiveView patterns (real-time updates, forms, pubsub)
4. Uses `liveview.template.ex` for boilerplate
5. Consults `real-time-chat.example.ex` for reference
6. Implements with Phoenix best practices

---

## Skill Components

### SKILL.md (Quick Reference)

- **Size**: ~20KB (target: <100KB)
- **Purpose**: Fast lookup of common patterns
- **Contents**:
  - Phoenix Contexts & Controllers
  - Ecto Schemas & Queries
  - LiveView Components & Events
  - OTP GenServers & Supervisors
  - Authentication Patterns
  - Testing with ExUnit

### REFERENCE.md (Comprehensive Guide)

- **Size**: ~50KB (target: <500KB, max 1MB)
- **Purpose**: Deep-dive reference for complex scenarios
- **Contents**:
  - Complete Phoenix architecture guide
  - Advanced Ecto patterns (multi-tenancy, polymorphic associations)
  - LiveView deep dive (JS hooks, uploads, pagination)
  - OTP patterns (state machines, backpressure, distributed systems)
  - Production deployment (releases, clustering, observability)
  - Performance optimization (query optimization, caching, profiling)

### Templates (Code Generation)

7 production-ready templates with placeholder system:

- `{{ModuleName}}` - Module name (e.g., `Blog.Posts`)
- `{{module_name}}` - Snake case (e.g., `blog_posts`)
- `{{schema_name}}` - Schema name (e.g., `Post`)
- `{{table_name}}` - Table name (e.g., `posts`)
- `{{field_name}}` - Field name (e.g., `title`)

**Reduction**: 60-70% boilerplate reduction via template generation

### Examples (Real-World Code)

3 comprehensive examples demonstrating:
- Complete CRUD operations with Ecto
- Real-time LiveView features (chat, notifications)
- Background job processing with Oban

---

## Feature Parity

**Target**: ≥95% feature parity with `elixir-phoenix-expert.yaml` agent

**Coverage Areas**:
1. **Core Responsibilities** (8 areas) - Weight: 35%
2. **Mission Alignment** (Phoenix, LiveView, OTP) - Weight: 25%
3. **Integration Protocols** (handoffs, delegation) - Weight: 15%
4. **Code Examples** (templates + examples) - Weight: 15%
5. **Quality Standards** (testing, deployment) - Weight: 10%

**Validation**: See `VALIDATION.md` for detailed feature parity analysis

---

## Integration with Backend Developer

### Agent Loading Pattern

```yaml
# backend-developer.yaml (simplified)
mission: |
  Implement server-side logic across languages/stacks.

  Framework Detection:
  - Detect framework signals (package.json, imports, config)
  - Load framework skill when confidence ≥0.8
  - Use skill patterns, templates, examples

  Phoenix Detection:
  - mix.exs with :phoenix dependency
  - .ex files with Phoenix imports
  - Load skills/phoenix/SKILL.md
```

### Skill Benefits

- **Generic Agent**: `backend-developer` stays framework-agnostic
- **Modular Expertise**: Phoenix knowledge separated and maintainable
- **Lazy Loading**: Skills loaded only when needed
- **Reduced Bloat**: 63% reduction in agent definition size

---

## Testing Standards

### Coverage Targets

- **Unit Tests**: ≥80% (ExUnit for contexts, schemas, functions)
- **Integration Tests**: ≥70% (Controller, LiveView integration)
- **E2E Tests**: ≥60% (Wallaby browser tests for critical flows)
- **Overall Coverage**: ≥75% (measured via `mix test --cover`)

### Testing Patterns

- **ExUnit**: Standard Phoenix testing patterns
- **LiveView Testing**: `render_component/2`, `render_click/2`, `render_submit/2`
- **Wallaby**: Browser automation for E2E flows
- **Property Testing**: StreamData for edge cases

---

## Related Skills

- **PostgreSQL Skill**: Database optimization and schema design
- **Deployment Skill**: Elixir releases and production deployment
- **Testing Skill**: Advanced testing patterns and strategies

---

## Maintenance

### Skill Updates

- **Pattern Extraction**: From production Phoenix code reviews
- **Template Refinement**: Based on usage analytics
- **Example Updates**: As Phoenix and Elixir evolve
- **Validation**: Continuous feature parity tracking

### Version Compatibility

- **Phoenix**: 1.7+ (LiveView 0.20+)
- **Elixir**: 1.14+ (OTP 25+)
- **Ecto**: 3.10+

---

## References

- **Original Agent**: `agents/elixir-phoenix-expert.yaml`
- **TRD**: `docs/TRD/skills-based-framework-agents-trd.md` (TRD-031 to TRD-034)
- **Architecture**: Skills-based framework architecture (Sprint 3)

---

**Status**: 🚧 **In Progress** - Sprint 3 (TRD-031)

**Next Steps**:
1. ✅ TRD-031: Create directory structure
2. ⏳ TRD-032: Extract patterns from elixir-phoenix-expert.yaml
3. ⏳ TRD-033: Create SKILL.md and REFERENCE.md
4. ⏳ TRD-034: Create templates, examples, and validation
