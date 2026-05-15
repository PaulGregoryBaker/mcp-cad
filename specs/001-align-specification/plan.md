# Implementation Plan: Apply Architecture and Engineering Designs to Specification

**Branch**: `001-align-specification` | **Date**: 2026-05-13 | **Spec**: [specs/001-align-specification/spec.md](spec.md)

**Input**: Feature specification from `/specs/001-align-specification/spec.md`

**Authoritative References**:
- [Architecture.md](../../Architecture.md) — System architecture, bounded contexts, MCP specification
- [Engineering-Design.md](../../Engineering-Design.md) — Detailed work breakdown structure, resolved MVP decisions, OCCT stability mitigations, technology stack
- [.specify/memory/constitution.md](.specify/memory/constitution.md) — Core principles governing implementation

---

## Summary

The feature integrates approved architecture and engineering decisions into the specification, producing a unified baseline ready for detailed task generation and implementation. The plan establishes four bounded contexts (Geometry Engine, Manufacturing Domain, Anti-Corruption Layer, MCP Protocol Layer), confirms language allocation (C++ + TypeScript + NAPI interop), and defines a four-phase implementation roadmap with explicit gates and risk mitigations.

**Key Outcomes**:
- Single source of truth: Architecture + Engineering-Design decisions consolidated in specification
- Clear phase gates: Foundation → Core Tools → Sheet Metal → Production Output + MVP
- Risk reduction: OCCT stability mitigations, nesting library selection, async export contract
- Ready for planning: All unknowns resolved; data model and contracts defined

---

## Technical Context

**Language/Version**: 
- **Geometry Engine**: C++ (primary) with OCCT v7.8.x (LTS), or Rust + cxx (alternative)
- **Anti-Corruption Layer**: C++ (primary) or Rust (alternative)
- **Manufacturing Domain**: TypeScript
- **MCP Protocol Layer**: TypeScript (Node.js LTS 22.x)

**Primary Dependencies**:
- **Geometry**: Open Cascade Technology (OCCT) v7.8.x, libnest2d (C++), CadQuery (Python fallback)
- **Build**: CMake, vcpkg (C++ manifest mode), cmake-js (NAPI)
- **Interop**: Node-API (NAPI) v9+, TypeScript, @modelcontextprotocol/sdk
- **TypeScript**: @modelcontextprotocol/sdk (Node.js LTS 22.x) for MCP service, Vitest for testing
- **C++ Testing**: Catch2 framework

**Storage**: 
- In-memory session-scoped geometry state (no persistent storage for MVP)
- Configuration: YAML files (materials, tooling, logistics, environmental context)
- Job queue: In-process Promise queue (not Redis for MVP)

**Testing**: 
- **C++**: Catch2 framework (unit tests for geometry operations)
- **TypeScript**: Vitest (unit and integration tests)
- **Integration**: End-to-end test: STEP → clean → decompose → tab-slot → unfold → nest → DXF (INF-03)

**Target Platform**: 
- **Runtime**: Docker container (ubuntu:22.04, python:3.11-slim)
- **Transport**: stdio (Claude Desktop), HTTP+SSE port 8080 (cloud future)
- **Deployment**: Single-session, local/edge (Kubernetes deferred to post-MVP)

**Project Type**: MCP server + NAPI C++ geometry library + TypeScript manufacturing domain rules

**Performance Goals**: 
- STEP import: <1 sec for typical CAD files (< 100K faces)
- Boolean decomposition: <5 sec per cut operation
- Unfolding: <2 sec per panel
- Nesting: <3 sec for 5–10 panels
- Export job: <30 sec for nested DXF generation

**Constraints**: 
- **Deterministic geometry**: All operations must produce identical results for same inputs (no randomness in geometry or nesting)
- **Single-session state**: No multi-session concurrency for MVP
- **Kerf compensation**: All slot geometry must include 0.1–0.2 mm offset before registration
- **Safety filters**: Environmental constraints (fire-rated, marine) are non-bypassable
- **OCCT stability**: Version pinned to 7.8.1; facade layer isolates API churn; wrapped exceptions

**Scale/Scope**: 
- **MVP target**: 2–5 panel decompositions from typical sheet metal CAD designs
- **Geometry complexity**: Solids up to ~100K faces (OCCT baseline)
- **Session lifespan**: Single design project per process instance
- **Export outputs**: Nested DXF (per sheet), STEP assembly, BOM CSV, assembly instructions JSON

---

## Constitution Check

**Status**: ✅ **PASS with Justifications** (all 9 principles verified; 0 violations)

The implementation plan adheres to all core principles defined in `.specify/memory/constitution.md`:

| Principle | Verification |
|-----------|---|
| **I. Deterministic Geometry Intelligence** | ✅ Geometry Engine has no AI/approximation logic; all math is closed-form or verified-deterministic. OCC operations wrapped with exact tolerance specifications. No heuristics in geometry subsystem. |
| **II. Bounded Context Separation** | ✅ Four contexts clearly defined: Geometry Engine (B-Rep), Manufacturing Domain (rules), Feature Extractor (translation), MCP Protocol Layer (orchestration). Each owns ubiquitous language; no primitive leaking. GeometryPort and ManufacturingPort define contract boundaries. |
| **III. Safety Filter Enforcement** | ✅ Fire-rated, marine-grade, vibration constraints enforced at MCP Protocol Layer before delegating to Geometry Engine. synthesize_joints respects is_joint_type_allowed() gating. No override mechanism exposed to AI Harness. |
| **IV. Rollback-First State Management** | ✅ Every mutating tool produces rollback_token before executing. Geometry Engine maintains snapshot registry. MCP Protocol Layer validates tokens and orchestrates restoration. Atomic from registry perspective. |
| **V. Kerf Compensation is Mandatory** | ✅ All tab/slot geometry includes 0.1–0.2 mm kerf offset (sourced from manufacturing://rules). Offset applied in Geometry Engine Service layer, not AI Harness. add_tab_slot() enforces before registration. |
| **VI. Structured Errors Always** | ✅ All tool errors return { code, message, recoverable, suggested_tool }. Error model (§4 in Engineering-Design) covers 10 codes. Unstructured exceptions wrapped at MCP Protocol Layer. |
| **VII. MVP Scope Discipline** | ✅ MVP target: STEP → clean → decompose (2–5 panels) → tab-slot → unfold → nest → DXF export. All complexity deferred post-MVP (cloud APIs, OAuth2, multi-session, 3D collision sim). Bend validation is rule-based. |
| **VIII. Configuration Over Hard-Coding** | ✅ Material inventory, tooling specs, logistics constraints, environmental context managed via MCP resources/config (INF-02). Zero manufacturing parameters hard-coded. Tenant overlays deferred. |
| **IX. Async Export Contract (NON-NEGOTIABLE)** | ✅ export_production_pack returns job_id + status immediately. get_export_job_status and get_export_job_result are the only completion flow. Sync export calls not permitted. |

**No complexity violations require justification. Implementation fully adheres to constitution.**

---

## Gates & Sequencing

### Phase Gating Model

**Gate 0 (Pre-Phase A)**: 
- ✅ **PASS**: Constitution verified; spec reviewed; OCCT stability mitigations documented.

**Gate A → B**: Phase A stories (GE-01, GE-02, GE-03, MD-01–04, MCP-01–02) must achieve:
- [ ] GE-01 STEP import loads fixture files successfully
- [ ] GE-02 topology graph builds without crashes on 5 test solids
- [ ] GE-03 manifold check + heal pass/fail correctly classified
- [ ] All MD-01–04 config stores return valid schemas
- [ ] MCP-01–02 server starts, responds to resource requests (no tool dispatch yet)
- [ ] Zero unhandled exceptions in unit test suite

**Gate B → C**: Phase B stories (GE-04–07, MD-05–07, MD-10, ACL-01–05, MCP-06–08) must achieve:
- [ ] Integration test: STEP → clean → decompose produces child shells with correct topology
- [ ] Tab-slot geometry includes kerf offset (verified by inspection + tolerance test)
- [ ] Rivet holes and weld preps register without geometry faults
- [ ] Feature Extractor produces FeatureSet with >90% accuracy on 10 test fixtures
- [ ] Safety filter blocks fire-rated joint types; allows others
- [ ] 100% unit test coverage on Manufacturing Domain rules (MD-05–07, MD-10)

**Gate C → D**: Phase C stories (GE-08–10, MD-11–12, MCP-09–10, MCP-12–13) must achieve:
- [ ] Unfolding (GE-09) succeeds on 10 varied sheet metal designs; K-factors validated ±0.5%
- [ ] Bend sequence validation produces non-colliding sequences for 5 test panels
- [ ] Relief generation detects all internal bend intersections; dogbone/circular both tested
- [ ] Manufacturability scoring (MD-12) flags >95% of rule violations in test suite
- [ ] Integration test: STEP → clean → decompose → tab-slot → unfold all succeed
- [ ] DXF export produces valid 2D wire geometry

**Gate D (MVP)**: Phase D stories (GE-12–14, MD-14–15, MCP-11, MCP-14–16, INF-01, INF-03) must achieve:
- [ ] Nesting (GE-12) achieves >80% material utilization on 3 standard sheet sizes
- [ ] Async export (MCP-14) enqueues job, returns job_id; get_export_job_status polls correctly
- [ ] **Golden-path Integration Test (INF-03)**: STEP → clean → decompose → tab-slot → unfold → nest → DXF **completes end-to-end without errors**
- [ ] Docker image builds; MCP server starts inside container
- [ ] All unit tests (GE, MD, ACL, MCP) pass with >85% code coverage
- [ ] BOM generator (MD-14) produces valid CSV with material costs
- [ ] Assembly instructions (MD-15) generate valid JSON

**Post-MVP (Deferred)**:
- Cloud geometry API integration (D1-B)
- Multi-session concurrency (Constitution VIII)
- 3D bend collision simulation (OQ-03)
- Tenant-specific configuration overlays (Constitution VIII)
- OAuth2 / distributed deployment
- BullMQ/Redis job queue replacement

---

## Project Structure

### Documentation (this feature)

```text
specs/001-align-specification/
├── spec.md                      # Feature specification (authoritative requirements)
├── plan.md                       # This file (implementation plan)
├── research.md                   # Phase 0 output (unknowns resolved)
├── data-model.md                 # Phase 1 output (entity definitions)
├── quickstart.md                 # Phase 1 output (dev setup)
├── contracts/
│   ├── geometry-port.md          # C++ ↔ TypeScript NAPI boundary
│   ├── manufacturing-port.md     # Manufacturing Domain interface
│   └── mcp-tools.md              # Tool schemas (already in Engineering-Design §3)
├── checklists/
│   └── requirements.md           # Quality gate checklist (existing)
└── tasks.md                      # Phase 2 output (actionable tasks with deps)
```

### Source Code (repository root)

```text
# C++ Geometry Engine + NAPI Addon

cpp/
├── CMakeLists.txt               # Root CMake build
├── vcpkg.json                   # vcpkg manifest (OCCT 7.8.1, libnest2d pinned)
├── src/
│   ├── geometry/
│   │   ├── geometry_service.hpp  # Facade/port interface
│   │   ├── geometry_service.cc   # OCCT wrapper implementation
│   │   ├── topology_graph.hpp    # Face/edge adjacency data structure
│   │   ├── unfold.hpp            # Unfolding logic (CadQuery or custom)
│   │   ├── nesting.hpp           # libnest2d integration
│   │   └── [other geometry modules]
│   └── napi/
│       ├── addon.cc              # NAPI module entry point
│       ├── geometry_binding.cc   # TypeScript ↔ C++ geometry serialization
│       └── CMakeLists.txt        # NAPI addon build via cmake-js
├── tests/
│   ├── fixtures/                 # Test STEP files, known-good geometries
│   ├── geometry_test.cc          # Catch2 unit tests for GE-*
│   ├── nesting_test.cc           # libnest2d integration tests
│   └── feature_extractor_test.cc # ACL unit tests
└── docker/
    ├── Dockerfile               # Multi-stage: OCCT builder, app builder
    └── .dockerignore

# TypeScript MCP Server + Manufacturing Domain

ts/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                 # MCP server entry point
│   ├── mcp/
│   │   ├── resources.ts         # Resource (context://, logistics://, manufacturing://, geometry://)
│   │   ├── tools.ts             # Tool dispatch (clean_geometry, decompose_volume, etc.)
│   │   └── errors.ts            # Structured error model
│   ├── manufacturing/
│   │   ├── material.ts          # Material inventory, K-factor, bend allowance
│   │   ├── tooling.ts           # Press brake specs, tonnage estimation
│   │   ├── rules.ts             # Min hole, flange, kerf validators
│   │   ├── rules_engine.ts      # Rule aggregation, manufacturability score
│   │   ├── feature.ts           # Feature definitions (Bend, Hole, Flange, Relief)
│   │   ├── bom.ts               # BOM generation
│   │   └── assembly.ts          # Assembly instruction generator
│   ├── geometry/
│   │   ├── binding.ts           # NAPI addon loader + wrapper
│   │   ├── session.ts           # Session state, rollback token management
│   │   └── jobs.ts              # Async export job queue
│   └── config/
│       ├── config.yaml          # Static configuration (materials, tooling, logistics, context)
│       └── loader.ts            # Config schema validator + YAML parsing
├── tests/
│   ├── fixtures/                 # JSON fixture data (config, expected outputs)
│   ├── mcp.test.ts              # MCP tool/resource tests
│   ├── manufacturing.test.ts    # Rule engine, BOM, assembly tests
│   ├── integration.test.ts       # End-to-end STEP → DXF flow
│   └── vitest.config.ts
└── .vscode/                      # workspace configuration

root/
├── .github/
│   ├── copilot-instructions.md  # Agent context (points to this plan.md)
│   └── workflows/               # CI/CD (Docker build, test)
├── Architecture.md
├── Engineering-Design.md
├── CLAUDE.md
├── docs/
│   ├── OCCT_STABILITY.md        # Version pinning, facade layer rationale
│   ├── OCCT_VERSION.md          # Current version and upgrade path
│   ├── OCCT_API_USAGE.md        # Documented OCCT surface (what we use)
│   ├── DEVELOPMENT.md           # Local build setup (Docker, cmake-js, Node)
│   └── MVP_SCOPE.md             # Explicit deferred capabilities
└── docker-compose.yml           # Local dev environment
```

---

## Complexity Tracking

**No violations requiring justification.** All four bounded contexts, NAPI interop, and technology stack decisions are justified by:
1. **Geometry Engine (C++)**: OCCT is native C++; NAPI provides zero-copy topology access
2. **Manufacturing Domain (TypeScript)**: JSON-centric rules, excellent async/scheduling semantics
3. **NAPI Interop**: Avoids expensive serialization of large topology graphs; matches single-session architecture
4. **Async Export**: Prevents MCP timeout on long-running DXF generation; required by Spec FR-005

---

## Phase 0: Research

**Objective**: Resolve all NEEDS CLARIFICATION items from Technical Context. All items are resolved in this plan.

### Research Task: OCCT API Stability & Build Toolchain

**Unknown**: How well does OCCT v7.8.1 handle complex STEP geometries without crashes? What are the known-brittle operations?

**Approach**:
1. Review OCCT 7.8.1 release notes; identify API changes since 7.7.x
2. Spike GE-01, GE-02, GE-03 with 10 real STEP files (varying complexity)
3. Run under AddressSanitizer to detect memory corruption
4. Document findings in `docs/OCCT_STABILITY.md`

**Decision**: OCCT stability mitigations defined in Engineering-Design §1. Facade layer isolates API churn. Wrapped exceptions ensure no crashes leak to MCP layer.

**Outcome**: `docs/OCCT_STABILITY.md`, pinned OCCT version in `vcpkg.json`, GE-01/02/03 spike test suite.

---

### Research Task: libnest2d Integration Pattern

**Unknown**: How to bind libnest2d (C++ header-only lib) into NAPI addon? What is the polygon extraction workflow?

**Approach**:
1. Survey libnest2d documentation; study examples
2. Prototype polygon extraction from UnfoldId DXF geometry
3. Verify nesting algorithm output against manual test case
4. Estimate performance on 10-part layouts

**Decision**: libnest2d selected (Engineering-Design OQ-02). Direct C++ linkage via CMake. Nesting stays in Geometry Engine context; Manufacturing Domain supplies constraints (sheet size, grain direction).

**Outcome**: `cpp/src/geometry/nesting.hpp` skeleton, integration test (GE-12 spike).

---

### Research Task: NAPI Build Toolchain Maturity

**Unknown**: Can cmake-js reliably cross-compile NAPI addons with OCC + libnest2d dependencies?

**Approach**:
1. Set up cmake-js project with simple C++ binding
2. Test compilation on Linux (Ubuntu 22.04) and macOS
3. Verify addon loads in Node.js; test performance
4. Document in `DEVELOPMENT.md`

**Decision**: NAPI + cmake-js is stable for MVP. Multi-stage Docker reduces build time by caching OCCT layer.

**Outcome**: `cpp/src/napi/CMakeLists.txt`, Docker build validation, `DEVELOPMENT.md` setup guide.

---

### Research Task: CadQuery Sheet Metal Unfold Sufficiency

**Unknown**: Does CadQuery's sheet metal extension (or OCC's BRepOffsetAPI_MakeFlatFace) handle complex bends correctly?

