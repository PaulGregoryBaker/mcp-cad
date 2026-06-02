# Implementation Plan: Assembly Validation and Autofix Recommendations

**Branch**: `009-validate-all` | **Date**: 2026-06-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/009-validate-all/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

We will extend the MCP server to support assembly-wide verification via a new `validate_assembly` tool.
* **Sheet Metal Validation**: Runs unfolding checks on candidate sheet metal parts (defaulting to all parts unless explicitly flagged as non-sheet-metal via metadata/parameters).
* **Clash Detection**: Implements a high-performance two-stage collision detector. First, it filters parts by graph adjacency and Axis-Aligned Bounding Box (AABB) overlap. Second, it executes exact OpenCASCADE B-Rep intersection tests (`BRepAlgoAPI_Common`) only on the filtered candidates, avoiding expensive $O(N^2)$ solid-solid calculations.
* **Autofix recommendations**: Generates structured tool name and argument recommendations (e.g. `split_body_by_bends` or `trim_body_with_plane`) for validation failures.
* **Registry Architecture**: Design a modular registry for validation rules in the TypeScript layer, allowing easy future extensions (Semantic graph rules, Manufacturing limits, Nesting checks).

---

## Technical Context

**Language/Version**: C++ (C++17) for OpenCASCADE geometry operations, TypeScript (Node.js >= 22.0.0) for the MCP Protocol and validation rules.

**Primary Dependencies**: OpenCASCADE (OCCT 7.8.1) for AABB/B-Rep intersection math, Node NAPI (`node-addon-api`) for native C++ bindings.

**Storage**: In-memory session registry for active geometries (solids/shells).

**Testing**: Catch2 (v3) for C++ unit tests, Vitest for TypeScript integration and E2E contract verification.

**Target Platform**: Local environment (Windows, MSVC/CMake), Claude Desktop compatibility (stdio transport).

**Project Type**: Library/MCP Service.

**Performance Goals**: Validation of assemblies up to 500 parts in `< 2.0 seconds`.

**Constraints**: Clash checks must be limited to adjacent and overlapping AABB candidates.

**Scale/Scope**: Assembly-wide verification of overlaps and flat-pattern unfolding, supporting dynamic rule extensions.

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

1. **Principle I: Deterministic Geometry Intelligence (NON-NEGOTIABLE)**: Pass. All clash detection and unfolding validation math is performed deterministically in the C++ Geometry Engine layer.
2. **Principle II: Bounded Context Separation (NON-NEGOTIABLE)**: Pass. The C++ Geometry Engine computes bounding boxes and intersection solids; it does not know about manufacturing rules. The TypeScript Manufacturing Domain registers the validation rules and resolves the appropriate Autofix payload.
3. **Principle IV: Rollback-First State Management**: Pass. `validate_assembly` is a read-only query tool; it does not mutate geometry state and does not create rollback tokens itself.
4. **Principle VI: Structured Errors Always**: Pass. All errors and warnings are returned as a structured array of JSON error objects.
5. **Principle X: Graceful Failure Over Silent Fallbacks (NON-NEGOTIABLE)**: Pass. Any failed geometry computations or exceptions during unfolding/intersection testing throw structured typed error codes (`GE_CLASH_FAILED`, etc.) rather than silently returning empty or mock results.

---

## Project Structure

### Documentation (this feature)

```text
specs/009-validate-all/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── validate_assembly.contract.json # Phase 1 output
└── checklists/
    └── requirements.md  # Specification Quality Checklist
```

### Source Code (repository root)

```text
cpp/
├── src/
│   ├── geometry/
│   │   ├── geometry_service.cc  # Add checkAssemblyClashes implementation
│   │   └── geometry_service.hpp # Add ClashPair struct and method declarations
│   └── napi/
│       └── geometry_binding.cc  # Wrap checkAssemblyClashes for JS/TS
│
ts/
├── src/
│   ├── geometry/
│   │   ├── binding.ts           # Expose checkAssemblyClashes bindings
│   │   └── types.ts             # Define validation report/error types
│   ├── mcp/
│   │   └── tools.ts             # Expose validate_assembly tool and registry logic
│   └── validation/              # New directory for validation rules
│       ├── validator.ts         # ValidationEngine core registry
│       ├── rules/
│       │   ├── unfold.ts        # Unfolding rule implementation
│       │   └── clash.ts         # Clash/Overlap rule implementation
│       └── types.ts             # TypeScript interfaces for rules
```

