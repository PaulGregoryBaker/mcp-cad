# Implementation Plan: Splits by Bends and Viewport Alignment Enhancements (008)

**Branch**: `008-improve-splits-by-bends` | **Date**: 2026-06-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-improve-splits-by-bends/spec.md`

---

## Summary

Implement flat panel trapezoidal face merging in B-Rep decomposition, introduce explicit on-demand viewport re-orientation and centering, utilize dynamic fuzzy sewing in complex body merging, and deploy a high-speed mesh edge-traversal protrusion cycle removal algorithm. Additionally, return full transactional shape histories from splits to support Dolt branch and PR semantic diffing.

---

## Technical Context

**Language/Version**: C++17 (Geometry Engine core addon), TypeScript 5.x / Node.js (MCP Protocol and Manufacturing Domain layers).

**Primary Dependencies**: OpenCASCADE (OCCT 7.8.1 via vcpkg), Node Addon API (`node-addon-api` ^8.7.0).

**Storage**: Session-scoped CAD shape registry (`shells_`, `unfolds_` in-memory), backed by Dolt-persisted session-spanning semantic mapping catalog.

**Testing**: `vitest` (TypeScript integration and mock testing), Google Test / Catch2 (native C++ geometry tests).

**Target Platform**: Local runtime (Windows, Node.js + native C++ addon compiled via MSVC/CMake).

**Project Type**: Desktop CAD Model Context Protocol (MCP) server.

**Performance Goals**: Complete trapezoidal face merging, on-demand auto-alignment, complex body merging, and protrusion cycle removal in $\leq 1.0\text{ second}$ for parts with up to 100 faces. Protrusion edge-loop traversal MUST achieve a $\ge 30\%$ speedup over standard volumetric difference cuts.

**Constraints**:
- Strict memory management of OCCT smart pointers (`Handle`) to prevent native heap leaks.
- Single-session in-memory geometry registry with transactional rollback integrity.
- Precise preservation of flat host panel geometry during protrusion slices.

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

1. **Deterministic Geometry Intelligence**: **PASS**. All calculations (unification angle, centroid translations, fuzzy sewing, and edge loop traversals) are strictly mathematical and reproducible. The AI handles orchestration; the C++ server computes.
2. **Bounded Context Separation**: **PASS**. B-Rep operations and mesh traversals are fully isolated in the C++ `GeometryEngine` context. The TS `MappingLayer` coordinates Dolt-based semantic remapping using the generated shape history.
3. **Safety Filter Enforcement**: **PASS**. Viewport re-orientation and protrusion algorithms are checked at the MCP Protocol Layer, ensuring no illegal mutations bypass the transaction lifecycle.
4. **Rollback-First State Management**: **PASS**. All mutating operations (alignment, splits, merges, and protrusion slices) produce and manage `rollback_token`s. Discarding a transaction fully restores the previous stable shape state.
5. **Kerf Compensation**: **PASS**. The new trapezoidal panels preserve correct flat geometry boundaries.
6. **Structured Errors**: **PASS**. All failures throw a structured `GeometryError` translated into standard JSON error schemas (`code`, `message`, `recoverable`, `suggested_tool`).
7. **MVP Scope Discipline**: **PASS**. Work focuses on planar-dominated parts (`cauldron.step`) and direct local performance enhancements. Advanced 3D bend simulations remain deferred.

---

## Project Structure

### Documentation (this feature)

```text
specs/008-improve-splits-by-bends/
├── spec.md              # Feature specification
├── plan.md              # This implementation plan
├── research.md          # Phase 0 research findings
├── data-model.md        # Phase 1 data entities and validation rules
├── quickstart.md        # Phase 1 verification and developer quickstart
├── contracts/
│   └── mcp-tool-schemas.md # Phase 1 MCP tool schemas
└── checklists/
    └── requirements.md  # Specification quality checklist
```

### Source Code

```text
cpp/
├── src/
│   ├── geometry/
│   │   ├── geometry_service.h      // Geometry service interface declaration (Add centerAndAlignBody, update signatures)
│   │   ├── geometry_service.cc     // Main OCCT translation unit (Add facet unification, centering, loops, sewing)
│   │   ├── unfold.hpp             
│   │   └── unfold.cc              
│   └── napi/
│       └── geometry_binding.cc     // Expose centerAndAlignBody, map new parameters
└── tests/
    └── geometry_test.cc            // Add C++ tests for cauldron facets, loop cycle traversals

ts/
├── src/
│   ├── mcp/
│   │   ├── tools.ts                // Register center_and_align_body, dispatch handlers
│   │   └── errors.ts               // Add GE_ALIGN_FAILED, GE_PROTRUSION_LOOP_FAILED
│   ├── geometry/
│   │   ├── types.ts                // Expose AlignmentResult, update SplitBodyByBendsResult
│   │   └── binding.ts              // Loader loaders and wrappers
│   └── index.ts                    // FastMCP server entrypoint
└── tests/
    └── integration/
        └── split_by_bends.integration.test.ts // Cauldron facet merging and loop cycles tests
```

**Structure Decision**:
The codebase maintains a single monorepo containing a native C++ Core (`cpp/`) and a TypeScript Node.js Wrapper (`ts/`). B-Rep geometry and topology algorithms are written in C++ for maximum OpenCASCADE compatibility and performance, while the tool schemas, manufacturing domain rules, and MCP protocol handling are written in TypeScript.

---

## Complexity Tracking

*No current violations of the Constitution exist. No complexity tracking justifications are required.*
