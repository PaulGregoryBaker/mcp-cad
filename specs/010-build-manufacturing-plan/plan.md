# Implementation Plan: Build Manufacturing Plan Tool

**Branch**: `010-build-manufacturing-plan` | **Date**: 2026-06-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/010-build-manufacturing-plan/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

We will introduce a new MCP tool `build_manufacturing_plan` that automates the reconstruction of imported CAD models.
1. **Split-by-Bends Extension**: We will extend the C++ `splitBodyByBends` operation to return the adjacent pairs of parts (`split_pairs`) that were separated at each bend seam.
2. **Reconstruction & Prioritization**: In the TypeScript orchestrator, we will analyze `split_pairs`, isolate non-panel protrusions as separate unmerged auxiliary bodies, and prioritize/rate the panel merges (e.g. prioritizing standard 90° bends over complex joints).
3. **Validation**: The orchestrator performs trial merges on the prioritized list using `mergeBodiesWithBend`, validating each merge using DRC and foldability checkers, and keeping impossible joints unmerged.

---

## Technical Context

**Language/Version**: C++ (C++17) for geometry operations, TypeScript (Node.js >= 22.0.0) for the MCP Protocol and Manufacturing Domain logic.

**Primary Dependencies**: OpenCASCADE (OCCT 7.8.1) for geometry calculations, Node NAPI (`node-addon-api`) for native C++ bindings.

**Storage**: Dolt-persisted semantic graph for revision history (Semantic CAD Phase 1), in-memory session registry for active geometries.

**Testing**: Vitest for TypeScript integration and E2E contract verification.

**Target Platform**: Local environment (Windows, MSVC/CMake), Claude Desktop compatibility (stdio transport).

**Project Type**: Library/MCP Service.

**Performance Goals**: Reconstruction of parts with up to 10 panels completes in `< 10.0 seconds`.

**Constraints**:
- Must support transaction-aware rollbacks via `transaction_id`.
- Non-panel components must be kept as separate bodies and registered as unmerged auxiliary parts.
- Impossible joints (DRC / Foldability violations) must be left unmerged.

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

1. **Principle I: Deterministic Geometry Intelligence (NON-NEGOTIABLE)**: Pass. All geometric calculations (splitting, checking panel validity, merging) are performed deterministically in the C++ Geometry Engine layer.
2. **Principle II: Bounded Context Separation (NON-NEGOTIABLE)**: Pass. The C++ Geometry Engine operates on BREP shapes and topology, while the TypeScript Manufacturing Domain handles graph nodes, DRC, and foldability checks.
3. **Principle IV: Rollback-First State Management**: Pass. `build_manufacturing_plan` will accept a `transaction_id` and run under a transaction, allowing any intermediate geometry modifications to be fully rolled back if a failure occurs or if requested by the user.
4. **Principle VI: Structured Errors Always**: Pass. All errors (e.g. invalid STEP file, split failure) are returned as structured JSON error objects.
5. **Principle X: Graceful Failure Over Silent Fallbacks (NON-NEGOTIABLE)**: Pass. If geometry operations fail during the reconstruction phase, structured typed errors are returned to the caller rather than silent fallbacks.

---

## Project Structure

### Documentation (this feature)

```text
specs/010-build-manufacturing-plan/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── build_manufacturing_plan.contract.json # Phase 1 output
└── checklists/
    └── requirements.md  # Specification Quality Checklist
```

### Source Code (repository root)

```text
cpp/
├── src/
│   ├── geometry/
│   │   ├── geometry_service.hpp # Update DecomposedByBendsResult to include splitPairs
│   │   └── geometry_service.cc  # Populate splitPairs inside splitBodyByBends
│   └── napi/
│       └── geometry_binding.cc  # Export split_pairs to NAPI
│
ts/
├── src/
│   ├── geometry/
│   │   └── binding.ts           # Expose split_pairs in TypeScript bindings
│   ├── mcp/
│   │   └── tools.ts             # Register build_manufacturing_plan tool
│   └── manufacturing/
│       └── reconstruction/      # New directory for reconstruction orchestrator
│           ├── orchestrator.ts  # Main logic for build_manufacturing_plan
│           └── types.ts         # Types for reconstruction report
```

**Structure Decision**: We will add the reconstruction orchestrator logic to `ts/src/manufacturing/reconstruction/` as a modular extension of the Manufacturing Domain context. The new tool will be registered in `ts/src/mcp/tools.ts` and forward calls to this orchestrator.

---

## Proposed Changes

We will introduce the split pair tracking and the reconstruction orchestrator.

### C++ Geometry Engine

#### [MODIFY] [geometry_service.hpp](file:///c:/Projects/atg/mcp-cad/cpp/src/geometry/geometry_service.hpp)
- Add `std::vector<std::pair<std::string, std::string>> splitPairs;` to `DecomposedByBendsResult`.

#### [MODIFY] [geometry_service.cc](file:///c:/Projects/atg/mcp-cad/cpp/src/geometry/geometry_service.cc)
- Update `splitBodyByBends` to populate `splitPairs`:
  - Identify adjacent panels that share a boundary/seam.
  - Push the generated UUID pair to `splitPairs` for each detected bend junction.

#### [MODIFY] [geometry_binding.cc](file:///c:/Projects/atg/mcp-cad/cpp/src/napi/geometry_binding.cc)
- Update `SplitBodyByBends` NAPI wrapper:
  - Convert `splitPairs` into a JS array of string arrays `split_pairs` (`Array<[string, string]>`) and attach to the returned object.

### TypeScript MCP Server

#### [MODIFY] [binding.ts](file:///c:/Projects/atg/mcp-cad/ts/src/geometry/binding.ts)
- Update `splitBodyByBends` return signature to include `split_pairs: Array<[string, string]>`.

#### [MODIFY] [tools.ts](file:///c:/Projects/atg/mcp-cad/ts/src/mcp/tools.ts)
- Expose the `build_manufacturing_plan` tool schema and map it to `reconstructManufacturingPlan()`.

#### [NEW] [orchestrator.ts](file:///c:/Projects/atg/mcp-cad/ts/src/manufacturing/reconstruction/orchestrator.ts)
- Implement `reconstructManufacturingPlan()`:
  - Begins transaction context.
  - Calls `splitBodyByBends` on the target body.
  - Registers protrusions as unmerged auxiliary parts.
  - Builds the adjacency list from `split_pairs`.
  - **Rating & Prioritization Pass**: Sorts and ranks the candidate merges.
    - Priority 1: Simple 90-degree cylindrical bends.
    - Priority 2: Other standard bends.
    - Priority 3: Complex or tight-clearance bends.
  - Iterates through candidate merges in priority order:
    - Performs trial `mergeBodiesWithBend`.
    - Invokes `DrcChecker` and `FoldabilityChecker` on the candidate graph.
    - If violations occur (e.g. self-collision, impossible bend sequence), rolls back the merge for that joint and logs a `SkippedJoint` record.
    - Otherwise, preserves the merge and updates the graph.
  - Returns the final `ReconstructionReport`.

#### [NEW] [types.ts](file:///c:/Projects/atg/mcp-cad/ts/src/manufacturing/reconstruction/types.ts)
- Define TypeScript interfaces for the report, unmerged parts, and skipped joints.

---

## Complexity Tracking

*No constitution check violations.*