**Approach**:
1. Test 5 varied sheet metal designs (simple flanges, complex multi-bend panels)
2. Compare unfolded dimensions against manual calculation
3. Assess accuracy; identify failure modes
4. If CadQuery insufficient, spike custom unfold heuristic

**Decision**: CadQuery unfold assumed sufficient for MVP (Engineering-Design OQ-01). If validation drift appears, implement custom unfold post-MVP.

**Outcome**: `tests/fixtures/unfold_test_*.stp`, unfold accuracy report in GE-09 spike.

---

### Research Task: Async Export Job Contract Stability

**Unknown**: Will in-process Promise queue be sufficient for MVP export loads? Does the job lifecycle design support future BullMQ migration?

**Approach**:
1. Design job interface (jobId, status, result) for future queue abstraction
2. Prototype in-process queue implementation
3. Load test: 20 concurrent jobs, verify no state corruption
4. Verify BullMQ migration path is viable

**Decision**: In-process Promise queue confirmed for MVP (Engineering-Design OQ-06). Interface designed for future replacement.

**Outcome**: `ts/src/geometry/jobs.ts` interface definition, load test results.

---

**Phase 0 Outcome**: All NEEDS CLARIFICATION resolved. No remaining unknowns block Phase 1 design.

---

## Phase 1: Design & Contracts

