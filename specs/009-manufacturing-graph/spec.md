# Feature Specification: Manufacturing Graph — Sheet Metal Intent Layer

**Feature Branch**: `009-manufacturing-graph`

**Created**: 2026-06-03

**Status**: Draft

---

## Background

The existing system operates purely in topological terms: B-Rep solids are split
by bends, merged by bend operations, and unfolded. Manufacturing *intent* — which
flat pieces exist, how they relate, and what parameters govern each bend — is never
recorded. When the geometry engine rewrites topology (boolean ops, corner cuts,
UnifySameDomain), the causal chain of fabrication steps is lost and has to be
re-inferred each time.

This feature introduces a **Manufacturing Graph**: a Directed Acyclic Graph (DAG)
that persists the ordered sequence of sheet-metal fabrication steps as a first-class
domain object. The graph is the source of truth for manufacturing intent; the B-Rep
geometry is a derivative output that can be fully regenerated from it.

The Manufacturing Graph integrates with the existing MCP tool surface rather than
replacing it. Existing tools (`splitBodyByBends`, `mergeBodiesWithBend`,
`unfoldShell`, `fuseBodies`) remain the geometric executors; the graph layer records
intent, enforces ordering, drives flat-pattern computation, and enables design rule
validation before heavy geometric work is triggered.

Every mutation to the Manufacturing Graph — adding a node, changing a parameter,
or removing a connection — marks the affected node and all of its downstream
dependents as **dirty** (stale). The dirty state is visible to callers via the
graph query. No geometry is recalculated at that moment.

Geometry is recalculated by an explicit **Geometry Solve**: a single operation
that traverses every dirty node in the graph in topological order and re-executes
the corresponding geometric operations, then clears the dirty flag. The Solve runs
once at the end of a user action — not once per mutation. A user action that
touches 100 nodes triggers exactly one Solve pass, not 100. Callers are responsible
for initiating the Solve at the appropriate boundary (e.g., after all mutations in
a batch are complete). High-level action tools (bootstrap, `add_bend`, `add_join`,
`add_cut`, `update_node`) invoke the Solve automatically at the end of their own
execution so that single-step callers need not call it explicitly. Callers that
batch multiple mutations via the transaction primitive MUST call `solve_geometry`
explicitly before reading body IDs or flat-pattern results.

Body IDs issued before a Solve are valid until the next Solve that regenerates
their node. After a Solve, superseded body IDs are invalidated; the updated IDs
are returned in the Solve result.

Three types of panel-to-panel relationship are modelled:

- **Bend join**: two panels meet at a non-zero bend angle (any angle 1°–179°). The
  junction is a cylindrical zone; bend allowance shrinks the flat pattern.
- **Flat extension (union merge)**: two panels are fused into a single larger flat
  section. Minor geometric noise in the source bodies — slight gaps, very shallow
  angles (< 1°), or sub-millimetre misalignment — is absorbed and the combined
  region is treated as a single planar face. No bend allowance applies.
- **Mechanical join**: two panels are connected by a physical fastening feature
  (flange, tab-and-slot, rivet hole pattern, weld prep) rather than by bending the
  material itself. The panels remain independently flat; the joining feature is
  modelled as a `JoinNode`.

This is positioned as **Phase 2** of the Semantic CAD MCP roadmap, building on
`004-transaction-primitive` (prerequisite) and running in parallel with
`005-semantic-mapping-layer`.

---

## Clarifications

### Session 2026-06-03

- Q: Should `remove_node` be a first-class mutation tool, or should node removal only be achievable via transaction rollback? → A: `remove_node` is a first-class graph mutation (Option A) — deletes any node type, marks downstream nodes dirty, runs DRC, and invokes the Geometry Solve automatically for single-step callers, consistent with all other mutation tools.
- Q: What format should graph node IDs take, and do they persist across Geometry Solves? → A: Two distinct ID spaces. Graph node IDs are caller-supplied human-readable strings (e.g., `"panel-top"`, `"bend-flange-left"`); they are stable and never change, including across Geometry Solves. Geometry body IDs are server-generated UUIDs, opaque to the user, not surfaced in the UI, and are volatile (replaced on each Geometry Solve that regenerates the node). The Manufacturing Graph is the stable identity layer; B-Rep body IDs are implementation detail.
- Q: Which fields are mutable via `update_node` — parameters only, or also structural references and node ID? → A: All fields are mutable (Option A). This includes structural panel references, node ID rename, and the full profile shape of a `CutNode` (including FREEFORM profiles defined by an arbitrary ordered vertex list). Every `update_node` call re-runs DRC and marks affected downstream nodes dirty before invoking the Geometry Solve.
- Q: What is the latency target for `solve_geometry` on a large graph? → A: Fixed ceiling — `solve_geometry` on a graph with up to 100 dirty nodes MUST complete in under 3 seconds.
- Q: How should the Manufacturing Graph survive MCP server restarts or crashes? → A: Persistence is deferred entirely to a future dedicated specification. This increment documents the in-memory loss risk as a known limitation; no export, import, or auto-save mechanism is introduced here.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Bootstrap graph from an imported CAD model (Priority: P1)

A user imports a raw STEP file representing a folded sheet-metal part. They want the
system to automatically recognise the panels and bends, and to expose a structured
manufacturing graph they can inspect and build on — without any manual annotation.