**Structure Decision**: Unified single project layout utilizing existing `cpp/` and `ts/` paths. Validation rules will reside in a dedicated `ts/src/validation/` directory to ensure modularity and extensibility.

---

## Complexity Tracking

*No constitution check violations.*

---

## Proposed Changes

We will introduce the validation rules and the new `validate_assembly` tool.

### C++ Geometry Engine

#### [MODIFY] [geometry_service.hpp](file:///c:/Projects/atg/mcp-cad/cpp/src/geometry/geometry_service.hpp)
- Add `ClashPair` and `BBox3D` data structures.
- Add declaration for `checkAssemblyClashes`.

#### [MODIFY] [geometry_service.cc](file:///c:/Projects/atg/mcp-cad/cpp/src/geometry/geometry_service.cc)
- Implement `checkAssemblyClashes`:
  - Iterates through the list of adjacent part pairs.
  - Computes `Bnd_Box` for each candidate part.
  - Performs fast AABB overlap checks using `Bnd_Box::IsOut()`.
  - Performs exact topological intersection check `BRepAlgoAPI_Common` only if AABBs overlap.
  - Collects colliding parts and returns the overlap volumes.

#### [MODIFY] [geometry_binding.cc](file:///c:/Projects/atg/mcp-cad/cpp/src/napi/geometry_binding.cc)
- Bind the `checkAssemblyClashes` method to JS NAPI interface.

---

### TypeScript MCP Server

#### [MODIFY] [binding.ts](file:///c:/Projects/atg/mcp-cad/ts/src/geometry/binding.ts)
- Add JS binding type signatures for `checkAssemblyClashes`.

#### [MODIFY] [types.ts](file:///c:/Projects/atg/mcp-cad/ts/src/geometry/types.ts)
- Expose the types `ValidationError`, `ValidationReport`, `AutofixRecommendation`, and rule interfaces.

#### [NEW] [validator.ts](file:///c:/Projects/atg/mcp-cad/ts/src/validation/validator.ts)
- Implement `ValidationEngine` containing a registry of rules.
- Gathers database metadata, assembly adjacency graph, and active parts.
- Executes registered rules in parallel and aggregates the reports.

#### [NEW] [unfold.ts](file:///c:/Projects/atg/mcp-cad/ts/src/validation/rules/unfold.ts)
- Implements the sheet-metal unfolding validation rule.
- Default behavior: assumes all parts are sheet metal unless flagged as non-sheet-metal in parameters/metadata.
- Returns `split_body_by_bends` autofix suggestions for flat pattern failures.

#### [NEW] [clash.ts](file:///c:/Projects/atg/mcp-cad/ts/src/validation/rules/clash.ts)
- Implements the clash detection validation rule.
- Invokes native `checkAssemblyClashes` binding using the list of adjacent parts.
- Returns `trim_body_with_plane` autofix suggestions for clashes.

#### [MODIFY] [tools.ts](file:///c:/Projects/atg/mcp-cad/ts/src/mcp/tools.ts)
- Expose the `validate_assembly` tool schema and route handling to `ValidationEngine.validate()`.

---

## Verification Plan

### Automated Tests
- **C++ Unit Tests**: Add test cases to `cpp/tests/geometry_test.cc` that verify AABB overlapping logic and `checkAssemblyClashes` with intersecting shapes.
- **Vitest Integration Tests**: Add `ts/tests/integration/validate_assembly.integration.test.ts` to check:
  - Valid assemblies returning success.
  - Clash detection filtering only adjacent parts.
  - Sheet metal unfolding checks and recommended autofix payloads.

### Manual Verification
- Deploy the MCP server locally and call the `validate_assembly` tool on the multi-part `cauldron.step` fixture to verify that validation status is reported in under 1 second.