### Data Model

**File**: `data-model.md` (to be generated)

**Entities**:

#### Geometry Registry

```typescript
// Solid/Shell/UnfoldId/NestId are opaque string identifiers
type SolidId = string;        // Loaded from STEP; immutable
type ShellId = string;        // Extracted from solid faces; mutable (operations register new shells)
type UnfoldId = string;       // Derived from shell via apply_unfold; immutable
type NestId = string;         // Derived from unfold collection via simulate_nesting; immutable

interface Solid {
  id: SolidId;
  boundingBox: { x: number; y: number; z: number }; // mm
  volumeMm3: number;
  surfaceAreaMm2: number;
  isManifold: boolean;
  topologyGraph: TopologyGraph;
}

interface Shell {
  id: ShellId;
  parentSolidId: SolidId;
  faceIds: FaceId[];
  topologyGraph: TopologyGraph;
  isBoundary: boolean; // true if extracted from solid boundary; false if derived
}

interface TopologyGraph {
  faceCount: number;
  edgeCount: number;
  vertexCount: number;
  faces: Face[];
  edges: Edge[];
  adjacencies: Adjacency[]; // Face-Face relationships
}

interface Face {
  faceId: string;
  surfaceType: 'planar' | 'cylindrical' | 'spherical' | 'other';
  normalVector: [number, number, number];
  boundaryEdges: string[]; // EdgeIds
  area: number;
}

interface Edge {
  edgeId: string;
  startVertex: [number, number, number];
  endVertex: [number, number, number];
  length: number;
  curveType: 'linear' | 'circular' | 'elliptic' | 'other';
  dihedralAngle?: number; // radians; null if open edge
}

interface UnfoldedPanel {
  id: UnfoldId;
  parentShellId: ShellId;
  flatWidthMm: number;
  flatHeightMm: number;
  bendCount: number;
  totalBendDeductionMm: number;
  kFactorUsed: number;
  dxfWireGeometry: string; // DXF entities as text; serializable
}

interface NestLayout {
  id: NestId;
  sheetsRequired: number;
  utilisationPct: number;
  offcutAreaMm2: number;
  layouts: SheetLayout[]; // One per sheet
}

interface SheetLayout {
  sheetMaterialId: string;
  unfoldPlacements: { unfoldId: UnfoldId; x: number; y: number; rotation: number }[];
}
```

#### Snapshot Registry (Rollback)

```typescript
interface GeometrySnapshot {
  snapshotId: string;
  timestamp: number; // Unix ms
  solids: Map<SolidId, Solid>;
  shells: Map<ShellId, Shell>;
  unfolds: Map<UnfoldId, UnfoldedPanel>;
  nests: Map<NestId, NestLayout>;
  description: string; // "After decompose", "After tab-slot", etc.
}

type RollbackToken = string; // Opaque reference to snapshotId
```

#### Manufacturing Domain

```typescript
interface MaterialSpec {
  materialId: string;
  name: string; // e.g. "Mild Steel 1.5mm"
  gaugeMm: number;
  kFactor: number;
  grainDirection: 'rolling' | 'cross' | 'none';
  sheetWidthMm: number;
  sheetLengthMm: number;
  costPerKgEstimate?: number; // Optional; null if not configured
}

interface ToolingCapability {
  maxTonnage: number;
  maxBendLengthMm: number;
  vDieWidthsMm: number[];
  minPunchRadiusMm: number;
}

interface LogisticsConstraints {
  maxShippingLength: number;
  maxShippingWidth: number;
  maxShippingHeight: number;
  maxWeightKg: number;
  maxCoatingLength?: number; // Powder coat oven limits
  coatingProcess?: 'powder_coat' | 'anodise' | 'zinc_plate' | 'none';
}

interface EnvironmentalContext {
  fireRated: boolean;
  marineGrade: boolean;
  highVibration: boolean;
  ipRating?: string; // e.g. "IP65"
}

// Features extracted by ACL
interface Bend {
  featureId: string;
  parentShellId: ShellId;
  angleDeg: number;
  radiusMm: number;
  lengthMm: number;
  direction: 'up' | 'down';
}

interface Hole {
  featureId: string;
  diameterMm: number;
  centerXMm: number;
  centerYMm: number;
}

interface Flange {
  featureId: string;
  widthMm: number;
  lengthMm: number;
}

interface FeatureSet {
  shellId: ShellId;
  bends: Bend[];
  holes: Hole[];
  flanges: Flange[];
}

// Validation & Scoring
interface ValidationResult {
  pass: boolean;
  violations: RuleViolation[];
  message: string;
}

interface RuleViolation {
  ruleCode: string; // e.g. "MIN_HOLE_DIAMETER"
  severity: 'error' | 'warning';
  featureId?: string;
  message: string;
}

interface ManufacturabilityScore {
  score: number; // 0.0–1.0
  violations: RuleViolation[];
  pass: boolean; // true if no error-level violations
}
```

#### MCP Session State

```typescript
interface SessionState {
  sessionId: string;
  startedAt: number; // Unix ms
  geometry: GeometrySnapshot; // Current active state
  snapshotHistory: GeometrySnapshot[]; // For rollback
  exportJobs: Map<string, ExportJob>; // job_id → job
  configuration: {
    materials: MaterialSpec[];
    tooling: ToolingCapability;
    logistics: LogisticsConstraints;
    environmental: EnvironmentalContext;
  };
}

interface ExportJob {
  jobId: string;
  nestId: NestId;
  outputDir: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  acceptedAt: string; // ISO-8601 UTC
  startedAt?: string;
  finishedAt?: string;
  progressPct: number; // 0–100
  errorMessage?: string;
  resultFiles?: ExportFile[];
}

interface ExportFile {
  type: 'dxf' | 'step' | 'bom' | 'assembly_instructions';
  path: string; // Absolute file path
}

interface ExportResult {
  jobId: string;
  files: ExportFile[];
  partCount: number;
  totalMaterialCostEstimate?: number; // Null if not configured
}
```

