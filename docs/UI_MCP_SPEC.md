# UI Integration Specification for MCP-CAD

Status: Draft
Date: 2026-05-15
Scope: Frontend product UI consuming the existing MCP server contract

## 1. Purpose

Define the MCP contract and UI-facing behavior needed to build a production UI that drives the CAD workflow end-to-end.

This specification is UI-oriented and assumes the backend follows the current bounded-context design:
- Geometry Engine (C++ via NAPI)
- Manufacturing Domain (TypeScript)
- Feature Extractor (ACL)
- MCP Protocol Layer (TypeScript)

## 2. UX Goals

The UI must support three operator goals:
1. Load and validate a part.
2. Transform geometry into manufacturable outputs with visible checks.
3. Export production artifacts with async progress and recoverable errors.

## 3. Transport and Session Model

### 3.1 MVP Transport
- Primary: MCP over stdio (local tool host).
- Optional UI-host bridge: local service that proxies MCP calls over HTTP/WebSocket for browser clients.

### 3.2 Session Behavior
- Single active session per running MCP process (MVP rule).
- UI must treat all part IDs, panel IDs, unfold IDs, nest IDs, and rollback tokens as session-scoped.
- UI must reset local state when session/process restarts.

### 3.3 Session State in UI
UI state model should include:
- activePart: { solidId, isManifold }
- panels: ShellId[]
- unfolds: UnfoldId[]
- nest: { nestId, utilisationPct, sheetsRequired }
- exportJob: { jobId, status, progress }
- snapshots: RollbackToken[] (timeline)

## 4. Required MCP Resources (Read Models)

The UI must be able to render and refresh these resources:
- context://intent/environmental
- context://intent/assembly
- logistics://envelope/shipping
- logistics://envelope/coating
- manufacturing://tooling/press_brake
- manufacturing://material/inventory
- manufacturing://rules
- geometry://part/{id}/topology
- geometry://part/{id}/features
- geometry://part/{id}/nest

UI requirements:
- Resource fetches should be idempotent and safe to refresh.
- UI should cache immutable session snapshots for timeline/compare views.

## 5. Required MCP Tools (Write/Action Model)

The UI must support invoking all production tools:
1. clean_geometry
2. decompose_volume
3. synthesize_joints
4. generate_reliefs
5. apply_unfold
6. simulate_nesting
7. evaluate_manufacturability
8. validate_bend_sequence
9. export_production_pack
10. get_export_job_status
11. get_export_job_result
12. rollback

## 6. UI Workflow Contract

### 6.1 Primary Flow (MVP-Gated)
1. clean_geometry(file_path)
2. decompose_volume(solid_id, strategy)
3. synthesize_joints(panel_ids, joint_type, clearance_mm)
4. apply_unfold(panel_id, material_id[, k_factor])
5. simulate_nesting(unfold_ids, sheet_size)
6. export_production_pack(nest_id, include_bom, include_assembly)
7. poll get_export_job_status(job_id)
8. retrieve get_export_job_result(job_id)

### 6.2 Validation Side Flows
- evaluate_manufacturability(panel_id, material_id) at panel checkpoints.
- validate_bend_sequence(panel_id) before export.
- rollback(rollback_token) from timeline.

### 6.3 Post-MVP Evaluation Flow
- Braai STL stress scenario is post-MVP and non-gating.
- UI can expose this in an "Advanced/Stress" section, clearly labeled non-MVP.

## 7. Error and Recovery Contract

All errors must be handled as structured objects:
- code: string
- message: string
- recoverable: boolean
- suggested_tool?: string

UI requirements:
- Show user-friendly copy by error code mapping.
- For recoverable=true, surface next-action CTA (for example "Run clean_geometry").
- For recoverable=false, preserve raw diagnostics panel for support/debug.

Critical export errors to support explicitly:
- EXPORT_JOB_NOT_FOUND
- EXPORT_JOB_NOT_COMPLETE
- INTERNAL_ERROR (with details)

Safety errors to support explicitly:
- MD_SAFETY_VIOLATION (fire-rated and related policy blocks)

## 8. Async Export UX Requirements

For export_production_pack:
- UI must return immediately to a job tracking state after submit.
- Poll interval: 500 ms to 1500 ms with exponential backoff.
- Terminal states: succeeded, failed.
- On succeeded: enable download/view links for dxf, bom_csv, assembly_json, svg_preview.

## 9. Determinism and Reproducibility Requirements

UI-integrated acceptance must verify:
- Re-running identical input in same config returns stable manufacturability and bend-sequence outputs.
- Session reset clears stale references.
- Rollback restores prior geometry IDs and invalidates later derived views.

## 10. Performance and Timeouts

- Standard STEP UI flow target: under 30 seconds end-to-end.
- Post-MVP Tier-3 Braai STL flow timeout budget: 120 seconds.
- UI must display progressive stage feedback for operations exceeding 1 second.

## 11. Security and Safety Constraints

- No UI override for safety filter enforcement.
- Unsafe joint types must be blocked by backend and reflected in UI controls.
- UI must not hard-code material/tooling limits; it must read from manufacturing resources.

## 12. Minimum UI Feature Set (MVP)

1. File ingest + validation panel
2. Decomposition strategy selector
3. Joint synthesis configurator
4. Unfold + nesting view with utilization metric
5. Manufacturability diagnostics panel
6. Async export job monitor
7. Rollback timeline
8. Structured error inspector

## 13. Acceptance Criteria (UI + MCP Contract)

1. UI can execute the full STEP -> export flow without manual backend intervention.
2. UI correctly handles async export lifecycle (submit, poll, result).
3. UI displays and acts on structured recoverable errors.
4. UI enforces session scoping and clears invalid IDs after reset/rollback.
5. UI reads dynamic config constraints from MCP resources (no hard-coded limits).
6. UI handles safety-filter rejection with deterministic user messaging.

## 14. Implementation Notes for Frontend Team

Recommended architecture:
- UI app (React/Vue/Svelte)
- MCP client adapter service
- State machine for workflow stages
- Typed contracts generated from tool/resource schemas

Recommended state machine stages:
- idle -> cleaned -> decomposed -> jointed -> unfolded -> nested -> exporting -> exported
- any stage -> error
- any mutable stage -> rollback -> prior stage

## 15. Out of Scope (MVP)

- Multi-session collaboration
- Tenant-level configuration overlays
- OAuth/remote auth
- Full 3D bend collision simulation
- Braai STL as release gate