**Why this priority**: This is the entry point. Every other story depends on a
populated graph. It exercises the full pipeline from STEP ingest to DAG
construction and makes the graph visible to the caller.

**Independent Test**: Import a known STEP file (e.g., `braai.step` or `testcube.step`),
call the bootstrap tool, then query the graph. The response must list one `PanelNode`
per flat section and one `BendNode` per bend zone, with thickness and bend-radius
attributes populated.

**Acceptance Scenarios**:

1. **Given** a STEP file with two flat sections joined by a 90° bend, **When** the
   bootstrap tool is called, **Then** the graph contains two `PanelNode` entries and
   one `BendNode` linking them, with the detected bend angle, inner radius, and
   K-factor derived from material defaults.

2. **Given** a STEP file with two flat sections joined at 45°, **When** the
   bootstrap tool is called, **Then** the `BendNode` records a bend angle of 45°
   (not 90°), and the bend-allowance formula uses the actual angle in its
   calculation.

3. **Given** a STEP file with three panels and two bends (L + T shape), **When**
   the bootstrap tool is called, **Then** all three `PanelNode` entries and both
   `BendNode` entries are present with edges encoding the correct panel-to-bend
   adjacency.

4. **Given** the bootstrap has run, **When** the graph is queried, **Then** every
   `PanelNode` references the geometry body ID it was initialised from, enabling
   bidirectional traceability.

---

### User Story 2 — Add a bend operation and get an updated flat pattern (Priority: P1)

An AI agent is composing a multi-panel enclosure. It has already bootstrapped two
panels. It issues a command to join them at a specified bend angle (e.g. 90°, 45°,
or 135°). The system appends a `BendNode` to the graph, validates it, executes the
merge geometry, and returns the updated flat-pattern dimensions — all as a single,
atomic step.

**Why this priority**: This is the primary operation loop. Joining panels by bends is
the core daily workflow; the graph makes it auditable and reproducible.

**Independent Test**: Start from two disconnected `PanelNode` entries; call
`add_bend`; verify: (a) a `BendNode` appears in the graph linking the two panels,
(b) the underlying geometry is merged (solid exists in registry), (c) the flat-
pattern length matches the standard bend-allowance formula.

**Acceptance Scenarios**:

1. **Given** two `PanelNode` entries in the graph with a known thickness and K-factor,
   **When** `add_bend` is called with inner radius 1 mm and angle 90°, **Then** the
   resulting flat pattern length equals the sum of both panel flat lengths plus the
   calculated bend allowance (BA = π/2 × (R + K × T)), within 0.5 mm tolerance.

2. **Given** the same two panels, **When** `add_bend` is called with angle 45°,
   **Then** BA = π/4 × (R + K × T) and the flat pattern length reflects that smaller
   allowance, within 0.5 mm tolerance.

3. **Given** the same setup, **When** the operation is rolled back via the transaction
   primitive (from `004-transaction-primitive`), **Then** the graph reverts to its
   pre-bend state and the merged solid is removed from the geometry registry.

4. **Given** a graph with one `BendNode` already present, **When** a second `add_bend`
   creates a structural cycle in the DAG, **Then** the system rejects the operation
   with a `MANUFACTURING_GRAPH_CYCLE_DETECTED` error before any geometry is touched.

---

### User Story 2b — Union merge of coplanar panels treats result as a single flat section (Priority: P1)

A user fuses two coplanar sheet-metal sections into a single larger panel using
`fuseBodies` (union merge, no bend). The merged body may have sub-millimetre gaps,
very shallow angle mismatches, or minor surface irregularities from boolean
operations. The Manufacturing Graph must record this as a single `PanelNode` with
the combined flat extent — not as two panels with a bend between them.

**Why this priority**: Union merges are used constantly (e.g. adding a protrusion or
extension to an existing panel). If the graph misclassifies them as a near-zero bend,
the flat pattern gains a spurious, near-zero bend allowance and the DXF is wrong.

**Independent Test**: Fuse two coplanar rectangular bodies with a 0.2 mm gap between
them. Call the bootstrap (or update) tool. Verify the graph records one `PanelNode`
spanning the combined extent, with no `BendNode` between them.

**Acceptance Scenarios**:

1. **Given** two bodies that are coplanar within 1°, **When** they are merged via
   union and the graph is updated, **Then** a single `PanelNode` is recorded with
   flat dimensions equal to the combined bounding box, and no `BendNode` is created.

2. **Given** two bodies with a 0.3 mm gap at their shared edge (manufacturing
   tolerance), **When** they are merged, **Then** the graph absorbs the gap and the
   recorded flat width equals the outer-to-outer extent of the combined body.

3. **Given** two bodies whose shared edge has a 0.5° angular deviation (surface
   flatness tolerance), **When** they are merged, **Then** the system treats the
   combined result as a flat panel; no bend allowance is deducted.

4. **Given** two bodies at a genuine 10° angle to each other, **When** they are
   merged, **Then** the graph records a `BendNode` with angle 10° (not a flat
   extension), because the deviation exceeds the coplanarity threshold.

---

### User Story 3 — Flat pattern generated from graph traversal, not topology inference (Priority: P2)