---

### Contracts

**File**: `contracts/` (to be generated)

#### NAPI Boundary: C++ ↔ TypeScript

**File**: `contracts/geometry-port.md`

```typescript
// TypeScript side (calls C++ via NAPI)

interface GeometryPort {
  // Ingestion
  loadStep(filePath: string): { solidId: SolidId; boundingBox; isManifold: boolean };
  exportStep(solidId: SolidId, filePath: string): void;
  exportDxf(unfoldId: UnfoldId, filePath: string): void;

  // Analysis
  getTopology(solidId: SolidId): TopologyGraph;
  checkManifold(solidId: SolidId): { isManifold: boolean; nonManifoldEdges: number };
  healGeometry(solidId: SolidId, toleranceMm: number): { healed: boolean; healedEdges: number; healedFaces: number };

  // Decomposition
  booleanCut(solidId: SolidId, plane: { nx: number; ny: number; nz: number; d: number }): ShellId[];
  extractShell(solidId: SolidId, faceIds: string[]): ShellId;

  // Sheet Metal
  addCornerRelief(shellId: ShellId, edgeId: string, reliefType: 'dogbone' | 'circular', radiusMm: number): ShellId;
  addTabSlot(shellA: ShellId, shellB: ShellId, clearanceMm: number): { shellA: ShellId; shellB: ShellId };
  unfold(shellId: ShellId, kFactor: number): { unfoldId: UnfoldId; flatWidthMm: number; flatHeightMm: number; dxfWireGeometry: string };

  // Nesting
  nest(unfoldIds: UnfoldId[], materialId: string, rotationStepDeg: number): { nestId: NestId; sheetsRequired: number; utilisationPct: number };

  // Snapshot management
  createSnapshot(description: string): RollbackToken;
  restoreSnapshot(rollbackToken: RollbackToken): SolidId[];
  clearSnapshots(): void;
}
```

**NAPI Serialization**:
- Topology graph: serialize Face, Edge, Adjacency arrays as JSON; minimize for large graphs
- DXF wire geometry: store as text string (compact; serializable)
- Geometry IDs: opaque strings (UUIDs or sequential integers)
- Floating-point: 64-bit double; tolerance 0.01 mm for coordinates, 0.5° for angles

**Error Handling**:
- C++ exceptions caught at NAPI boundary; thrown as JavaScript Error with code + message fields
- Examples: "GEOMETRY_NOT_MANIFOLD", "GEOMETRY_ENGINE_FAULT"

---

#### Manufacturing Domain Interface

**File**: `contracts/manufacturing-port.md`

```typescript
interface ManufacturingPort {
  // Material & Tooling Queries
  getMaterial(materialId: string): MaterialSpec | null;
  getTooling(): ToolingCapability;
  getLogistics(): LogisticsConstraints;
  getEnvironmentalContext(): EnvironmentalContext;

  // Feature Validation
  validateBend(bend: Bend, material: MaterialSpec): ValidationResult;
  validateHole(hole: Hole, material: MaterialSpec): ValidationResult;
  validateFlange(flange: Flange, tooling: ToolingCapability): ValidationResult;

  // Manufacturability
  scorePanel(featureSet: FeatureSet, material: MaterialSpec): ManufacturabilityScore;
  validateBendSequence(bends: Bend[], tooling: ToolingCapability): { valid: boolean; suggestedSequence: string[] };

  // Constraint Enforcement
  isJointTypeAllowed(jointType: 'tab_slot' | 'rivet' | 'weld_prep' | 'adhesive', context: EnvironmentalContext): boolean;
  computeKerfOffset(process: 'laser' | 'waterjet'): number; // mm

  // K-Factor & Bend Allowance
  computeKFactor(material: MaterialSpec, bendRadiusMm: number): number;
  computeBendAllowance(bend: Bend, kFactor: number): number; // mm
}
```

**Implementation Details**:
- All rules defined in `ts/src/manufacturing/rules.ts`
- Configuration loaded from `config.yaml` via `ConfigLoader`
- Deterministic: same inputs → same outputs; no randomness

---

#### MCP Tool Schemas

**File**: `contracts/mcp-tools.md`

*Already fully defined in Engineering-Design.md §3.3. Reference that document for:*
- `clean_geometry`
- `decompose_volume`
- `synthesize_joints`
- `generate_reliefs`
- `apply_unfold`
- `simulate_nesting`
- `evaluate_manufacturability`
- `validate_bend_sequence`
- `export_production_pack`
- `get_export_job_status`
- `get_export_job_result`
- `rollback`
- Error model & codes

---

### Quickstart: Local Development Setup

**File**: `quickstart.md` (to be generated)

#### Prerequisites

- Docker (latest)
- Node.js 22.x LTS
- Git

#### One-Command Setup

```bash
# Clone and navigate
git clone <repo>
cd mcp-cad

# Build Docker image (caches OCCT build)
docker build -t mcp-cad:latest -f docker/Dockerfile .

# Start container with volume mount
docker run -it --rm -v $(pwd):/workspace mcp-cad:latest

# Inside container: install TypeScript deps
cd ts && npm install && npm run build

# Start MCP server
npm run start
```

#### Manual Development (Linux/macOS)

```bash
# Install dependencies
sudo apt-get update
sudo apt-get install -y build-essential cmake nodejs npm

# Build OCCT (first time: 90 min; cached after)
mkdir -p cpp/build && cd cpp/build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j8
cd ../../

# Build NAPI addon
cd cpp && npm run build-addon
cd ../

# Build TypeScript
cd ts && npm install && npm run build && npm run start
```

#### Config File

Create `ts/config/config.yaml`:

```yaml
materials:
  - materialId: steel_1.5
    name: "Mild Steel 1.5mm"
    gaugeMm: 1.5
    kFactor: 0.45
    grainDirection: rolling
    sheetWidthMm: 1000
    sheetLengthMm: 2000

tooling:
  maxTonnage: 50
  maxBendLengthMm: 1000
  vDieWidthsMm: [10, 15, 20, 25, 30]
  minPunchRadiusMm: 2.0

logistics:
  maxShippingLength: 1500
  maxShippingWidth: 1000
  maxShippingHeight: 1000
  maxWeightKg: 23

environmental:
  fireRated: false
  marineGrade: false
  highVibration: false
```

#### Testing

```bash
# C++ unit tests
cd cpp && npm run test

# TypeScript tests
cd ts && npm test

# Integration test (STEP → DXF)
npm run test:integration
```

#### Next Steps

- Consult `DEVELOPMENT.md` for detailed debugging
- See `Architecture.md` for system overview
- Refer `Engineering-Design.md` for bounded context responsibilities

---

## Implementation Roadmap

**Task dependency ordering** (derived from Engineering-Design §5):

### Phase A: Foundation (Week 1)

**Gate Criteria**: See Gates & Sequencing section above.

| Task | ID | Size | Story | Dependencies |
|------|----|----|-------|--------------|
| T1 | GE-01 | S | STEP import pipeline | — |
| T2 | GE-02 | M | Topology analysis | GE-01 |
| T3 | GE-03 | M | Manifold check + heal | GE-02 |
| T4 | MD-01 | S | Material inventory store | — |
| T5 | MD-02 | S | Tooling capability store | — |
| T6 | MD-03 | S | Logistics constraints | — |
| T7 | MD-04 | S | Environmental context | — |
| T8 | MCP-01 | M | MCP server scaffold (stdio) | — |
| T9 | MCP-02 | M | Static resources (context, logistics, manufacturing, geometry) | MD-01–04 |

**Risk Flags**: 
- 🟡 **GE-02**: OCC topology traversal on complex geometries may have unexpected behavior; mitigation: test on 10 fixture files
- 🟡 **MCP-01**: NAPI addon build chain requires cmake-js setup; mitigation: `DEVELOPMENT.md` provides step-by-step guide

**Acceptance**:
- All 9 stories pass unit tests
- MCP server starts; serves static resources
- Docker build succeeds on first attempt
- 0 unhandled exceptions in test suite

---

### Phase B: Core Tools (Weeks 2–3)

**Gate**: Phase A must pass before starting.

| Task | ID | Size | Story | Dependencies |
|------|----|----|-------|--------------|
| T10 | GE-04 | M | Boolean cut decomposition | GE-03 |
| T11 | GE-05 | L | Tab-and-slot geometry (with kerf) | GE-04 |
| T12 | GE-06 | S | Rivet hole generation | GE-04 |
| T13 | MD-05 | S | K-factor & bend allowance | — |
| T14 | MD-06 | S | Min hole diameter validator | — |
| T15 | MD-07 | S | Min flange width validator | — |
| T16 | MD-10 | S | Joint type safety filter | MD-04 |
| T17 | ACL-01 | M | Face classification | GE-02 |
| T18 | ACL-02 | M | Edge classification → bends | GE-02 |
| T19 | ACL-03 | M | Hole detection | ACL-01 |
| T20 | ACL-04 | M | Flange detection | ACL-01 |
| T21 | ACL-05 | S | Compose FeatureSet | ACL-03, ACL-04 |
| T22 | MCP-06 | S | Tool: clean_geometry | MCP-02, GE-03 |
| T23 | MCP-07 | M | Tool: decompose_volume (strategy dispatch) | MCP-02, GE-04, MD-06, MD-07 |
| T24 | MCP-08 | M | Tool: synthesize_joints (safety filter) | MCP-02, GE-05, MD-10 |

**Risk Flags**: 
- 🔴 **GE-05**: Tab-slot with kerf offset is geometrically complex; highest risk in Phase B. Mitigation: spike with simple test case first; verify boolean cut succeeds before registering shell.
- 🟡 **ACL-01–05**: Feature extraction heuristics may not generalize; mitigation: extensive fixture testing; document edge cases
- 🟡 **MCP-07**: Decomposition strategy dispatch lives in MCP layer (orchestration policy); ensure Manufacturing Domain rules are called correctly

**Acceptance**:
- Integration test: STEP → clean → decompose produces child shells with correct topology
- Tab-slot geometry includes kerf offset (tolerance ±0.05 mm)
- Feature Extractor >90% accurate on 10 test fixtures
- Safety filter blocks fire-rated joint types
- 100% unit test coverage on Manufacturing Domain rules
- All Phase A tests still pass

---

### Phase C: Sheet Metal (Weeks 4–5)

**Gate**: Phase B must pass before starting.

| Task | ID | Size | Story | Dependencies |
|------|----|----|-------|--------------|
| T25 | GE-08 | M | Corner relief generation | GE-02, MD-06 |
| T26 | GE-09 | L | Sheet metal unfold (CadQuery or OCC) | GE-03, MD-05 |
| T27 | GE-10 | M | DXF export of flat patterns | GE-09 |
| T28 | MD-11 | M | Bend sequence validator (rule-based MVP) | MD-02 |
| T29 | MD-12 | M | Manufacturability scorer | MD-06–08, MD-10 |
| T30 | MCP-09 | S | Tool: generate_reliefs | GE-08, MCP-02 |
| T31 | MCP-10 | S | Tool: apply_unfold | GE-09, MD-05, MCP-02 |
| T32 | MCP-12 | M | Tool: evaluate_manufacturability | ACL-05, MD-12, MCP-02 |
| T33 | MCP-13 | M | Tool: validate_bend_sequence | GE-02, MD-11, MCP-02 |

**Risk Flags**: 
- 🔴 **GE-09**: Sheet metal unfolding is highest geometric risk (OCC API may fail on complex bends). Mitigation: spike with 5 test designs; if CadQuery insufficient, implement fallback heuristic.
- 🟡 **MD-11**: Simplified rule-based bend sequence may have false positives; mitigation: extensive test suite; clearly document assumptions
- 🟡 **MCP-12–13**: These tools depend on ACL-05 output; ensure feature extraction accuracy is validated in Phase B

