---
description: "Actionable task list for Apply Architecture and Engineering Designs to Specification"
---

# Tasks: Apply Architecture and Engineering Designs to Specification

**Input**: Design documents from `specs/001-align-specification/`

**Prerequisites**: plan.md (required), spec.md, Engineering-Design.md, Architecture.md

**Organization**: Tasks grouped by implementation phase (Phase 0, Phase 1, Phases A-D, and Phase Z) to enable sequential gate validation and parallel work within phases.

**Total Tasks**: 165 | **Duration**: 8-10 weeks (7 phases: 0, 1, A-D, Z) | **Branch**: `001-speckit-git-feature`

---

## Phase 0: Research & Validation

**Objective**: Resolve OCCT stability, libnest2d integration, NAPI build toolchain, and async export contract unknowns.

- [x] T001 Research OCCT v7.8.1 API stability & release notes; document findings in docs/OCCT_STABILITY.md with sections: APIs confirmed, brittle operations, fixture outcomes, benchmark timings, remaining unknowns
- [x] T002 [P] Spike libnest2d integration pattern; test polygon extraction from DXF geometry; document outcomes in specs/001-align-specification/research.md§libnest2d (include: header-only linkage validation result, polygon extraction prototype result, and performance estimate for a 10-part layout)
- [x] T003 [P] Validate cmake-js NAPI build toolchain on Ubuntu 22.04 and macOS; document pass/fail matrix, reproducible build steps, and known issues in docs/DEVELOPMENT.md
- [x] T004 [P] Test CadQuery sheet metal unfold and custom OCC fallback on 5 varied designs; select MVP default with rationale and accuracy tolerance results in specs/001-align-specification/research.md
- [x] T005 [P] Design in-process Promise job queue interface for future BullMQ migration; load test with 20 concurrent jobs and record queue correctness metrics (status transitions, completion latency)
- [x] T006 Create Phase 0 research summary in specs/001-align-specification/research.md including decisions, rejected alternatives, and explicit "No remaining blockers" statement

**Gate Criteria**:
- All unknowns resolved with explicit decision records in specs/001-align-specification/research.md
- CadQuery vs custom OCC unfolding approach selected with benchmark-backed rationale
- NAPI toolchain validated on at least Ubuntu 22.04 and one non-Linux platform
- No Phase 1 blockers remain

---

## Phase 1: Design & Project Setup

**Objective**: Establish project structure, design contracts, and configuration templates.

### Setup & Configuration

- [x] T007 Create project directory structure per plan.md (cpp/, ts/, docs/, docker/)
- [x] T008 [P] Initialize C++ project: CMakeLists.txt root, vcpkg.json manifest (OCCT 7.8.1, libnest2d pinned)
- [x] T009 [P] Initialize TypeScript project: package.json, tsconfig.json, .npmrc (Node 22.x)
- [x] T010 [P] Create Docker multi-stage Dockerfile (OCCT builder stage, app stage); verify layer caching
- [x] T011 [P] Create .github/workflows/ directory skeleton with placeholder CI/CD triggers (Docker build, lint, test stubs); *directory scaffold only — superseded by T138 which configures the full four-job model; T161 adds the release evidence job*
- [x] T012 Configure ESLint and Prettier for TypeScript; add pre-commit hooks

### Design Artifacts

- [x] T013 Generate specs/001-align-specification/data-model.md with entity definitions (SolidId, ShellId, UnfoldId, NestId, Snapshot, ManufacturingConfig)
- [x] T014 [P] Generate specs/001-align-specification/contracts/geometry-port.md (NAPI boundary interface with FFI signatures)
- [x] T015 [P] Generate specs/001-align-specification/contracts/manufacturing-port.md (rules, validation, scoring interface)
- [x] T016 [P] Generate specs/001-align-specification/contracts/mcp-tools.md (reference to Engineering-Design §3.3 tool schemas)
- [x] T017 Generate specs/001-align-specification/quickstart.md (local dev setup: Docker build, NAPI addon, config.yaml)
- [x] T018 Create docs/OCCT_API_USAGE.md (document which OCCT APIs we use; audit surface for stability)
- [x] T019 Create docs/DEVELOPMENT.md (debugging, building, testing locally; cmake-js troubleshooting)
- [x] T020 Create docs/MVP_SCOPE.md (explicit deferred capabilities: cloud APIs, multi-session, 3D collision, tenant overlays)
- [x] T133 Validate specs/001-align-specification/checklists/requirements.md is fully passing and record sign-off before implementation starts

### Test Infrastructure Scaffolding

*Aligns with docs/TESTING_STRATEGY.md — create test directories and tooling before any test files are written.*

- [x] T134 [P] Create test directory structure per TESTING_STRATEGY.md: cpp/tests/napi_contract/, ts/tests/contracts/, ts/tests/integration/, ts/tests/e2e/, docs/test-reports/
- [x] T135 [P] Configure Vitest for TypeScript: add vitest.config.ts with coverage provider (v8), reporters (verbose, junit), and test path mappings for unit, contract, integration, e2e suites
- [x] T136 [P] Configure Catch2 for C++: integrate with CMakeLists.txt via vcpkg; add CTest target; configure XML output for CI collection
- [x] T137 [P] Create ts/tests/helpers/fixtures.ts (shared fixture loader: resolves STEP paths from cpp/tests/fixtures/; exports canonical MVP fixture path for INF-03)
- [x] T138 Configure .github/workflows/ci.yml: define four job types from TESTING_STRATEGY.md — pr-ci (lint + unit + contract), merge-ci (+ bc-integration + sanitizer), nightly (full sweep), release-gate (matrix + evidence bundle)

**Gate Criteria**: All design documents complete; contracts define clear boundaries; quickstart is testable; test infrastructure is runnable on a fresh checkout.

---

## Phase A: Foundation (Week 1)

**Objective**: Implement core geometry infrastructure and MCP server scaffold.

### Geometry Engine - STEP Import & Topology (GE-01, GE-02, GE-03)