A fabricator requests the DXF cutting profile for an assembly. Instead of re-inferring
bend angles and K-factors from the B-Rep each time, the system traverses the
Manufacturing Graph and uses the stored bend parameters to compute bend allowances
directly.

**Why this priority**: This decouples flat-pattern accuracy from topological inference
quality. Bugs in geometry recognition (e.g., 1.45 mm panels from 1 mm walls) cannot
corrupt bend allowances that are stored explicitly in the graph.

**Independent Test**: Construct a graph manually with two panels and one `BendNode`
(explicit BA parameters), then call the DXF export tool. Verify the DXF outline width
equals `panelA_flat + BA + panelB_flat` to within 0.5 mm, and that a dashed centre-
line annotation marks the bend zone.

**Acceptance Scenarios**:

1. **Given** a graph with explicit K-factor = 0.33, R = 1 mm, T = 1 mm, angle = 60°,
   **When** the flat pattern is requested, **Then** the DXF bend zone is annotated at
   the position computed by the BA formula (BA = π/3 × (R + K × T)), regardless of
   any topological ambiguity in the underlying solid.

2. **Given** a graph with three panels and two bends in sequence, **When** the flat
   pattern is requested, **Then** the DXF spans all three flat regions with two dashed
   bend-zone lines at the correct offsets.

---

### User Story 3b — Add flanges or mechanical joining features between panels (Priority: P2)

A designer needs to join two panels that cannot be bent together — either because
the assembly sequence prevents it (foldability violation), or because the joint
requires mechanical fastening for field disassembly. They add a `JoinNode` to the
graph describing the feature: a flange, tab-and-slot, rivet hole pattern, or weld
prep. The system records the join intent, adds the corresponding geometry to both
affected panels, and includes the feature footprint in the flat pattern.

**Why this priority**: Mechanical joins are a first-class fabrication intent. If
they are not modelled in the graph, their cut-out geometry (rivet holes, tabs,
slots) will be absent from the DXF cutting profile.

**Independent Test**: Create two panels in the graph. Call `add_join` with type
`TAB_SLOT` and a specified edge. Verify: (a) a `JoinNode` appears in the graph
linking both panels, (b) the flat pattern for each panel includes the tab or slot
cutout geometry, (c) no `BendNode` is created.

**Acceptance Scenarios**:

1. **Given** two panels that share an adjacent edge in the graph, **When**
   `add_join` is called with type `RIVET_PATTERN` and a row spacing of 25 mm,
   **Then** the DXF for each panel includes the rivet hole positions along the
   shared edge at the specified spacing.

2. **Given** two panels flagged as `INACCESSIBLE` for press-brake bending (from the
   foldability check), **When** `add_join` is called instead of `add_bend`, **Then**
   the operation succeeds: the graph records a `JoinNode`, the foldability flag is
   not re-evaluated (joins do not require press-brake access), and the assembly
   sequence is updated.

3. **Given** a panel with a `JoinNode` of type `FLANGE`, **When** the flat pattern
   is exported, **Then** the flange lip is included as part of that panel's flat
   outline, and a dashed fold line marks the flange bend position on the DXF.

4. **Given** an attempt to add a `JoinNode` between two panels that are already
   connected by a `BendNode` on the same edge, **Then** the system returns
   `JOIN_EDGE_ALREADY_BOUND` and does not modify the graph.

---

### User Story 3c — Add holes or cut profiles to a panel's flat pattern (Priority: P2)

A fabricator needs to add cut features to a panel before it is sent to the laser
cutter or punch press: circular holes for fasteners, rectangular apertures for cable
routing, or arbitrary closed profiles for ventilation slots. These must appear in the
flat-pattern DXF as closed inner wires (cutouts), positioned relative to the panel's
local coordinate system so they remain correct if the panel's flat dimensions change.

**Why this priority**: A flat-pattern DXF without cut features is incomplete for
fabrication. Holes and cutouts are the most common additional features beyond panel
outline and bend lines.

**Independent Test**: Create a `PanelNode`, call `add_cut` with a circular profile
(centre, radius) in panel-local coordinates. Request the DXF. Verify the hole
appears as a closed circular inner wire at the correct position inside the panel
outline.

**Acceptance Scenarios**:

1. **Given** a 200 × 150 mm panel in the graph, **When** `add_cut` is called with a
   circular profile of radius 5 mm centred at (50, 40) in panel coordinates, **Then**
   the DXF contains a closed circle of radius 5 mm at position (50, 40) relative to
   the panel origin, fully inside the panel outline.

2. **Given** the same panel, **When** `add_cut` is called with a rectangular profile
   20 × 10 mm at position (100, 75), **Then** the DXF contains a closed rectangular
   inner wire at the correct position.

3. **Given** a panel that has been bent into an assembly (its flat dimensions are
   later recalculated), **When** the DXF is re-exported, **Then** the cut feature
   remains at the same panel-local coordinates — it does not drift with the flat
   layout origin.

4. **Given** `add_cut` is called with a profile whose bounding box extends outside
   the panel outline, **Then** the system returns `CUT_PROFILE_OUT_OF_BOUNDS` and
   does not modify the graph.

5. **Given** a panel with an existing `CutNode` of type CIRCLE, **When** the same
   panel is involved in a bootstrap from a STEP file that already contains the hole
   geometry, **Then** the bootstrap populates the `CutNode` automatically from the
   detected inner wire topology.

