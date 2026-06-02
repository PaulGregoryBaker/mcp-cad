<!--
SYNC IMPACT REPORT:
- Version change: 1.2 -> 1.3
- Added sections: X. Graceful Failure Over Silent Fallbacks (NON-NEGOTIABLE)
- Removed sections: None
- Templates requiring updates:
  - plan.md: ✅ updated
  - spec.md: ✅ updated
  - tasks.md: ✅ updated
- Follow-up TODOs: None
-->

# MCP-CAD Constitution

## Core Principles

### I. Deterministic Geometry Intelligence (NON-NEGOTIABLE)
The MCP server is a **Deterministic Geometry Intelligence Layer** — it never guesses or approximates manufacturing outcomes. All geometric math (boolean operations, unfolding, nesting) and all manufacturing rule validation must produce consistent, reproducible results for the same inputs. The AI Harness handles reasoning and orchestration; the MCP handles computation. This boundary must never blur.

### II. Bounded Context Separation (NON-NEGOTIABLE)
The system comprises four bounded contexts: **Geometry Engine**, **Manufacturing Domain**, **Anti-Corruption Layer (Feature Extractor)**, and **MCP Protocol Layer**. Each context owns its ubiquitous language and must not leak primitives across boundaries. The Geometry Engine has no knowledge of manufacturing rules. The Manufacturing Domain has no knowledge of B-Rep primitives. The Feature Extractor is the only permitted translation point between them. Context interfaces are defined by `GeometryPort` and `ManufacturingPort` protocols.

### III. Safety Filter Enforcement (NON-NEGOTIABLE)
Safety constraints are non-bypassable. If `context://intent/environmental` declares a `fire_rated` context, the `synthesize_joints` tool **must** reject `adhesive` and plastic fastener joint types before any geometry operation is attempted. Safety checks are enforced at the MCP Protocol Layer before delegating to any sub-context. No override mechanism may be exposed to the AI Harness.

### IV. Rollback-First State Management
Every tool that mutates geometry state **must** produce a `rollback_token` before executing. The Geometry Engine maintains a snapshot registry of operation receipts. The MCP Protocol Layer validates tokens and orchestrates restoration. Tools that fail mid-execution must not leave the geometry registry in a partially mutated state — operations are atomic from the registry's perspective.

### V. Kerf Compensation is Mandatory
All slot and tab geometry produced by `synthesize_joints` must include a kerf offset of **0.1 mm–0.2 mm** (laser/waterjet respectively, sourced from `manufacturing://rules`). No joint geometry may be written to a shell without kerf compensation applied. This rule is enforced in the Geometry Engine Service layer, not by the AI Harness.

### VI. Structured Errors Always
All tool errors return a structured JSON error object with `code`, `message`, `recoverable`, and `suggested_tool` fields. Unstructured exceptions must never surface to the AI Harness. The MCP Protocol Layer wraps all sub-context exceptions into the defined error model before returning. See `Engineering-Design.md §3.4` for the error code registry.

### VII. MVP Scope Discipline
The MVP target is: **STEP input → volume decomposition (2–5 panels) → Tab-and-Slot joinery → Nested DXF export**. Features outside this scope (cloud geometry APIs, OAuth2, multi-session concurrency, full 3D bend-sequence collision simulation) must not be introduced until the MVP integration test (`INF-03`) passes end-to-end. Complexity must be deferred, not pre-built. Bend sequence validation is rule-based for MVP.

MVP session behavior is single-session only. Multi-session concurrency is explicitly deferred.

### VIII. Configuration Over Hard-Coding
Material inventory, tooling specifications, logistics constraints, and environmental context must be managed through MCP configuration tools/resources for MVP (see `INF-02`). No manufacturing parameters (gauge, K-factor, V-die widths, envelope dimensions) may be hard-coded in application logic. Tenant-specific overlays are deferred to cloud deployment phases.

### IX. Async Export Contract (NON-NEGOTIABLE)
`export_production_pack` is asynchronous for MVP. The MCP Protocol Layer must return `job_id`, `status`, and `accepted_at` immediately, and must expose `get_export_job_status` and `get_export_job_result` as the only supported completion flow. Synchronous long-running export calls are not permitted.