- [x] T021 [GE] Create cpp/src/geometry/geometry_service.hpp (facade interface for OCC operations)
- [x] T022 [GE] Implement cpp/src/geometry/geometry_service.cc (STEP import via OccStepReaderConfigurator; load test with fixture files)
- [x] T023 [GE] Create cpp/src/geometry/topology_graph.hpp (Face, Edge, Adjacency data structures)
- [x] T024 [GE] Implement topology_graph.cc (face-face adjacency extraction from OCC topology; test on 5 fixtures)
- [x] T025 [GE] Implement checkManifold() and healGeometry() in geometry_service.cc (manifold detection + topological healing)
- [x] T089 [GE] Create cpp/src/geometry/snapshot.hpp (GeometrySnapshot, SnapshotRegistry interface; required by Constitution Principle IV — rollback registry must exist before any Phase B mutating tool)
- [x] T090 [GE] Implement createSnapshot(), restoreSnapshot(), clearSnapshots() in geometry_service.cc (atomic rollback support; must be in place before Phase B mutating operations begin)
- [x] T026 [GE] Create cpp/tests/geometry_test.cc (Catch2 unit tests for GE-01, GE-02, GE-03, and GE-14 snapshot/rollback)
- [ ] T092 [GE] [P] Run GE Phase A tests under AddressSanitizer (detect memory leaks/corruption in geometry foundation; full Phase D sweep in T123)
- [x] T027 [GE] [P] Configure cpp/CMakeLists.txt (OCC linkage, vcpkg integration, compile flags)

### Manufacturing Domain - Config Stores (MD-01, MD-02, MD-03, MD-04)

- [x] T028 [MD] Create ts/src/manufacturing/material.ts (MaterialSpec store; load from YAML)
- [x] T029 [MD] [P] Create ts/src/manufacturing/tooling.ts (ToolingCapability store)
- [x] T030 [MD] [P] Create ts/src/manufacturing/logistics.ts (LogisticsConstraints store)
- [x] T031 [MD] [P] Create ts/src/manufacturing/environmental.ts (EnvironmentalContext store)
- [x] T032 [MD] Create ts/config/config.yaml template (materials, tooling, logistics, environmental sections)
- [x] T033 [MD] Create ts/src/config/loader.ts (YAML schema validation + parsing)
- [x] T034 [MD] Create ts/tests/manufacturing.test.ts (Vitest tests for MD-01–04 stores)

### MCP Server Scaffold (MCP-01, MCP-02)