---

### User Story 4 — Design Rule Check blocks invalid bend before geometry is computed (Priority: P2)

An AI agent attempts to add a bend with inner radius smaller than the material's
minimum bend radius. The system should reject this at the graph-mutation layer —
before any expensive boolean operation is triggered.

**Why this priority**: Catching infeasible operations early prevents wasted compute,
avoids leaving partially-applied geometry in the registry, and produces actionable
error messages.

**Independent Test**: Configure a material rule `min_bend_radius = 1.5 × thickness`.
Call `add_bend` with inner radius < 1.5 × thickness. Verify the tool returns a
`DRC_BEND_RADIUS_VIOLATION` error and no geometry mutation has occurred.

**Acceptance Scenarios**:

1. **Given** a material with T = 2 mm and min bend radius rule = 1.5 T (3 mm),
   **When** `add_bend` is called with inner radius = 2 mm, **Then** the system returns
   `DRC_BEND_RADIUS_VIOLATION` and the graph is unchanged.

2. **Given** the same material, **When** `add_bend` is called with inner radius = 3 mm,
   **Then** the operation proceeds normally and no DRC error is raised.

---

### User Story 6 — Foldability check prevents physically impossible assemblies (Priority: P2)

A designer is building a closed box by adding bends one at a time. When they attempt
to add the final bend that would close all sides simultaneously — making the part
impossible to fold on a press brake — the system should detect the viability failure
and reject the operation before any geometry is modified.

The canonical example is a cube: all six faces cannot be joined by bending alone
because the last closure would require the material to be folded from inside a sealed
volume. The graph must reason about which panels remain accessible (open) at each
step in the fabrication sequence.

**Why this priority**: Undetected foldability failures produce designs that look
valid in 3D but cannot be manufactured. Catching them at graph-mutation time — before
a physical prototype is attempted — is a primary value of the Manufacturing Graph.

**Independent Test**: Construct a graph representing a five-sided open box (four
walls + base, all bends added). Attempt `add_bend` to join the sixth face (closing
the box). Verify the system returns `DRC_FOLDABILITY_VIOLATION` and the graph is
unchanged.

**Acceptance Scenarios**:

1. **Given** a five-sided open box in the graph (base + four walls, each joined by a
   `BendNode`), **When** `add_bend` is called to attach a lid panel that closes the
   remaining open face, **Then** the system returns `DRC_FOLDABILITY_VIOLATION`
   because no press-brake tool path can reach the final bend without unfolding a
   previously completed bend.

2. **Given** the same five-sided box, **When** the foldability check is queried
   without attempting `add_bend`, **Then** the response lists the remaining open edge
   as `INACCESSIBLE` and explains which previously closed panel is blocking access.

3. **Given** a simple L-bracket (two panels, one bend), **When** `add_bend` is called
   to attach a third panel perpendicular to the base (a U-channel), **Then** the
   foldability check passes because both bends remain independently accessible on a
   standard press brake.

4. **Given** a graph that has been flagged with `DRC_FOLDABILITY_VIOLATION`, **When**
   the blocking bend is rolled back (removing the panel that creates the closure),
   **Then** the foldability check clears and the rejected `add_bend` can proceed.

---

### User Story 7 — Geometry Solve recalculates affected geometry once per user action (Priority: P1)

A designer selects 100 panels and issues a single "merge all by bend" action. The
system records 100 `BendNode` mutations to the graph, marks all affected nodes as
dirty, then runs a single **Geometry Solve** that evaluates the entire dirty
sub-tree in one pass. The 3D geometry is recalculated once — not 100 times. The
Solve returns all updated body IDs and flat-pattern results together.

The same principle applies to initial feature recognition (bootstrap): after all
panels are separated, the Geometry Solve runs once across the full graph, not once
per panel.

**Why this priority**: Triggering a full geometric recalculation on every individual
graph mutation would make batch operations (100-panel merge, bootstrap of a complex
part) orders of magnitude slower than necessary. The Solve boundary ensures that
heavy boolean operations are batched into a single engine pass per user action.

**Independent Test**: Create 5 `PanelNode` entries and call `add_bend` in a loop 4
times (chaining all 5 panels). Record how many times the geometry engine is invoked.
Verify it is called once (for the Solve at the end of the 4th `add_bend`), not 4
times, and all 5 body IDs are returned together in the final response.

**Acceptance Scenarios**:

1. **Given** 100 disconnected `PanelNode` entries, **When** a batch operation adds
   100 `BendNode` entries inside a single transaction, then `solve_geometry` is
   called, **Then** the geometry engine executes one Solve pass (not 100), all
   dirty nodes are cleared, and the response contains all updated body IDs.

2. **Given** a bootstrap action on a 20-panel STEP file, **When** the bootstrap
   completes, **Then** the Geometry Solve has run once for all detected panels and
   bends, not once per detected feature.

3. **Given** a single `update_node` call that changes a `BendNode` parameter
   (a one-step user action), **When** the call returns, **Then** the Geometry Solve
   has already run automatically; the response includes the updated body IDs and
   the node is no longer dirty.

4. **Given** multiple mutations batched inside a transaction, **When**
   `solve_geometry` is called explicitly before `commit_transaction`, **Then** all
   dirty nodes are evaluated in one pass; subsequent `commit_transaction` does not
   trigger a second Solve.