### X. Graceful Failure Over Silent Fallbacks (NON-NEGOTIABLE)
The system MUST NOT silently apply fallback data or default values when an authoritative operation fails or returns incomplete results. Incomplete, corrupt, or missing outputs (such as a CAD operation failing to return a 3D visual mesh URL) MUST be treated as structural errors. The system MUST catch these errors gracefully, prevent corrupt state propagation, log a structured bug report, and notify the user with a descriptive typed error card.

**Rationale**: Silent fallbacks (e.g., generating mock or guess data on the frontend when backend geometry operations fail) mask underlying system bugs, make diagnosing problems impossible, and risk putting inconsistent visual data in front of the user, compromising safety and auditability in production manufacturing.

## Technology Stack & Architectural Decisions

**Resolved for MVP (from Engineering-Design.md §1):**

| Decision | Resolution |
|---|---|
| Geometry stack | Local OCC/CadQuery only (D1-A) |
| Nesting library | libnest2d with native C++ implementation and thin integration layer (D2-A) |
| State persistence (geometry) | In-memory + file-backed BREP, session-scoped (D3-A) |
| State persistence (semantic) | In-memory + Dolt-persisted, session-spanning (D3-B, Semantic CAD Phase 1 only) — see [amendments/v1.2-semantic-persistence.md](amendments/v1.2-semantic-persistence.md) |
| Auth model | No auth — local deployment only (D4-A) |
| MCP transport | stdio (Claude Desktop compatible) (D5-A) |

**Runtime environment:** `python:3.11-slim` Docker image; OCC (OpenCASCADE) + CadQuery + FastMCP or mcp-python-sdk.

**MVP implementation posture:** CadQuery unfold is sufficient for MVP; single-session state model; async export jobs with polling/result retrieval.

**Language allocation by bounded context (MVP):**
- Geometry Engine: C++ (primary) or Rust (alternative — equivalent performance, stronger memory safety)
- Anti-Corruption Layer (Feature Extractor): C++ (primary) or Rust (alternative — borrow checker well-suited to topology traversal)
- Manufacturing Domain: TypeScript
- MCP Protocol Layer: TypeScript

## Development Workflow & Quality Gates

**Build order is enforced** — phases A → B → C → D as defined in `Engineering-Design.md §5`. No Phase B work begins until Phase A stories pass their unit tests.

**Testing requirements:**
- All Manufacturing Domain rules (Epic 2) require unit tests — they are pure functions with no OCC dependency and must achieve full coverage.
- Feature Extractor (Epic 3) require unit tests using fixture geometry with known topology.
- The golden-path integration test (`INF-03`: STEP → clean → decompose → tab-slot → unfold → nest → DXF) is the MVP acceptance gate.
- OCC/CadQuery operations are tested via integration tests against real STEP fixtures, not mocked.

**Highest geometric risk:** `apply_unfold` (GE-09) — OCC's native unfolding may be insufficient for complex panels. Spike this story first in Phase C before committing to the implementation approach.

## Governance

This constitution supersedes all other practices, guidelines, and conventions in this repository. Any amendment requires: (1) documenting the rationale, (2) updating affected interface contracts in `Engineering-Design.md`, and (3) a migration plan for in-flight work.

All implementation decisions must be verified against Principles I-X before a story is marked complete. Complexity that cannot be justified against the MVP scope must be deferred. Use `Engineering-Design.md` as the authoritative reference for interface contracts, tool schemas, and the work breakdown structure.

**Version**: 1.3 | **Ratified**: 2026-05-13 | **Last Amended**: 2026-06-01

## Amendment History

| Version | Date       | Summary                                                                                   |
|---------|------------|-------------------------------------------------------------------------------------------|
| 1.0     | 2026-05-13 | Initial ratification.                                                                     |
| 1.1     | 2026-05-13 | (See git history.)                                                                        |
| 1.2     | 2026-05-21 | Added `D3-B` (Dolt-persisted semantic graph) for Semantic CAD Phase 1. `D3-A` remains in force for geometry. See [amendments/v1.2-semantic-persistence.md](amendments/v1.2-semantic-persistence.md). |
| 1.3     | 2026-06-01 | Added Principle X: Graceful Failure Over Silent Fallbacks to prevent mask bugs and corrupt states. |