**Acceptance**:
- Unfolding succeeds on 10 varied sheet metal designs; K-factors within ±0.5% of manual calculation
- Bend sequence validation produces non-colliding sequences
- Relief generation detects all internal bend intersections
- Manufacturability scoring flags >95% of rule violations in test suite
- Integration test: STEP → clean → decompose → tab-slot → unfold (no nesting yet)
- All Phase A–B tests still pass

---

### Phase D: Production Output + MVP (Weeks 6–8)

**Gate**: Phase C must pass before starting.

| Task | ID | Size | Story | Dependencies |
|------|----|----|-------|--------------|
| T34 | GE-12 | L | Nesting integration (libnest2d) | GE-10 |
| T35 | GE-13 | S | SVG nest preview generation | GE-12 |
| T36 | GE-14 | M | Snapshot + rollback registry | GE-01 through GE-13 |
| T37 | MD-14 | M | BOM generator | GE-10, MD-01 |
| T38 | MD-15 | M | Assembly instruction generator | ACL-05, GE-04 |
| T39 | MCP-11 | S | Tool: simulate_nesting | GE-12, MD-13, MCP-02 |
| T40 | MCP-14 | M | Tool: export_production_pack (async job dispatch) | MCP-02, GE-13, MD-14, MD-15 |
| T41 | MCP-15 | M | Tool: rollback | GE-14, MCP-02 |
| T42 | MCP-16 | M | Structured error model + propagation | MCP-01–15 |
| T43 | INF-01 | M | Docker image (multi-stage, OCCT build cache) | All Phase A–C |
| T44 | INF-02 | S | Config YAML schema + loader | MD-01–04 |
| T45 | INF-03 | L | **Golden-path Integration Test**: STEP → clean → decompose → tab-slot → unfold → nest → DXF → export job | All GE, MD, ACL, MCP |

**Risk Flags**: 
- 🔴 **GE-12**: libnest2d integration complexity (C++ header-only lib binding, polygon extraction from DXF); mitigation: prototype early in Phase A research
- 🟡 **INF-01**: Docker multi-stage build with OCCT caching is critical for CI efficiency; mitigation: validate layer caching in first build
- 🔴 **INF-03**: Golden-path integration test is MVP acceptance gate; any failure blocks release. Mitigation: Test early and often; use fixture STEP file with known decomposition.

**Acceptance** (MVP Gate):
- **Nesting achieves >80% material utilization on 3 standard sheet sizes**
- **Async export enqueues job; returns job_id; get_export_job_status polls correctly**
- **Golden-path Integration Test (INF-03): STEP → DXF export completes end-to-end without errors**
- Docker image builds; MCP server starts inside container
- All unit tests (GE-*, MD-*, ACL-*, MCP-*) pass with >85% code coverage
- BOM generator produces valid CSV with material costs
- Assembly instructions generate valid JSON
- **All Phase A–C tests still pass**

---

## Milestone & Success Criteria

### MVP Acceptance (End of Phase D)

**Integration Test INF-03: STEP → Production DXF**

**Precondition**: Provide a simple 3-panel sheet metal CAD design (STEP file)

**Steps**:
1. `clean_geometry("test_design.step")` → returns `part_id`, `is_manifold=true`
2. `decompose_volume(part_id, strategy="simplicity", max_panels=5)` → returns 3 `panel_ids`
3. `synthesize_joints([panel_ids[0], panel_ids[1]], joint_type="tab_slot")` → returns updated panel IDs, kerf-compensated
4. `apply_unfold(panel_ids[0], material_id="steel_1.5")` → returns `unfold_id_1` with flat dimensions
5. Repeat step 4 for remaining panels → `unfold_id_2`, `unfold_id_3`
6. `simulate_nesting([unfold_id_1, unfold_id_2, unfold_id_3], material_id="steel_1.5")` → returns `nest_id`, utilisation >80%
7. `export_production_pack(nest_id, output_dir="/tmp/export")` → returns `job_id`, status='queued' or 'running'
8. Poll `get_export_job_status(job_id)` until status='succeeded'
9. Retrieve `get_export_job_result(job_id)` → returns files: [nested_dxf_1.dxf, nested_dxf_2.dxf, bom.csv, assembly.json]
10. Verify:
    - DXF files are valid 2D wire geometry
    - BOM contains 3 parts with material IDs, quantities
    - Assembly instructions are valid JSON with join order

**Success Criteria**:
- ✅ All 10 steps complete without errors
- ✅ DXF geometry is valid (can be opened in CAD tool)
- ✅ Material utilization ≥ 80% (no excessive offcut)
- ✅ Assembly instructions order makes sense (no circular dependencies)
- ✅ Execution time <30 seconds total
- ✅ No memory leaks or crashes under AddressSanitizer

---

### Quality Gates (Phase D)

| Gate | Target | Measurement |
|------|--------|-------------|
| **Unit Test Coverage** | ≥85% | Code coverage report (Vitest + C++ gcov) |
| **Manufacturing Rule Accuracy** | 100% | All MD-* rule validators tested with comprehensive fixtures |
| **Feature Extraction Accuracy** | >90% | ACL-* feature detection on 10 test solids |
| **Geometry Stability** | 0 crashes | All GE-* operations run under AddressSanitizer; 0 memory faults |
| **Unfolding Accuracy** | ±0.5% | K-factor and bend allowance within tolerance on test set |
| **Nesting Utilization** | >80% | Material utilization on 3 standard sheet sizes |
| **Export Performance** | <30 sec | Golden-path end-to-end time <30 seconds |
| **Error Handling** | 100% | All error paths return structured error; 0 unhandled exceptions |

---

## Testing Strategy

### Objectives

1. Prevent regressions across geometry, rules, and MCP orchestration boundaries.
2. Catch high-cost defects early through phase-appropriate testing.
3. Enforce constitution constraints through automated gates, not manual review only.
4. Produce repeatable evidence for MVP acceptance and release readiness.

### Test Levels and Scope