5. **Given** a graph with dirty nodes, **When** a caller queries body IDs or
   flat-pattern dimensions without first calling `solve_geometry`, **Then** the
   response includes a `GEOMETRY_STALE` warning listing the dirty node IDs, and the
   returned values are from the last successful Solve (not the current parameters).

6. **Given** a Solve pass that fails partway through (a boolean operation throws on
   node 3 of 5), **Then** the entire Solve is rolled back atomically; all nodes
   remain dirty, the registry is unchanged, and a `SOLVE_FAILED` error identifies
   the offending node.

---

### User Story 8 — Graph query exposes the full fabrication sequence to an AI agent (Priority: P3)

An AI agent wants to understand the assembly sequence for a part without parsing raw
B-Rep topology. It queries the Manufacturing Graph and receives a structured,
human-readable list of fabrication steps in dependency order.

**Why this priority**: Enables higher-level agent reasoning (sequencing, costing,
compliance checking) without geometric computation.

**Independent Test**: Bootstrap a three-panel assembly, query the graph, verify the
response lists panels and bends in topological order with all parameters accessible.

**Acceptance Scenarios**:

1. **Given** a graph with nodes P1 → B1 → P2 → B2 → P3, **When** the graph is queried
   in topological order, **Then** the response lists P1, B1, P2, B2, P3 in that
   sequence with all stored parameters present.

---

### Edge Cases

- What happens when the STEP model has a non-manifold edge that prevents panel
  identification? → System returns `BOOTSTRAP_PARTIAL` with the panels and bends it
  could resolve, and flags unresolved regions.
- What happens if `splitBodyByBends` produces more panels than the graph bootstrap
  expects? → Extra panels are added as disconnected `PanelNode` entries; the user
  is notified to resolve adjacency.
- What happens if a `BendNode` references a `PanelNode` that has been deleted from
  the geometry registry? → Graph validation detects the dangling reference and
  surfaces a `GRAPH_INTEGRITY_ERROR` before any operation continues.
- What happens when a geometry recalculation succeeds for some downstream nodes but
  fails partway through (e.g., a boolean operation throws on node 3 of 5)? → The
  entire Geometry Solve is rolled back atomically; all affected nodes remain dirty,
  no partial geometry update is committed to the registry, and a `SOLVE_FAILED`
  error identifies the offending node.
- What happens when a caller reads body IDs or flat-pattern results while dirty
  nodes exist (before a Solve)? → The response includes a `GEOMETRY_STALE` warning
  listing the dirty node IDs; returned values are from the last successful Solve.
- What happens when a caller holds an old body ID after a Geometry Solve has
  superseded it? → The old body ID is invalidated; any tool call using it returns
  `BODY_NOT_FOUND`. The current ID is available from the graph query or Solve result.
- What happens if the same panel is connected to more than two bends? → Permitted
  (T-intersections exist in real parts); the graph records all connections and the
  flat-pattern path is chosen from a user-specified root panel.
- What happens when `add_cut` is called with a profile that overlaps an existing
  cut? → `CUT_OVERLAP` error is returned; the graph is unchanged.
- What happens when a cut profile sits within the bend-allowance setback zone?
  → A `DRC_CUT_IN_BEND_ZONE` warning is raised (not an error by default, since
  some designs intentionally notch the bend zone); the operation proceeds.
- What happens when two bodies are fused but are not quite coplanar (e.g. 0.3°
  off)? → The graph applies a coplanarity threshold (default 1°). Below the
  threshold the result is a flat extension (`PanelNode`); at or above it a
  `BendNode` is recorded with the measured angle.
- What happens when a `JoinNode` and a `BendNode` both reference the same panel
  edge? → `JOIN_EDGE_ALREADY_BOUND` is returned; only one connection type per edge
  is permitted.
- What happens when a design is topologically valid (no cycles) but physically
  impossible to fold? → A `DRC_FOLDABILITY_VIOLATION` is raised with a description
  of which panel or edge is blocking press-brake access. The graph is not mutated.
- What happens when the foldability check cannot determine accessibility due to
  an unusual panel geometry (e.g., acute angle less than 30°)? → The check returns
  `DRC_FOLDABILITY_UNCERTAIN` (warning, not error); the operation proceeds but the
  caller is advised to verify manually.
- What happens when a bootstrapped model contains a fully closed form (e.g., a
  welded box ingested as a STEP file)? → The bootstrap succeeds and records all
  panels and bends; foldability checking is advisory-only during bootstrap (the
  part already exists), not a hard block.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST maintain a Manufacturing Graph as a persistent,
  queryable in-memory structure representing the fabrication intent of the current
  session's sheet-metal work.

- **FR-002**: The graph MUST support four node types: `PanelNode` (flat material
  section), `BendNode` (fold/join at an arbitrary angle 1°–179°), `JoinNode`
  (mechanical fastening feature: flange, tab-and-slot, rivet pattern, or weld prep),
  and `CutNode` (material removal: holes, slots, and arbitrary closed profiles).

- **FR-003**: The system MUST provide a bootstrap operation that ingests an existing
  set of geometry bodies (post-split), infers panel and bend relationships, and
  populates the graph without manual node definition.

