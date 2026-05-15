# End-to-End Test Plan: Complex Assembly (Braai)

**Test ID:** `SYS-JTBD-07`
**Target:** Validate the end-to-end processing of a complex, tessellated mesh (STL) through healing, decomposition, and manufacturing validation under specific environmental constraints.

**Classification:** Post-MVP evaluation scenario (non-gating for INF-03 and MVP acceptance).

## Objective
To prove the system's ability to handle raw, real-world input geometries (unlike clean, predefined B-Rep STEP files) and push them through the entire sheet metal manufacturing pipeline. The "Braai" (barbecue grill) concept inherently introduces complex topologies and high-temperature environmental constraints.

This plan is used to evaluate MVP robustness after the MVP STEP-first scope has passed its acceptance gates.

## Prerequisites
- **Input File:** `Braai.stl` located in `ts/tests/e2e/fixtures/`
- **Environmental Context:** The session must be initialized with a fire-rated context (`context://intent/environmental` -> High Heat / Outdoors).
- **Material:** Standard 3mm Mild Steel.

---

## Execution Phases & Jobs-to-Be-Done (JTBD)

### Phase 1: Ingestion & Validity Analysis
**Objective:** Parse the complex mesh/model, identify distinct bodies, and flag topological defects.
- **MCP Tool:** `clean_geometry` (dry-run/analysis mode)
- **GE Action:** Ingest the STL facet data and convert to B-Rep surfaces. Classify disjoint shells (e.g., grill grate, base chassis, ash tray).
- **ACL Action:** Identify non-manifold edges, self-intersections, and zero-thickness walls common in STLs.
- **Assertion:** System correctly returns a structured error mapping all defective topological areas (`GEOMETRY_NOT_MANIFOLD`).

### Phase 2: Geometry Repair & Healing
**Objective:** Interactively resolve the detected defects to yield a valid solid/shell list.
- **MCP Tool:** `clean_geometry` (heal mode)
- **GE Action:** Run bounding box analysis, close gaps within specified tolerances (`ShapeFix_Shape`), and enforce manifold integrity.
- **Assertion:** Post-heal topology graph shows 100% manifold solids/shells ready for manufacturing operations.

### Phase 3: Manufacturing Decomposition
**Objective:** Split the monolithic/complex bodies into formable 2D sheet metal components.
- **MCP Tool:** `decompose_volume` (Strategy: Logistics or Formability)
- **GE Action:** Execute boolean cuts to separate the continuous model into flat panels & bendable segments.
- **MD Action:** Validate that candidate cuts do not result in geometries that exceed the maximum press brake tonnage or sheet size.
- **Assertion:** The single Braai model successfully segments into an array of strictly valid `ShellId`s.

### Phase 4: Joint Synthesis & Validation
**Objective:** Reconnect the decomposed panels using safe, manufacturable joints suitable for the environment.
- **MCP Tool:** `synthesize_joints`
- **MD Action:** The internal safety filter evaluates joint requests against the High Heat environmental intent.
- **GE Action:** Apply kerf offsets (`0.1-0.2mm`) and construct Tab & Slot boolean logic.
- **Assertion:** Attempted adhesive joints are formally rejected (`JOINT_TYPE_BLOCKED` - Fire rating violation). Tab/slot and weld joints are successfully generated with verified tolerances.

### Phase 5: Manufacturability Validation & Detailing
**Objective:** Ensure the individual parts can be physically bent and cut by the shop floor.
- **MCP Tools:** `generate_reliefs`, `evaluate_manufacturability`
- **ACL Action:** Extract all bends, flanges, and hole features from the decomposed topology.
- **MD Action:** Validate minimum K-factors, check that hole-edge distances won't tear during bending, and verify tonnage constraints.
- **Assertion:** Manufacturability score generates successfully; reliefs are correctly scoped to the material gauge.

### Phase 6: Final Production Sequence
**Objective:** Flat pattern generation, nesting, and CAM export.
- **MCP Tools:** `apply_unfold`, `simulate_nesting`, `export_production_pack`
- **GE Action**: Flatten the 3D sheet metal parts to 2D DXFs and bin-pack them via `libnest2d`.
- **Assertion**: The async export job reaches `succeeded` state, producing an integrated BOM, SVG layout, and DXF pack.
