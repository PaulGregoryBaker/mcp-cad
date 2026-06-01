# Implementation Plan: Advanced Sheet Metal Unfolding

**Branch**: `007-sheet-metal-unfolding` | **Date**: 2026-05-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-sheet-metal-unfolding/spec.md`

---

## Summary

Implement advanced sheet metal validation, automatic disconnect sewing, sharp-to-curved bend reconstruction, analytical K-factor flattening, and layer-separated DXF export in the C++ Geometry Engine and the TypeScript MCP Protocol layer. This replaces the existing bounding-box approximation with a precise topological flattening traversal and reconstructs realistic 3D refolded models with correct bend geometry.

---

## Technical Context

**Language/Version**: C++17 (for Geometry Engine addon), TypeScript 5.x / Node.js (for MCP protocol and Manufacturing Domain).

**Primary Dependencies**: OpenCASCADE (OCCT 7.8.1 via vcpkg), Node Addon API (`node-addon-api` ^8.7.0) for C++/JS bindings.

**Storage**: In-memory CAD shape registry (`shells_`, `unfolds_` in `GeometryServiceImpl`), backed by BREP/STEP file-based state serialization.

**Testing**: vitest (TypeScript unit, integration, and end-to-end tests), Google Test / Catch2 (native C++ geometry engine tests).

**Target Platform**: Local runtime (Windows, Node.js + native C++ addon compiled via MSVC/CMake).

**Project Type**: Desktop CAD Model Context Protocol (MCP) server exposing geometric tools.

**Performance Goals**: Complete thin-panel validation, gap healing, refold shape generation, flattening traversal, and DXF generation in $\leq 2.0\text{ seconds}$ for parts with up to 12 bends.

**Constraints**:
- Strict memory management of OCCT smart pointers (`Handle`) to prevent native heap leaks.
- Single-session in-memory geometry registry with transactional rollback integrity.
- JSON-structured error responses for all failures.

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

1. **Deterministic Geometry Intelligence**: **PASS**. All calculations (thickness checking, gap sewing, K-factor stretching, flat projections) are fully mathematical and reproducible. The AI harness only orchestrates; the MCP server computes.
2. **Bounded Context Separation**: **PASS**.
   - B-Rep geometry operations (OCCT) are isolated in the C++ `GeometryEngine` context.
   - Manufacturing data (material libraries, tooling specs) is owned by the TS `ManufacturingDomain` context.
   - The TS `tools.ts` coordinates communication via `ManufacturingConfig` parameters.
3. **Safety Filter Enforcement**: **PASS**. Bending limits and joint types are validated before execution.
4. **Rollback-First State Management**: **PASS**. All mutating operations (automatic sewing, sharp-to-curved filleting, and registration) produce and manage `rollback_token`s. Discarding a transaction fully restores the previous stable shape state.
5. **Kerf Compensation**: **PASS**. Configured kerf (0.1 mm - 0.2 mm) is managed by the C++ engine during joint synthesis.
6. **Structured Errors**: **PASS**. All failures throw a structured `GeometryError` translated into the standard JSON error schema (`code`, `message`, `recoverable`, `suggested_tool`).
7. **MVP Scope Discipline**: **PASS**. Planar-dominated sheet metal geometry, single-session state, and async export are strictly adhered to.

---

## Project Structure

The implementation spans both the C++ native addon and the TypeScript MCP server layers:

```text
specs/007-sheet-metal-unfolding/
├── spec.md              # Feature specification
├── plan.md              # This implementation plan
├── research.md          # Phase 0 research findings
├── data-model.md        # Phase 1 data entities and validation rules
├── quickstart.md        # Phase 1 verification and developer quickstart
└── checklists/
    └── requirements.md  # Specification quality checklist

cpp/
├── src/
│   ├── geometry/
│   │   ├── geometry_service.h      // Geometry service interface declaration
│   │   ├── geometry_service.cc     // Main OCCT-including translation unit
│   │   ├── unfold.hpp             // Unfolding data models
│   │   └── unfold.cc              // Documented design patterns
│   └── napi/
│       └── geometry_binding.cc     // Node-Addon-API JS-to-C++ bindings
└── tests/
    ├── geometry_test.cc            // C++ test suite for unfolding and healing
    └── nesting_test.cc             // C++ test suite for nested sheets

ts/
├── src/
│   ├── mcp/
│   │   ├── tools.ts                // MCP tool definitions & dispatch handlers
│   │   └── errors.ts               // Structured error translations
│   ├── geometry/
│   │   └── types.ts                // Geometry types and structural interfaces
│   └── index.ts                    // FastMCP server entrypoint
└── tests/
    ├── mcp.test.ts                 // TypeScript tool integration tests
    └── integration/
        ├── sys_jtbd_01_decompose.integration.test.ts
        └── sys_jtbd_03_unfold_score.integration.test.ts
```

**Structure Decision**:
The codebase is a single monorepo containing a native C++ Core (`cpp/`) and a TypeScript Node.js Wrapper (`ts/`). B-Rep geometry and topology algorithms are written in C++ for maximum OpenCASCADE compatibility and performance, while the tool schemas, manufacturing domain rules, and MCP protocol handling are written in TypeScript.

---

## Complexity Tracking

*No current violations of the Constitution exist. No complexity tracking justifications are required.*