- **FR-004**: Every `PanelNode` MUST store a reference to its corresponding geometry
  body ID (a server-generated UUID) so that callers can navigate bidirectionally
  between intent and topology. The body ID is opaque and volatile — it changes after
  any Geometry Solve that regenerates the node. The graph node ID is the stable
  identity; callers MUST use the node ID as the long-lived handle and retrieve the
  current body ID via graph query when needed.

- **FR-005**: Every `BendNode` MUST store: inner radius, bend angle (any value
  1°–179°, not restricted to 90°), K-factor, and a reference to the two `PanelNode`
  entries it connects. The bend-allowance formula MUST use the actual stored angle:
  $BA = \frac{\pi \cdot A}{180} \cdot (R + K \cdot T)$.

- **FR-005b**: The system MUST apply a coplanarity threshold (default 1°) when
  classifying a union-merged body. If the dihedral angle between the two fused
  sections is below the threshold, the result MUST be recorded as a single
  `PanelNode` (flat extension) with no `BendNode`. If at or above the threshold,
  a `BendNode` is recorded with the measured angle. Sub-millimetre gaps and surface
  flatness deviations up to the threshold MUST be absorbed without error.

- **FR-005c**: Every `JoinNode` MUST store: join type (FLANGE, TAB_SLOT,
  RIVET_PATTERN, WELD_PREP), the two `PanelNode` entries it connects, the reference
  edge on each panel, and type-specific parameters (e.g., rivet spacing, flange
  width). `JoinNode` entries MUST NOT generate a bend allowance deduction in the
  flat pattern. Flange-type joins MUST add the flange lip geometry to the affected
  panel's flat outline and mark the fold line as a dashed annotation.

- **FR-005d**: Every `CutNode` MUST store: a reference to the parent `PanelNode`,
  cut type (CIRCLE, RECTANGLE, POLYGON, FREEFORM), profile parameters in
  panel-local 2D coordinates (e.g., centre and radius for CIRCLE; corner and
  dimensions for RECTANGLE; ordered vertex list for POLYGON/FREEFORM), and an
  optional label. `CutNode` profiles MUST be positioned in the flat coordinate
  system of the parent panel so they remain stable if the panel's flat layout
  origin changes. The DXF export MUST render each `CutNode` as a closed inner
  wire (cutout) within the parent panel's outline. The system MUST validate that
  the profile lies fully within the panel outline at the time of `add_cut`;
  profiles that extend outside MUST be rejected with `CUT_PROFILE_OUT_OF_BOUNDS`.
  The system MUST warn (not error) when a profile intersects the bend-allowance
  setback zone (`DRC_CUT_IN_BEND_ZONE`).

- **FR-005e**: The bootstrap operation MUST detect inner-wire topology in ingested
  bodies (holes and cutouts already present in the STEP geometry) and populate
  `CutNode` entries automatically, recording profile type and panel-local coordinates.

- **FR-006**: The system MUST validate graph acyclicity on every node insertion;
  any operation that would introduce a cycle MUST be rejected with a structured error
  before geometry is touched.

- **FR-007**: The `add_bend` operation MUST integrate with the transaction primitive
  (`004-transaction-primitive`) so that graph mutation and geometry mutation are
  rolled back together as one atomic unit.

- **FR-008**: Flat-pattern dimensions for any panel pair connected via a `BendNode`
  MUST be computable directly from graph parameters using the standard bend-allowance
  formula, independent of re-inferring angles from B-Rep topology.

- **FR-009**: The DXF export tool MUST annotate bend zones with dashed centre-line
  markers positioned at the neutral-axis offsets computed from the graph's `BendNode`
  parameters.

- **FR-010**: Design Rule Checks MUST execute synchronously at graph mutation time.
  The system MUST ship with at minimum: minimum bend radius check, minimum flange
  width check, and press-brake accessibility check. DRC failures MUST prevent
  geometry execution.

- **FR-013**: The system MUST perform a **foldability check** on every `add_bend`
  call before executing geometry. The check determines whether the proposed new bend
  is reachable by a press-brake tool given the panels already fixed in position by
  prior bends. An inaccessible bend MUST be rejected with `DRC_FOLDABILITY_VIOLATION`.

- **FR-014**: The foldability check MUST model the constraint that a panel is
  "locked" once both of its edges that connect to already-completed bends are fixed.
  A panel that is locked on more than one side in a way that closes off the remaining
  open edge from tool access is considered inaccessible.

- **FR-015**: The system MUST expose a `check_foldability` query tool that evaluates
  the current graph state and returns, for each panel, its accessibility status
  (`OPEN`, `CONSTRAINED`, or `INACCESSIBLE`) and, for `INACCESSIBLE` panels, the
  identities of the locking bends.

- **FR-016**: During bootstrap from an existing model, foldability violations MUST be
  reported as warnings (not errors), since the bootstrapped part already physically
  exists (it may have been welded, not folded).

- **FR-017**: Graph mutations (node addition, parameter update, node removal) MUST
  mark the mutated node and all downstream dependents as **dirty** in the graph.
  Dirty status MUST be visible via the graph query tool. Mutations MUST NOT
  automatically trigger geometry recalculation; they only update the intent graph
  and the dirty flags.