- [x] T035 [MCP] Create ts/src/index.ts (MCP server entry point; stdio transport setup)
- [x] T036 [MCP] Create ts/src/mcp/resources.ts (static resource handlers: context://, logistics://, manufacturing://, geometry://)
- [x] T037 [MCP] Create ts/src/mcp/errors.ts (structured error model with codes from Engineering-Design §3.4)
- [x] T038 [MCP] Create ts/src/geometry/binding.ts (load NAPI addon; wrap geometry operations)
- [x] T039 [MCP] Create ts/src/geometry/session.ts (SessionState, GeometrySnapshot, RollbackToken management)
- [x] T040 [MCP] Create ts/tests/mcp.test.ts (Vitest tests for MCP server startup, resource serving)

### NAPI Addon Scaffolding

- [x] T041 [NAPI] Create cpp/src/napi/CMakeLists.txt (NAPI module build via cmake-js)
- [x] T042 [NAPI] Create cpp/src/napi/addon.cc (NAPI module initialization; register geometry methods)
- [x] T043 [NAPI] [P] Create cpp/src/napi/geometry_binding.cc (TypeScript ↔ C++ geometry serialization for topology graph, IDs)

### Contract Tests — NAPI Boundary (Phase A)

*Implements TESTING_STRATEGY.md contract layer: validate TypeScript ↔ C++ interface serialisation invariants.*

- [x] T139 [P] Create cpp/tests/napi_contract/napi_types_test.cc (Catch2: roundtrip tests for SolidId, ShellId, TopologyGraph serialisation; assert no precision loss across NAPI boundary)
- [x] T140 [P] Create ts/tests/contracts/geometry-binding.contract.test.ts (Vitest: call loadStep(), getTopology(), booleanCut() via NAPI wrapper; assert return shapes match geometry-port.md contract)
- [x] T141 [P] Create ts/tests/contracts/mcp-errors.contract.test.ts (Vitest: assert every error code in Engineering-Design §3.4 returns {code, message, recoverable, suggested_tool}; no unstructured throws)
- [x] T142 [P] Create ts/tests/contracts/mcp-resources.contract.test.ts (Vitest: assert resource URI handlers return correct schema for context://, logistics://, manufacturing://, geometry://)

### BC Integration Tests — GE (Phase A)

*Implements TESTING_STRATEGY.md GE-JTBD-01 to GE-JTBD-03: ingest, topology, manifest heal as a realistic in-context flow.*

- [x] T143 Create cpp/tests/ge_integration_test.cc (Catch2 BC integration: STEP ingest → topology build → manifold check → heal on 5 tier-1 and 5 tier-2 fixtures; assert deterministic output across repeated runs)

### BC Integration Tests — MD (Phase A)

*Implements TESTING_STRATEGY.md MD-JTBD-01: config store load → schema validity → runtime access as a realistic in-context flow.*

- [x] T144 Create ts/tests/integration/md_config.integration.test.ts (Vitest BC integration: load config.yaml → populate MaterialSpec, ToolingCapability, LogisticsConstraints, EnvironmentalContext → assert valid schemas and expected defaults)

**Risk Flags**: 
- 🟡 GE-02: OCC topology traversal on complex geometries may fail; mitigation: test on 10 fixture files
- 🟡 MCP-01: NAPI addon build chain requires cmake-js setup; mitigation: DEVELOPMENT.md provides guidance

**Gate Criteria Phase A → B**: 
- ✅ All 9 implementation tasks pass unit tests (GE-01/02/03, MD-01–04, MCP-01/02)
- ✅ Snapshot registry exists; createSnapshot/restoreSnapshot/clearSnapshots pass unit tests (T089–T090)
- ✅ GE Phase A tests pass under AddressSanitizer with zero memory errors (T092)
- ✅ NAPI contract tests pass on all roundtrip shapes (T139–T140)
- ✅ MCP error and resource contract tests pass (T141–T142)
- ✅ GE BC integration test passes deterministically on 10 fixtures (T143)
- ✅ MD config BC integration test passes (T144)
- ✅ MCP server starts; serves static resources
- ✅ Docker build succeeds (OCCT layer caches correctly)
- ✅ Zero unhandled exceptions in test suite
- ✅ STEP import works on all 10 test fixtures

---

## Phase B: Core Tools (Weeks 2–3)

**Objective**: Implement decomposition, joint synthesis, feature extraction.

### Geometry Engine - Decomposition & Joints (GE-04, GE-05, GE-06)

- [ ] T044 [GE] Implement booleanCut() in cpp/src/geometry/geometry_service.cc (plane-based solid decomposition; register child shells)
- [ ] T045 [GE] Implement addTabSlot() with kerf offset in cpp/src/geometry/geometry_service.cc (tab-slot geometry generation; include 0.1–0.2 mm kerf)
- [ ] T046 [GE] Create cpp/tests/tab_slot_test.cc (unit tests for tab-slot with kerf; tolerance ±0.05 mm)
- [ ] T047 [GE] Implement addRivetHole() in cpp/src/geometry/geometry_service.cc (rivet hole generation on shell faces)
- [ ] T048 [GE] [P] Add exception wrapping to geometry_service.cc (catch OCC exceptions; throw JavaScript Error with code + message)
- [x] T044 [GE] Implement booleanCut() in cpp/src/geometry/geometry_service.cc (plane-based solid decomposition; register child shells)
- [x] T045 [GE] Implement addTabSlot() with kerf offset in cpp/src/geometry/geometry_service.cc (tab-slot geometry generation; include 0.1–0.2 mm kerf)
- [x] T046 [GE] Create cpp/tests/tab_slot_test.cc (unit tests for tab-slot with kerf; tolerance ±0.05 mm)
- [x] T047 [GE] Implement addRivetHole() in cpp/src/geometry/geometry_service.cc (rivet hole generation on shell faces)
- [x] T048 [GE] [P] Add exception wrapping to geometry_service.cc (catch OCC exceptions; throw JavaScript Error with code + message)

### Manufacturing Domain - Rules & Validators (MD-05, MD-06, MD-07, MD-10)

- [ ] T049 [MD] Create ts/src/manufacturing/rules.ts (rule definitions: MIN_HOLE_DIAMETER, MIN_FLANGE_WIDTH, KERF_OFFSET, etc.)
- [ ] T050 [MD] Create ts/src/manufacturing/rules_engine.ts (rule aggregation, validation result composition)
- [ ] T051 [MD] Implement K-factor computation in ts/src/manufacturing/material.ts (bend allowance formula)
- [ ] T052 [MD] Implement validateBend(), validateHole(), validateFlange() in rules.ts
- [ ] T053 [MD] Implement isJointTypeAllowed() safety filter in ts/src/manufacturing/rules.ts (gated by environmental context)
- [ ] T054 [MD] Create ts/tests/rules.test.ts (Vitest: 100% coverage of MD-05–07, MD-10; test edge cases)
- [x] T049 [MD] Create ts/src/manufacturing/rules.ts (rule definitions: MIN_HOLE_DIAMETER, MIN_FLANGE_WIDTH, KERF_OFFSET, etc.)
- [x] T050 [MD] Create ts/src/manufacturing/rules_engine.ts (rule aggregation, validation result composition)
- [x] T051 [MD] Implement K-factor computation in ts/src/manufacturing/material.ts (bend allowance formula)
- [x] T052 [MD] Implement validateBend(), validateHole(), validateFlange() in rules.ts
- [x] T053 [MD] Implement isJointTypeAllowed() safety filter in ts/src/manufacturing/rules.ts (gated by environmental context)
- [x] T054 [MD] Create ts/tests/rules.test.ts (Vitest: 100% coverage of MD-05–07, MD-10; test edge cases)

### Anti-Corruption Layer - Feature Extraction (ACL-01, ACL-02, ACL-03, ACL-04, ACL-05)

- [x] T055 [ACL] Create ts/src/manufacturing/feature.ts (Bend, Hole, Flange, Relief entity definitions)
- [x] T056 [ACL] Create cpp/src/acl/feature_extractor.hpp (topology → feature classification interface)
- [x] T057 [ACL] Implement face classification in cpp/src/acl/feature_extractor.cc (identify bent faces vs flat vs curved)
- [x] T058 [ACL] Implement edge classification → bend detection in feature_extractor.cc (extract bend angle, radius, length)
- [x] T059 [ACL] [P] Implement hole detection in feature_extractor.cc (center, diameter extraction from face boundary)
- [x] T060 [ACL] [P] Implement flange detection in feature_extractor.cc (planar faces adjacent to bends)
- [x] T061 [ACL] Implement composeFeatureSet() in feature_extractor.cc (aggregate Bend, Hole, Flange → FeatureSet)
- [x] T062 [ACL] Create cpp/tests/feature_extractor_test.cc (Catch2: >90% accuracy on 10 test fixtures)

### MCP Tools - Core Operations (MCP-06, MCP-07, MCP-08)

- [ ] T063 [MCP] Implement clean_geometry tool in ts/src/mcp/tools.ts (load STEP, check manifold, heal if needed)
- [ ] T064 [MCP] Implement decompose_volume tool in ts/src/mcp/tools.ts (dispatch to GE-04; filter shells by size; call Manufacturing Domain validators)
- [ ] T065 [MCP] Implement synthesize_joints tool in ts/src/mcp/tools.ts (call GE-05 tab-slot; enforce MD-10 safety filter)
- [x] T063 [MCP] Implement clean_geometry tool in ts/src/mcp/tools.ts (load STEP, check manifold, heal if needed)
- [x] T064 [MCP] Implement decompose_volume tool in ts/src/mcp/tools.ts (dispatch to GE-04; filter shells by size; call Manufacturing Domain validators)
- [x] T065 [MCP] Implement synthesize_joints tool in ts/src/mcp/tools.ts (call GE-05 tab-slot; enforce MD-10 safety filter)
- [x] T066 [MCP] Create ts/tests/integration/mcp_b.integration.test.ts (system integration: SYS-JTBD-01 partial — STEP → clean → decompose → synthesize_joints; assert topology correctness and kerf presence)

### Contract Tests — Phase B

*Validates new contracts introduced by decomposition and joint synthesis APIs.*

- [ ] T145 [P] Create ts/tests/contracts/decompose.contract.test.ts (Vitest: assert decompose_volume tool input/output schema; verify panel_ids array, rollback_token present; error shape for invalid input)
- [ ] T146 [P] Create ts/tests/contracts/synthesize-joints.contract.test.ts (Vitest: assert synthesize_joints schema; verify kerf_offset_mm field present in response; safety rejection returns structured error)
- [x] T145 [P] Create ts/tests/contracts/decompose.contract.test.ts (Vitest: assert decompose_volume tool input/output schema; verify panel_ids array, rollback_token present; error shape for invalid input)
- [x] T146 [P] Create ts/tests/contracts/synthesize-joints.contract.test.ts (Vitest: assert synthesize_joints schema; verify kerf_offset_mm field present in response; safety rejection returns structured error)

### BC Integration Tests — GE Phase B

*Implements GE-JTBD-04: decompose + joint geometry as a realistic GE-internal flow.*

- [ ] T147 Create cpp/tests/ge_decompose_integration_test.cc (Catch2 BC integration: loadStep → booleanCut → extractShell → addTabSlot; assert child shell count, kerf tolerance ±0.05 mm, deterministic across 3 runs)
- [x] T147 Create cpp/tests/ge_decompose_integration_test.cc (Catch2 BC integration: loadStep → booleanCut → extractShell → addTabSlot; assert child shell count, kerf tolerance ±0.05 mm, deterministic across 3 runs)

### BC Integration Tests — MD Phase B

*Implements MD-JTBD-02, MD-JTBD-03: rule validation + safety enforcement as a realistic MD-internal flow.*

- [ ] T148 Create ts/tests/integration/md_rules.integration.test.ts (Vitest BC integration: load config → supply FeatureSet with intentional violations → assert violations detected; fire-rated context → assert adhesive joint rejected)
- [x] T148 Create ts/tests/integration/md_rules.integration.test.ts (Vitest BC integration: load config → supply FeatureSet with intentional violations → assert violations detected; fire-rated context → assert adhesive joint rejected)

### BC Integration Tests — ACL Phase B

*Implements ACL-JTBD-01 to ACL-JTBD-03: topology to FeatureSet pipeline as a realistic ACL-internal flow.*

- [ ] T149 Create cpp/tests/acl_integration_test.cc (Catch2 BC integration: load tier-1 and tier-2 STEP fixtures → run full feature extraction pipeline → assert Bend/Hole/Flange count and attribute accuracy >90% on 10 fixtures)

**Risk Flags**: 
- 🔴 GE-05: Tab-slot with kerf is geometrically complex; highest risk. Mitigation: spike with simple test case; validate boolean cut before shell registration.
- 🟡 ACL-01–05: Feature extraction heuristics may not generalize. Mitigation: extensive fixture testing; document edge cases.
- 🟡 MCP-07: Decomposition strategy dispatch in MCP layer. Mitigation: ensure Manufacturing Domain rules called correctly.

**Gate Criteria Phase B → C**: 
- ✅ Integration test: STEP → clean → decompose produces child shells with correct topology
- ✅ Tab-slot geometry includes kerf offset (±0.05 mm tolerance)
- ✅ Feature Extractor >90% accurate on 10 test fixtures
- ✅ Safety filter blocks fire-rated joint types; allows others
- ✅ 100% unit test coverage on Manufacturing Domain rules (MD-05–07, MD-10)
- ✅ Decompose and synthesize-joints contract tests pass (T145–T146)
- ✅ GE decompose BC integration test deterministic (T147)
- ✅ MD rules BC integration test covers violations and safety enforcement (T148)
- ✅ ACL BC integration test >90% accuracy (T149)
- ✅ All Phase A tests still pass

---

## Phase C: Sheet Metal Operations (Weeks 4–5)

**Objective**: Implement unfolding, bend validation, manufacturability scoring.

### Geometry Engine - Unfolding & Reliefs (GE-08, GE-09, GE-10)

- [ ] T067 [GE] Create cpp/src/geometry/relief.hpp (corner relief generation interface)
- [ ] T068 [GE] Implement addCornerRelief() in cpp/src/geometry/geometry_service.cc (dogbone and circular relief types; verify relief geometry)
- [ ] T069 [GE] Create cpp/src/geometry/unfold.hpp (sheet metal unfolding interface; K-factor parameterized)
- [ ] T070 [GE] Implement unfold() in cpp/src/geometry/unfold.cc (CadQuery Python call OR custom OCC-based unfolding; extract 2D wire DXF representation)
- [ ] T071 [GE] Test unfold accuracy on 10 varied sheet metal designs; document K-factor validation (±0.5% tolerance); add tests/unfold_test.cc
- [ ] T072 [GE] Implement exportDxf() in cpp/src/geometry/geometry_service.cc (DXF wire export from UnfoldId)
- [ ] T073 [GE] [P] Update cpp/tests/geometry_test.cc with GE-08, GE-09, GE-10 test cases

### Manufacturing Domain - Bend Sequence & Scoring (MD-11, MD-12)

- [ ] T074 [MD] Create ts/src/manufacturing/bend_sequence.ts (rule-based bend order validation; detect non-colliding sequences)
- [ ] T075 [MD] Implement validateBendSequence() in bend_sequence.ts (topological validation; document assumptions and edge cases)
- [ ] T076 [MD] Create ts/src/manufacturing/manufacturability.ts (scoring function combining all rule violations)
- [ ] T077 [MD] Implement scorePanel() in manufacturability.ts (aggregate violations → 0.0–1.0 score; >90% violation detection on test suite)
- [ ] T078 [MD] Create ts/tests/bend_sequence.test.ts (Vitest: comprehensive bend order scenarios; document limitations)
- [ ] T079 [MD] Create ts/tests/manufacturability.test.ts (Vitest: >95% rule violation flag accuracy)

### MCP Tools - Sheet Metal (MCP-09, MCP-10, MCP-12, MCP-13)

- [ ] T080 [MCP] Implement generate_reliefs tool in ts/src/mcp/tools.ts (dispatch to GE-08; return updated shell ID)
- [ ] T081 [MCP] Implement apply_unfold tool in ts/src/mcp/tools.ts (dispatch to GE-09 with material K-factor; return UnfoldId with flat dimensions)
- [ ] T082 [MCP] Implement evaluate_manufacturability tool in ts/src/mcp/tools.ts (extract features via ACL-05; call MD-12 scorer; return score + violations)
- [ ] T083 [MCP] Implement validate_bend_sequence tool in ts/src/mcp/tools.ts (dispatch to MD-11; return suggested sequence + collision warnings)
- [ ] T084 [MCP] Update ts/tests/integration/mcp_b.integration.test.ts (extend SYS-JTBD-01 partial → add unfold step: STEP → clean → decompose → tab-slot → unfold)

### Contract Tests — Phase C

*Validates new contracts introduced by unfold, relief, and manufacturability tools.*

- [ ] T150 [P] Create ts/tests/contracts/apply-unfold.contract.test.ts (Vitest: assert apply_unfold output schema; flat_width_mm, flat_height_mm, unfold_id, k_factor_used present; error shape for non-sheet-metal geometry)
- [ ] T151 [P] Create ts/tests/contracts/evaluate-manufacturability.contract.test.ts (Vitest: assert evaluate_manufacturability response includes score (0.0–1.0), violations array, each violation has rule_code + severity + feature_id)

### BC Integration Tests — GE Phase C

*Implements GE-JTBD-05: unfold and DXF export as a realistic GE-internal flow.*

- [ ] T152 Create cpp/tests/ge_unfold_integration_test.cc (Catch2 BC integration: load tier-2 fixtures → addCornerRelief → unfold → exportDxf; assert flat dimensions within ±0.5% of manual reference; DXF wire count > 0)

### BC Integration Tests — MD Phase C

*Implements MD-JTBD-02, MD-JTBD-05: bend sequence + manufacturability scoring as a realistic MD-internal flow.*

- [ ] T153 Create ts/tests/integration/md_scoring.integration.test.ts (Vitest BC integration: compose FeatureSet with known bend/hole violations → scorePanel → assert score < 0.5 and violations match expected rule codes; test with passing FeatureSet → score > 0.9)

### Non-Functional: Determinism Replay (Phase C)

*Implements TESTING_STRATEGY.md non-functional requirement: deterministic geometry.*

- [ ] T154 [P] Create cpp/tests/determinism_test.cc (Catch2: run unfold() on 5 tier-2 fixtures 3 times each; compare output flat dimensions and DXF wire hash; assert byte-for-byte identical across runs)

**Risk Flags**: 
- 🔴 GE-09: Sheet metal unfolding is highest geometric risk. Mitigation: spike with 5 test designs; if CadQuery insufficient, implement fallback heuristic.
- 🟡 MD-11: Rule-based bend sequence may have false positives. Mitigation: extensive test suite; clearly document assumptions.
- 🟡 MCP-12–13: Depend on ACL-05 accuracy. Mitigation: ensure feature extraction validated in Phase B.

**Gate Criteria Phase C → D**: 
- ✅ Unfolding succeeds on 10 varied designs; K-factors within ±0.5% of manual
- ✅ Bend sequence validation produces non-colliding sequences
- ✅ Relief generation detects all internal bend intersections
- ✅ Manufacturability scoring flags >95% of rule violations in test suite
- ✅ SYS-JTBD-01 partial integration test: STEP → clean → decompose → tab-slot → unfold (T084)
- ✅ Unfold and manufacturability contract tests pass (T150–T151)
- ✅ GE unfold BC integration test passes ±0.5% tolerance on tier-2 fixtures (T152)
- ✅ MD scoring BC integration test passes (T153)
- ✅ Determinism replay test passes on 5 fixtures × 3 runs (T154)
- ✅ All Phase A–B tests still pass

---

## Phase D: Production Output + MVP Gate (Weeks 6–8)

**Objective**: Implement nesting, async export, golden-path integration test.

### Geometry Engine - Nesting & Snapshot (GE-12, GE-13, GE-14)

- [ ] T085 [GE] Create cpp/src/geometry/nesting.hpp (libnest2d integration interface)
- [ ] T086 [GE] Implement nest() in cpp/src/geometry/nesting.cc (polygon extraction from UnfoldIds; dispatch to libnest2d; return NestLayout)
- [ ] T087 [GE] Test nesting on 3 standard sheet sizes; verify >80% material utilisation; add tests/nesting_test.cc
- [ ] T088 [GE] Implement SVG preview generation in cpp/src/geometry/nesting.cc (visualize nest layout for debugging)
- [ ] T091 [GE] Update cpp/tests/geometry_test.cc with GE-12, GE-13 (nesting) cases; GE-14 snapshot/rollback tests covered in Phase A (T089–T090)

### Manufacturing Domain - Production Export (MD-14, MD-15)

- [ ] T093 [MD] Create ts/src/manufacturing/bom.ts (BOM generator: part count, material IDs, costs)
- [ ] T094 [MD] Implement generateBOM() in bom.ts (extract from FeatureSet + material config; produce CSV)
- [ ] T095 [MD] Create ts/src/manufacturing/assembly.ts (assembly instruction generator: join order, tooling setup)
- [ ] T096 [MD] Implement generateAssembly() in assembly.ts (topological ordering of bends/joints; produce JSON with steps)
- [ ] T097 [MD] Create ts/tests/bom.test.ts (Vitest: valid CSV output, material cost calculation)
- [ ] T098 [MD] Create ts/tests/assembly.test.ts (Vitest: join order validation, JSON schema compliance)

### MCP Tools - Export & Rollback (MCP-11, MCP-14, MCP-15, MCP-16)

- [ ] T099 [MCP] Create ts/src/geometry/jobs.ts (ExportJob queue interface; job lifecycle manager)
- [ ] T100 [MCP] Implement in-process Promise queue in jobs.ts (enqueue, status polling, result retrieval; design for BullMQ migration)
- [ ] T101 [MCP] Implement simulate_nesting tool in ts/src/mcp/tools.ts (dispatch to GE-12; return NestLayout + utilisation %)
- [ ] T102 [MCP] Implement export_production_pack tool in ts/src/mcp/tools.ts (enqueue async export job; return job_id + initial status)
- [ ] T103 [MCP] Implement get_export_job_status tool in ts/src/mcp/tools.ts (poll job queue; return status, progress %)
- [ ] T104 [MCP] Implement get_export_job_result tool in ts/src/mcp/tools.ts (retrieve completed job files; return ExportResult)
- [ ] T105 [MCP] Implement rollback tool in ts/src/mcp/tools.ts (dispatch to GE-14; restore snapshot; return SolidId list)
- [ ] T106 [MCP] Implement structured error propagation in ts/src/mcp/errors.ts (all tool errors return { code, message, recoverable, suggested_tool })
- [ ] T107 [MCP] Create ts/tests/export.test.ts (Vitest: job enqueue, status polling, result retrieval; load test 20 concurrent jobs)

### Infrastructure & Deployment (INF-01, INF-02)

- [ ] T108 [INF] Build Docker image (cpp/Dockerfile multi-stage); verify OCCT layer caches correctly (first: 90 min, incremental: 5 min)
- [ ] T109 [INF] Create ts/config/schema.ts (JSON schema validator for config.yaml)
- [ ] T110 [INF] Document config.yaml format in docs/ (materials, tooling, logistics, environmental structure)
- [ ] T111 [INF] Create docker-compose.yml for local development (volume mount, port 8080)

### Golden-Path Integration Test (INF-03) 🎯 MVP GATE

- [ ] T112 [INF] Create ts/tests/e2e/integration_e2e.test.ts (Vitest E2E: complete STEP → DXF end-to-end flow; maps to SYS-JTBD-06)
- [ ] T120 [INF] Create test fixture STEP file (3-panel sheet metal design with known decomposition path; canonical INF-03 fixture — tier-1 simple, never changed without review)
- [ ] T113 [INF] [P] Implement SYS-JTBD-06 step 1: STEP ingestion (clean_geometry) → assert is_manifold=true, no structured errors
- [ ] T114 [INF] [P] Implement SYS-JTBD-06 step 2: Decomposition (decompose_volume) → assert 3 child shells, rollback_token present
- [ ] T115 [INF] [P] Implement SYS-JTBD-06 step 3: Joint synthesis (synthesize_joints) → assert tab-slot geometry, kerf_offset_mm within [0.1, 0.2]
- [ ] T116 [INF] [P] Implement SYS-JTBD-06 step 4: Unfolding (apply_unfold per panel) → assert flat dimensions within ±0.5% of reference, k_factor_used recorded
- [ ] T117 [INF] [P] Implement SYS-JTBD-06 step 5: Nesting (simulate_nesting) → assert utilisation_pct > 80, sheets_required integer
- [ ] T118 [INF] [P] Implement SYS-JTBD-06 step 6: Export submission (export_production_pack) → assert job_id returned, initial status queued or running
- [ ] T119 [INF] [P] Implement SYS-JTBD-06 step 7: Status polling + result retrieval (get_export_job_status / get_export_job_result) → assert status succeeded, file list includes dxf, bom.csv, assembly.json
- [ ] T121 [INF] Run INF-03 test end-to-end; verify total execution time <30 sec; record to docs/test-reports/inf03_baseline.json
- [ ] T122 [INF] Verify all unit tests pass with >85% code coverage (C++ gcov + Vitest reports); generate docs/test-reports/coverage_summary.md
- [ ] T123 [INF] Run all GE/MD/ACL/MCP tests under AddressSanitizer (zero memory errors); save sanitizer output to docs/test-reports/sanitizer_phase_d.log
- [ ] T124 [INF] Document MVP acceptance in docs/MVP_ACCEPTANCE.md (checklist of all gates)

### System Integration Tests — Cross-BC JTBD Flows (Phase D)

*Implements TESTING_STRATEGY.md SYS-JTBD-01 to SYS-JTBD-05: cross-BC flows that are distinct from INF-03.*

- [ ] T155 Create ts/tests/integration/sys_jtbd_02_safety.integration.test.ts (Vitest system integration: SYS-JTBD-02 — synthesize_joints with fire_rated=true in env context; assert adhesive joint rejected with structured error; assert tab_slot allowed)
- [ ] T156 Create ts/tests/integration/sys_jtbd_03_unfold_score.integration.test.ts (Vitest system integration: SYS-JTBD-03 — apply_unfold + evaluate_manufacturability end-to-end; assert score + violation list; assert deterministic across 3 runs)
- [ ] T157 Create ts/tests/integration/sys_jtbd_05_rollback.integration.test.ts (Vitest system integration: SYS-JTBD-05 — perform decompose, record rollback_token, call rollback; assert SolidIds restored, no partial state residue)
- [ ] T158 [P] Create ts/tests/integration/sys_jtbd_04_export_lifecycle.integration.test.ts (Vitest system integration: SYS-JTBD-04 — simulate_nesting → export_production_pack → poll until succeeded → get_export_job_result; assert every lifecycle state transition is valid)
- [ ] T162 Create ts/tests/integration/sys_jtbd_01_decompose.integration.test.ts (Vitest system integration: SYS-JTBD-01 full closure — STEP → clean_geometry → decompose_volume → synthesize_joints → apply_unfold; assert correct shell count, kerf presence, flat dimensions within ±0.5%; standalone named suite closing SYS-JTBD-01)

### Non-Functional: Phase D Gates

*Implements TESTING_STRATEGY.md non-functional gates for release readiness.*

- [ ] T159 [P] Add nesting determinism to cpp/tests/determinism_test.cc (extend T154: run nest() on canonical fixture 3 times; assert identical NestLayout and utilisationPct)
- [ ] T160 [P] Create ts/tests/integration/error_model.integration.test.ts (Vitest: call each MCP tool with invalid input; assert every error path returns {code, message, recoverable, suggested_tool}; assert no unstructured throws reach test boundary)

### Evidence Bundle Generation (Phase D)

*Implements TESTING_STRATEGY.md evidence artifacts required for release candidate CI.*

- [ ] T161 Create .github/workflows/release-evidence.yml (CI job: on release trigger; run full matrix; collect Catch2 XML, Vitest junit, gcov, sanitizer logs into docs/test-reports/; fail build if any gate fails)

**Risk Flags**: 
- 🔴 GE-12: libnest2d integration complexity. Mitigation: prototype early in Phase A research (T002).
- 🟡 INF-01: Docker multi-stage OCCT caching critical for CI efficiency. Mitigation: validate layer caching in first build.
- 🔴 INF-03: Golden-path integration test is MVP acceptance gate and non-quarantinable. Mitigation: test early and often using canonical tier-1 fixture.

**Gate Criteria Phase D (MVP Acceptance)**:
- ✅ Nesting achieves >80% material utilization on 3 standard sheet sizes
- ✅ Async export enqueues job; returns job_id; get_export_job_status polls correctly
- ✅ **Golden-path Integration Test (INF-03 / SYS-JTBD-06): STEP → DXF export completes end-to-end without errors**
- ✅ SYS-JTBD-02 safety test passes (fire-rated rejection, T155)
- ✅ SYS-JTBD-03 unfold+score system integration test passes deterministically (T156)
- ✅ SYS-JTBD-05 rollback integrity test passes (T157)
- ✅ SYS-JTBD-04 async export lifecycle contract test passes (T158)
- ✅ SYS-JTBD-01 full system integration test passes: STEP → clean → decompose → joints → unfold (T162)
- ✅ Nesting determinism test passes (T159)
- ✅ Error model compliance test passes for all MCP tools (T160)
- ✅ Docker image builds; MCP server starts inside container
- ✅ All unit tests (GE-*, MD-*, ACL-*, MCP-*) pass with >85% code coverage
- ✅ BOM generator produces valid CSV with material costs
- ✅ Assembly instructions generate valid JSON
- ✅ All Phase A–C tests still pass

---

## Phase Z: Quality & Documentation

**Objective**: Finalize quality gates, update documentation.

- [ ] T125 Generate code coverage reports (C++ gcov, TypeScript Vitest); ensure >85% coverage
- [ ] T126 Create docs/OCCT_VERSION.md (current version, upgrade path, known breaking changes)
- [ ] T127 Create docs/PERFORMANCE.md (benchmark results: STEP import, decomposition, unfolding, nesting, export times)
- [ ] T128 Create docs/TROUBLESHOOTING.md (common issues, debugging cmake-js, OCCT memory issues)
- [ ] T129 [P] Update README.md with feature summary, build instructions, MVP acceptance criteria
- [ ] T130 [P] Create RELEASE_NOTES.md (Phase A–D completion, MVP gate status, post-MVP roadmap)
- [ ] T131 Validate all documentation links (README, DEVELOPMENT, MVP_SCOPE, OCCT_STABILITY)
- [ ] T163 [P] Create ts/tests/contracts/architecture-boundaries.contract.test.ts (Vitest: assert GE modules import no MD types; assert MD modules import no OCC types; validate bounded-context language allocation per Constitution Principle II; maps to ARCH-TEST-01)
- [ ] T164 Validate specs/001-align-specification/checklists/requirements.md sign-off and record compliance evidence in docs/test-reports/governance_sign_off.md (maps to GOV-TEST-01; confirms FR-010 and Constitution Principle VII)
- [ ] T165 [P] Verify docs/test-reports/ contains all required evidence: inf03_baseline.json, coverage_summary.md, sanitizer_phase_d.log, governance_sign_off.md; flag any missing items before release sign-off
- [ ] T132 Commit final state to feature branch (pending post-MVP work)

---

## Dependencies & Sequencing

### Critical Path

1. **T008** (CMakeLists.txt) → **T021–T027** (Geometry Engine Phase A)
2. **T009** (package.json) → **T028–T034** (Manufacturing Domain Phase A)
3. **T021–T027** + **T028–T034** → **T035–T043** (MCP Server scaffold)
4. **T035–T043** + Phase A tests pass → **Phase B begins** (T044–T066)
5. **Phase B gates pass** → **Phase C begins** (T067–T084)
6. **Phase C gates pass** → **Phase D begins** (T085–T124)
7. **INF-03 golden-path test passes** → **MVP Acceptance**

### Parallelization Opportunities

- **Phase 1 Design Artifacts** (T013–T020): All independent; can run in parallel
- **CI Workflow Chain** (T011 → T138 → T161): T011 creates the `.github/workflows/` directory skeleton only; T138 (Phase 1) configures the four-job CI model; T161 (Phase D) adds the release evidence job. T138 depends on T011; T161 depends on T138.
- **Phase A Manufacturing Domain** (T028–T034): All independent; can run in parallel
- **Phase A NAPI Scaffold** (T041–T043): Can run after T021 (geometry_service defined)
- **Phase B Validators** (T049–T054): Can run in parallel with Geometry Engine work
- **Phase B ACL** (T055–T062): Can start after T024 (topology_graph complete)
- **Phase C Relief & Unfold** (T067–T073): Can run in parallel
- **Phase C Bend Sequence & Scoring** (T074–T079): Can run in parallel
- **Phase D Nesting Tests** (T087): Can start once GE-12 skeleton exists
- **Phase D Golden-path Steps** (T113–T119): Each step (STEP, decompose, joints, unfold, nest, export, result) can be implemented independently; merged into single test

### Estimated Effort per Phase

| Phase | Duration | FTE | Notes |
|-------|----------|-----|-------|
| **Phase 0** | 1–2 weeks | 1 | Research spikes; parallel OK |
| **Phase 1** | 1 week | 1–2 | Design artifacts + project setup; mostly parallel |
| **Phase A** | 1 week | 1–2 | Foundation; some sequential (Phase A → B gate) |
| **Phase B** | 2 weeks | 2 | Geometry, rules, feature extraction; high parallelism |
| **Phase C** | 2 weeks | 2 | Unfolding + bend validation; sequential risk (unfolding) |
| **Phase D** | 2 weeks | 2 | Nesting + export + integration; critical path INF-03 |
| **Phase Z** | 1 week | 1 | Quality, docs, release |
| **Total** | 8–10 weeks | — | **With 2 FTE parallelism: ~5–6 weeks to MVP** |

---

## Format Notes

**Format**: `- [ ] [TaskID] [P?] [Story?] Description with file path`

- **[P]** marks parallelizable tasks (different files/subsystems, no inter-task dependencies)
- **[GE], [MD], [ACL], [MCP], [NAPI], [INF]** indicate technical component
- **File paths** are exact locations from plan.md project structure
- **Test tasks** are included (GE, MD, ACL, MCP have dedicated test files)
- **Task numbering** is a stable ID assignment, not an ordinal position within a section. T120 (canonical INF-03 fixture) appears before T113–T119 in Phase D to ensure the fixture exists before test steps reference it; this ordering is intentional.

---

## Testing Strategy Execution

### Test Pyramid for Delivery

| Layer | Intent | Primary Files |
|------|--------|---------------|
| Unit | Validate deterministic local behavior | cpp/tests/geometry_test.cc, ts/tests/manufacturing.test.ts, ts/tests/rules.test.ts |
| Contract | Validate interface and error model compatibility | cpp/tests/napi_contract/, ts/tests/contracts/ |
| Integration | Validate multi-component orchestration flows | ts/tests/integration/ |
| End-to-End | Validate MVP production path and acceptance | ts/tests/e2e/integration_e2e.test.ts |

### Cross-Phase Test Cadence

1. During each feature task: run local unit tests for touched component.
2. At phase completion: run full phase suite plus prior phase regression suite.
3. Before any gate approval: run integration suite and required non-functional checks.
4. Before MVP sign-off: run INF-03 end-to-end plus coverage and sanitizer gates.

### Mandatory Evidence per Gate

| Gate | Required Evidence |
|------|-------------------|
| A -> B | GE and MD unit reports, MCP resource tests, STEP fixture pass logs |
| B -> C | Kerf tolerance evidence, feature extraction accuracy report, integration logs |
| C -> D | Unfold tolerance report, bend-sequence validation results, manufacturability accuracy logs |
| D (MVP) | INF-03 report, coverage summary, sanitizer report, export lifecycle logs |

### Flakiness Control Rules

1. Any test failing intermittently on two consecutive CI runs is flagged as flaky.
2. Flaky tests are quarantined only with owner, ticket, and remediation deadline.
3. No critical-path gate can depend on quarantined tests.
4. INF-03 cannot be quarantined; failures block release readiness.

---

## Acceptance Criteria Checklist

### Phase A Acceptance
- [ ] GE-01, GE-02, GE-03 unit tests pass
- [ ] MD-01–04 unit tests pass
- [ ] MCP-01, MCP-02 unit tests pass (startup + resource serving)
- [ ] NAPI contract tests pass: type roundtrips (T139–T140), error shape (T141), resource schema (T142)
- [ ] GE BC integration: deterministic topology on 10 fixtures (T143)
- [ ] MD BC integration: config load and schema validation passes (T144)
- [ ] STEP import works on all 10 test fixtures
- [ ] Docker build succeeds (layer caching observed)

### Phase B Acceptance
- [ ] GE-04, GE-05, GE-06 unit tests pass
- [ ] MD-05–07, MD-10 unit tests pass
- [ ] ACL-01–05 unit tests pass (>90% accuracy)
- [ ] Decompose and synthesize-joints contract tests pass (T145–T146)
- [ ] GE decompose BC integration: kerf ±0.05 mm, deterministic (T147)
- [ ] MD rules BC integration: violations detected, safety enforced (T148)
- [ ] ACL BC integration: >90% feature accuracy on 10 fixtures (T149)
- [ ] SYS-JTBD-01 partial: STEP → clean → decompose → joints system integration passes (T066)
- [ ] Safety filter blocks fire-rated joint types

### Phase C Acceptance
- [ ] GE-08, GE-09, GE-10 unit tests pass
- [ ] MD-11, MD-12 unit tests pass (>95% violation detection)
- [ ] MCP-09, MCP-10, MCP-12, MCP-13 tests pass
- [ ] Unfold and manufacturability contract tests pass (T150–T151)
- [ ] GE unfold BC integration: flat dimensions ±0.5% on tier-2 fixtures (T152)
- [ ] MD scoring BC integration: score and violations correct (T153)
- [ ] Determinism replay: unfold output identical across 3 runs (T154)
- [ ] SYS-JTBD-01 partial extended through unfold (T084)

### Phase D Acceptance (MVP Gate)
- [ ] GE-12, GE-13, GE-14 unit tests pass
- [ ] MD-14, MD-15 unit tests pass
- [ ] MCP-11, MCP-14, MCP-15, MCP-16 tests pass
- [ ] **INF-03 / SYS-JTBD-06 golden-path E2E test passes end-to-end** (T113–T121)
- [ ] SYS-JTBD-02 safety system integration passes (T155)
- [ ] SYS-JTBD-03 unfold+score system integration passes deterministically (T156)
- [ ] SYS-JTBD-05 rollback integrity passes (T157)
- [ ] SYS-JTBD-04 async export lifecycle passes (T158)
- [ ] Nesting determinism test passes (T159)
- [ ] Error model compliance test passes for all tools (T160)
- [ ] Material utilization >80% on 3 standard sheets
- [ ] Async export job queue load test passes (20 concurrent jobs)
- [ ] All code coverage >85% — evidence in docs/test-reports/coverage_summary.md
- [ ] Zero memory errors under AddressSanitizer — evidence in docs/test-reports/sanitizer_phase_d.log
- [ ] Release evidence bundle generated (T161)

---

## Next Steps

1. ✅ **Specification complete** (spec.md)
2. ✅ **Plan complete** (plan.md)
3. ⏳ **Tasks generated** (tasks.md) — **YOU ARE HERE**
4. 🚀 **Execution ready** — Begin Phase 0 research tasks (T001–T006)
5. 📋 **Phase gates** — Validate each phase before proceeding to next

**Start with**: [T001–T006] (Phase 0 Research)

---