| Level | Primary Scope | Tools | Exit Signal |
|------|---------------|-------|-------------|
| Unit | Deterministic behavior of isolated functions and modules | Catch2 (C++), Vitest (TS) | All tests pass with target coverage in phase gate |
| Contract | Boundary correctness between contexts and interfaces | NAPI binding tests, MCP schema tests | Request/response shape and error contract validated |
| Integration | Multi-step flows across GE, MD, ACL, MCP | Vitest integration suites + STEP fixtures | No orchestration faults on canonical flows |
| End-to-End | Golden path from STEP to production outputs | INF-03 suite | Full path succeeds under time and quality thresholds |
| Non-Functional | Stability, performance, and memory safety | AddressSanitizer, benchmark fixtures | Memory-clean runs and timing targets met |

### Test Distribution by Phase

| Phase | Test Focus | Minimum Required |
|------|------------|------------------|
| Phase 0 | Feasibility and risk spikes | Reproducible findings in research.md with measured outcomes |
| Phase 1 | Contract correctness and scaffolding | Toolchain smoke tests and schema validation |
| Phase A | Core geometry and configuration correctness | GE-01 to GE-03, MD-01 to MD-04, MCP startup/resource tests |
| Phase B | Decomposition, kerf-correct joints, feature extraction | Integration path STEP -> clean -> decompose -> joints |
| Phase C | Unfold accuracy and manufacturability logic | Unfold tolerance, bend-sequence validity, scoring accuracy |
| Phase D | Nesting, async export lifecycle, rollback, release confidence | INF-03 pass plus non-functional gates |

### Test Data Strategy

1. Maintain curated STEP fixtures by complexity tier: simple, medium, stress.
2. Maintain expected-output snapshots for topology counts, feature sets, and nesting utilization bands.
3. Version fixtures with explicit rationale when changed to avoid silent baseline drift.
4. Keep one canonical MVP fixture dedicated to INF-03 to preserve acceptance comparability.

### Environment Matrix

| Dimension | Minimum Matrix |
|----------|----------------|
| Runtime | Ubuntu 22.04 (required), one non-Linux platform for NAPI validation |
| Build Path | Native build and Docker multi-stage build |
| Execution Mode | Local test run and CI pipeline run |
| Toolchain | Pinned OCCT 7.8.1 + pinned Node.js 22.x |

### Gate Enforcement Rules

1. No phase advancement if mandatory tests for current phase fail.
2. Any structured-error regression blocks merge to main branch.
3. Any determinism regression in repeated fixture runs blocks merge.
4. Any memory safety violation in sanitizer runs blocks MVP sign-off.

### CI Cadence

1. On pull request: lint, unit, contract, focused integration.
2. On merge to feature branch: full integration and sanitizer subset.
3. Nightly: full fixture sweep, INF-03 dry run, performance trend capture.
4. Pre-release: complete matrix run, evidence bundle generation, gate review.

### Ownership and Evidence

| Area | Primary Owner | Evidence Artifact |
|------|---------------|-------------------|
| Geometry correctness and stability | Geometry Engine owner | Catch2 reports, sanitizer logs |
| Manufacturing rule accuracy | Manufacturing Domain owner | Vitest reports, rule coverage report |
| MCP contract and orchestration | MCP Protocol owner | Contract test report, integration logs |
| MVP acceptance | Tech lead + QA lead | INF-03 report, performance summary, checklist sign-off |

### Defect Triage Policy

1. Critical: crashes, corruption, wrong manufacturing outcome, contract break.
2. High: deterministic mismatch, gate-blocking performance failure, flaky golden path.
3. Medium: non-blocking integration defect with workaround.
4. Low: documentation mismatch or minor test usability issue.

Critical and high defects must be resolved before phase gate approval.

---

### Post-MVP Roadmap (Deferred)

| Capability | Rationale | Estimated Effort |
|-----------|-----------|------------------|
| **Cloud Geometry API** | Reliance on remote geometry services; trade API latency for reduced local dependencies | Phase E: 2–3 weeks |
| **Multi-Session Concurrency** | Single-session MVP simplifies state and rollback; cloud deployment requires session isolation | Phase E: 3–4 weeks |
| **3D Bend Collision Simulation** | Rule-based MVP sufficient for typical designs; full collision simulation requires tooling geometry CAD | Phase F: 4–6 weeks |
| **Tenant Configuration Overlays** | MVP uses static config.yaml; multi-tenant deployments require config versioning and role-based access | Phase F: 2–3 weeks |
| **OAuth2 / Distributed Deployment** | MVP is stdio + Docker; cloud scales with Kubernetes + service mesh | Phase F: ongoing |
| **BullMQ / Redis Job Queue** | MVP Promise queue sufficient for single-session; cloud export jobs require distributed queue | Phase E: 2 weeks |

---

## Context Update

**Action**: Update `.github/copilot-instructions.md` to reference this plan during the planning workflow.

```markdown
<!-- SPECKIT START -->
**Current Plan**: specs/001-align-specification/plan.md

This plan defines the four-phase implementation roadmap for the "Apply Architecture and Engineering Designs to Specification" feature. Refer to the plan for:
- Technical context (language allocation, dependency decisions)
- Constitutional principles (9 core constraints)
- Phase gates and risk assessment
- Dependency-ordered task breakdown
- MVP acceptance criteria

Before starting implementation, ensure all Phase A foundation stories pass unit tests.
<!-- SPECKIT END -->
```

---

## Summary

This implementation plan consolidates Architecture.md and Engineering-Design.md decisions into a unified roadmap. The four-phase sequence (Foundation → Core Tools → Sheet Metal → Production Output + MVP) balances rapid iteration with risk management. OCCT stability mitigations, NAPI interop design, and explicit async export contract provide clear boundaries for implementation. All 9 constitutional principles are satisfied; no complexity violations require justification.

**Next Steps**:
1. Generate `research.md` (Phase 0 unknowns) — resolved in this plan
2. Generate `data-model.md` (Phase 1 entities)
3. Generate `contracts/` (Phase 1 interface definitions)
4. Generate `quickstart.md` (Phase 1 developer setup)
5. Run `/speckit.tasks` to produce `tasks.md` (Phase 2: actionable work items)


## E2E Stress Testing
- The Braai STL model is validated as a Tier-3 stress test.
- Phase 4 targets enforcing the 'High Heat' environmental logic for testing joint rejection.