- **FR-018**: The system MUST expose a `solve_geometry` tool (the **Geometry Solve**)
  that traverses every dirty node in topological order, re-executes the corresponding
  geometric operations, clears dirty flags, and returns a `GeometrySolveResult`
  containing: the list of regenerated node IDs, their new body IDs, and the list
  of body IDs invalidated by the Solve. The Solve MUST be atomic: if any node
  fails, all dirty flags are restored and no registry changes are committed.

- **FR-019**: High-level single-step action tools (`add_bend`, `add_join`, `add_cut`,
  `update_node`, `remove_node`, bootstrap) MUST invoke `solve_geometry` automatically
  at the end of their execution so that single-step callers receive a clean, solved
  result without an explicit `solve_geometry` call. Callers that batch multiple
  mutations inside a transaction MUST call `solve_geometry` explicitly; the
  transaction tools MUST NOT invoke it automatically.

- **FR-020**: When any tool returns body IDs or flat-pattern dimensions and one or
  more nodes in the affected sub-tree are dirty (unsolved), the response MUST
  include a `GEOMETRY_STALE` warning listing the dirty node IDs. Values returned
  under a stale warning are from the last successful Solve.

- **FR-022**: Every `add_*`, `update_node`, and `remove_node` tool MUST accept a
  caller-supplied `node_id` string as the stable graph identity for the node. Node
  IDs MUST be unique within the session's Manufacturing Graph; a duplicate on
  creation MUST be rejected with `NODE_ID_ALREADY_EXISTS`. Node IDs MUST be
  preserved verbatim across Geometry Solves — the Solve never alters or replaces
  them. The bootstrap operation MUST generate human-readable node IDs derived from
  the detected geometry (e.g., `"panel-1"`, `"bend-1"`) when no caller-supplied ID
  is available. Node IDs are the only IDs shown in the MCP tool response UI;
  geometry body UUIDs are returned in a separate field and are not used as primary
  identifiers in tool calls.

- **FR-023**: `update_node` MUST accept updates to any field of any node type,
  including structural panel references (e.g., re-targeting which panels a
  `BendNode` connects) and the node ID itself (rename). When a node ID is renamed,
  all edges and cross-references within the graph MUST be updated atomically before
  DRC runs. When a structural panel reference is changed, the system MUST re-validate
  graph acyclicity for the new topology. The `CutNode` profile MUST be fully
  mutable: any profile type (CIRCLE, RECTANGLE, POLYGON, FREEFORM) may be replaced
  with any other, including replacing a simple circle with an arbitrary closed
  polygon (FREEFORM) defined by an ordered vertex list in panel-local coordinates.
  Every `update_node` call MUST re-run DRC, mark all nodes downstream of the updated
  node as dirty, and auto-invoke `solve_geometry` when used as a single-step action.

- **FR-011**: The Manufacturing Graph MUST be queryable via an MCP tool that returns
  nodes in topological (dependency) order with all stored parameters.

- **FR-012**: The system MUST expose a `reset_graph` operation that clears the
  Manufacturing Graph and the associated geometry registry for the current session,
  used when starting a new part.

- **FR-021**: The system MUST expose a `remove_node` mutation tool that deletes any
  node from the Manufacturing Graph by its node ID. Deletion MUST: (a) validate that
  removal does not leave dangling edge references (i.e., a `BendNode` or `JoinNode`
  whose panel references would become invalid); (b) mark all nodes downstream of the
  deleted node as dirty; (c) run DRC on the modified graph before geometry is
  touched; (d) auto-invoke `solve_geometry` at the end of the call when used as a
  single-step action. If the removal would create dangling references, the system
  MUST reject it with `REMOVE_WOULD_ORPHAN_NODES`, listing the dependent node IDs.
  `remove_node` participates in the transaction primitive (`004`) so that deletion
  and its downstream geometry effects are rolled back together as one atomic unit.

### Key Entities

- **PanelNode**: A flat sheet-metal section. Attributes: node ID (caller-supplied
  human-readable string, stable), geometry body ID (server-generated UUID, volatile
  — changes on Geometry Solve), material type, nominal thickness, flat dimensions
  (width × height).
- **BendNode**: A fold/join operation at an arbitrary angle. Attributes: node ID
  (caller-supplied, stable), panel A ref, panel B ref, inner bend radius, bend angle
  (1°–179°), K-factor, computed bend allowance. No geometry body ID (bend geometry
  is part of the merged panel bodies).
- **JoinNode**: A mechanical fastening feature between two panels. Attributes: node
  ID (caller-supplied, stable), panel A ref, panel B ref, reference edge on each
  panel, join type (FLANGE, TAB_SLOT, RIVET_PATTERN, WELD_PREP), type-specific
  parameters. Does not produce a bend allowance.
- **CutNode**: A material removal feature on a panel. Attributes: node ID
  (caller-supplied, stable), parent panel ref, cut type (CIRCLE, RECTANGLE, POLYGON,
  FREEFORM), profile parameters in panel-local 2D coordinates, optional label.
  Rendered as a closed inner wire in the DXF.
- **GeometrySolveResult**: The output of a Geometry Solve operation. Attributes:
  solve ID, timestamp, list of regenerated node IDs with their new body IDs, list
  of invalidated (superseded) body IDs, dirty node count before Solve, solve
  duration.
