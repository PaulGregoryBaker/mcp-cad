# Research: Service Decomposition Refactor

**Phase 0 Output** | Feature: specs/001-service-decomposition/spec.md

## Decision 1: C++ Class Splitting Strategy

**Decision**: Split `GeometryServiceImpl` across multiple `.cc` files, each implementing a cohesive subset of methods. All `.cc` files include the same `geometry_service.hpp` header.

**Rationale**: C++ allows a class's methods to be defined in any translation unit, as long as each TU includes the class declaration. No additional abstractions (PIMPL, sub-services, secondary base classes) are needed. This preserves the existing header-as-facade pattern that enforces Constitution Principle II and avoids touching the NAPI binding layer.

**Alternatives considered**:
- **Sub-service classes with delegation**: Would require changing the public interface and the header, touching the NAPI binding. Rejected — more disruption for no added value at this scale.
- **PIMPL with per-domain impl structs**: Adds indirection and complexity. Rejected per MVP scope discipline (Principle VII).
- **Free functions instead of methods**: Would require passing the full service state to every function. Rejected — state is large and tightly coupled.

## Decision 2: TypeScript Handler Co-location Strategy

**Decision**: Move handler functions into per-domain modules under `ts/src/mcp/handlers/`. Each module exports both its **tool definitions** (JSON schemas) and its **handler functions**, so schema and logic are co-located. A thin `registry.ts` assembles all definitions; a thin `dispatch.ts` assembles all case branches.

**Rationale**: The current split between the 1,300-line `getToolDefinitions()` block and the handler functions it describes is the primary driver of cognitive load. Co-location eliminates the need to scroll across thousands of lines to understand a single tool.

**Alternatives considered**:
- **Split definitions and handlers into separate directories**: Keeps the schema/logic gap; rejected.
- **Generate tool definitions from handler metadata**: Over-engineering for a refactor; rejected.
- **Keep `getToolDefinitions()` monolithic, just split handlers**: Doesn't solve the schema navigation problem; rejected.

## Decision 3: Shared State in TypeScript

**Decision**: Extract all shared mutable state into `ts/src/mcp/state.ts`. All handler modules import from `state.ts`. No handler module owns state directly.

**Rationale**: Currently, state (geometry binding mock, semantic store, graph, parts map) is declared at the top of `tools.ts` and referenced throughout. Extracting it to a dedicated module makes ownership explicit and avoids circular imports between handler modules.

## Decision 4: Tool Definition Groupings (C++ side)

**C++ method groups → files**:

| File | Methods |
|------|---------|
| `geometry_service_core.cc` | Constructor, clearState, clearSnapshots, restoreSnapshot, utility fns |
| `geometry_service_validation.cc` | checkManifold, healGeometryEx, simplifyBody, validateSheetMetal |
| `geometry_service_booleans.cc` | fuseBodies, cutBodies, intersectBodies |
| `geometry_service_transforms.cc` | translateBody, rotateBody, mirrorBody, scaleBody, alignToFace |
| `geometry_service_modelling.cc` | filletEdges, chamferEdges, offsetShape, deleteFace, sewFaces, closeGap |
| `geometry_service_shell.cc` | separateSolids, thickenSheet, reconstructCurvedBends, getPanelFrame |
| `geometry_service_export.cc` | exportDxf, buildSheetFromDxf, exportGlb |
| `geometry_service_measurement.cc` | computeBoundingBox, computeMassProperties, measureDistance, exploreTopology |
| `geometry_service_assembly.cc` | createAssemblyDocument, addAssemblyInstance, mateRigid, listAssemblyTree |
| `geometry_service_sheet_metal.cc` | splitBodyByBends, validateSheetMetal overlap pulled here |

## Decision 5: TypeScript Handler Groupings

| Module (`ts/src/mcp/handlers/`) | Tools |
|----------------------------------|-------|
| `body-ops.ts` | clean_geometry, bounding_box, mass_properties, measure_distance, explore_topology, translate_body, rotate_body, mirror_body, scale_body, align_to_face, fillet_edges, chamfer_edges, simplify_body, heal_geometry_ex, offset_shape, delete_face, sew_faces, center_and_align_body |
| `booleans.ts` | fuse_bodies, cut_bodies, intersect_bodies |
| `shape-ops.ts` | split_body_by_plane, merge_bodies_with_bend, close_gap, is_panel_valid, extend_face_to_target, offset_face, add_flange, rip_edge, compute_intersections, compute_gaps, trim_body_with_plane, check_boundary_compliance, split_body_by_bends, remove_protrusions |
| `manufacturing.ts` | decompose_volume, synthesize_joints, generate_reliefs, validate_sheet_metal, reconstruct_curved_bends, evaluate_manufacturability, validate_bend_sequence, simulate_nesting |
| `unfold-export.ts` | apply_unfold, export_production_pack, get_export_job_status, get_export_job_result |
| `assembly.ts` | create_assembly_document, add_assembly_instance, mate_rigid, list_assembly_tree, validate_assembly |
| `transactions.ts` | rollback, begin_transaction, commit_transaction, rollback_transaction, get_transaction_history |
| `semantic.ts` | declare_semantic_entity, bind_semantic_entity, resolve_geometry, semantic_lineage |
| `graph.ts` | create_part, set_active_part, list_parts, delete_part, bootstrap_graph, add_bend, solve_geometry, check_foldability, query_graph, reset_graph, update_node, remove_node, add_join, add_cut |
| `mapping.ts` | map_3d_to_2d, map_2d_to_3d |

## Decision 6: Build System

**C++**: Each new `.cc` file is added to the `target_sources(...)` call in `CMakeLists.txt`. No change to include paths.

**TypeScript**: Each handler module is a normal ESM module imported by `dispatch.ts` and `registry.ts`. No bundler configuration change needed — `ts/src/mcp/tools.ts` becomes a thin re-export barrel so all existing imports continue to work.

## Decision 7: Dead Code Identification

Dead code will be identified by:
1. TypeScript compiler `noUnusedLocals` / `noUnusedParameters` warnings
2. C++ compiler `-Wunused-function` warnings
3. Manual review of commented-out blocks and `// TODO` / `// LEGACY` markers
4. Cross-referencing test coverage with handler functions (any handler not exercised by a test AND not in the dispatch router is a candidate)

## Constitution Check

| Principle | Impact | Status |
|-----------|--------|--------|
| I. Deterministic Geometry | No logic change | ✅ PASS |
| II. Bounded Context Separation | Decomposition makes bounded contexts *more* explicit | ✅ STRENGTHENS |
| III. Safety Filter Enforcement | Safety filter logic untouched | ✅ PASS |
| IV. Rollback-First State | Rollback logic untouched | ✅ PASS |
| V. Kerf Compensation | Kerf logic untouched | ✅ PASS |
| VI. Structured Errors | Error model untouched | ✅ PASS |
| VII. MVP Scope Discipline | No new features — pure restructuring | ✅ PASS |
| VIII. Configuration Over Hard-Coding | No config changes | ✅ PASS |
| IX. Async Export Contract | Async export logic untouched | ✅ PASS |
| X. Graceful Failure | Error handling untouched | ✅ PASS |

All gates pass. No violations to justify.