- **Manufacturing Graph**: The DAG container. Attributes: session ID, root panel ID,
  ordered list of nodes and directed edges, per-node parameter maps.
- **DRC Rule**: A named manufacturability constraint. Attributes: rule ID, parameter
  expression, violation error code, severity (error vs. warning).
- **AccessibilityState**: Per-panel foldability status. Values: `OPEN` (no
  constraints on press-brake approach), `CONSTRAINED` (bend possible but tool
  clearance is limited), `INACCESSIBLE` (at least one completed bend blocks all
  approach angles). Recorded on each `PanelNode` at the time its final connecting
  bend is added.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can bootstrap the Manufacturing Graph from any STEP model that
  `splitBodyByBends` resolves successfully, with no manual graph authoring required.

- **SC-002**: Flat-pattern dimensions computed from graph traversal agree with the
  existing unfold-based computation to within 0.5 mm for all passing regression
  tests in `production_workflow_test.cc`.

- **SC-003**: All DRC violations are detected and returned before geometry execution
  begins; zero cases where an invalid bend parameter reaches the C++ geometry engine.

- **SC-004**: A full bootstrap + two `add_bend` operations + DXF export completes in
  under 5 seconds for parts with up to 20 panels.

- **SC-005**: Rolling back a `add_bend` operation (via `004` transaction primitive)
  leaves both the Manufacturing Graph and the geometry registry in an identical state
  to before the operation — verifiable by re-running all existing regression tests.

- **SC-006**: An AI agent can traverse the graph query tool output and reconstruct
  the full fabrication sequence (panel identities, bend parameters, order) without
  reading any raw B-Rep topology.

- **SC-007**: The system correctly identifies foldability violations for all canonical
  problematic topologies in the test suite: closed box (6 faces), closed triangle
  prism (5 faces), and U-channel with cap (4 faces joined to close). Zero false
  negatives on known-infeasible topologies.

- **SC-008**: A `check_foldability` query on a graph with up to 20 panels completes
  in under 200 ms, ensuring it can be called before every `add_bend` without
  perceptible latency.

- **SC-009**: A DXF exported for a panel with `CutNode` entries contains one closed
  inner wire per cut feature, positioned at the correct panel-local coordinates.
  Verified against bootstrapped STEP models that contain pre-existing holes.

- **SC-010**: After a Geometry Solve, a query of the Manufacturing Graph and the
  geometry registry returns consistent data with zero dirty nodes — no stored
  parameter (bend radius, angle, etc.) disagrees with the physical geometry of
  its corresponding body.

- **SC-011**: A batch of N graph mutations followed by a single `solve_geometry`
  call invokes the geometry engine exactly once (one Solve pass), not N times.
  Verified by instrumenting the bootstrap of a 20-panel model and a 100-panel
  batch `add_bend` operation.

- **SC-012**: A `solve_geometry` call on a graph with up to 100 dirty nodes MUST
  complete in under 3 seconds on the reference development machine. This ceiling
  applies regardless of graph topology (linear chain, fan-out, or mixed).

---

## Assumptions

- `004-transaction-primitive` (explicit transaction) is merged before this feature
  ships. The `add_bend` atomic rollback story (US2-SC2) is gated on it.
- `005-semantic-mapping-layer` is NOT required as a prerequisite. The Manufacturing
  Graph maintains its own body-ID references independently. Integration with the
  semantic identity namespace is deferred to a future phase.
- `CutNode` (material removal) is **in scope** for this increment. Supported cut
  types are CIRCLE, RECTANGLE, POLYGON, and FREEFORM. The bootstrap operation
  detects existing holes and slots from ingested STEP geometry.
- The Manufacturing Graph lives in-memory within the MCP TypeScript process for this
  phase. Dolt persistence (as used by Phase 1) is deferred to a future increment.
  **Known limitation**: if the MCP server process is restarted or crashes, the
  entire Manufacturing Graph and all associated geometry are lost. Callers must
  re-bootstrap or re-author the graph from scratch. Graph persistence (snapshot
  export/import, Dolt integration, or session recovery) is explicitly out of scope
  for this specification and will be addressed in a dedicated future spec.
- Material property defaults (K-factor, min bend radius) are loaded from the
  existing `config/config.yaml` material table already in the codebase; no new
  material database is introduced.
- The bootstrap operation calls the existing `splitBodyByBends` C++ tool internally;
  it does not re-implement panel detection.
- The flat-pattern DXF path continues to use the existing `unfoldShell` C++ engine
  for geometry projection; the graph layer adds the BA annotation on top.
- "Angle" stored in a `BendNode` is the bend angle (deviation from flat, not the
  included angle), consistent with the existing `mergeBodiesWithBend` parameter
  convention. Any angle from 1° to 179° is valid; 90° has no special status in the
  data model.
- The coplanarity threshold used to distinguish a flat extension from a shallow
  `BendNode` defaults to 1°. It is configurable per session but not per material.
- `JoinNode` entries of type FLANGE are modelled as a small additional `PanelNode`
  (the lip) connected to the parent panel by a `BendNode` with the flange bend angle.
  This reuses the existing bend machinery and keeps the graph uniform.
- Multi-root assemblies (multiple disconnected sub-graphs in one session) are out of
  scope. All nodes belong to a single Manufacturing Graph per session.
