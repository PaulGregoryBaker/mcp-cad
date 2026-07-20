# 16 — Kernel Port: Capability List (Phase 2.4)

**Status:** `[PROPOSAL]` for Paul's review.
**Inputs it must satisfy:** 13 §6 (what the translation module itself needs at
graph-construction time — the seed this doc generalizes to the whole system), 15
(every tool/resource that could conceivably touch a kernel), C5 (the developable-
surfaces boundary — the scope constraint that shapes this entire list), 04 P1/P7
(layered architecture, port segregation), 04 P5 (typed error taxonomy at every
boundary), N13 (cross-bridge memory discipline). **Deliberately kernel- and
language-agnostic** per Paul (2026-07-18, OPEN-16 deferred to Phase 3): no method
signatures, no binding mechanism, no assumption about which library implements
anything. This is a requirements document for a kernel, not an interface design.

---

## 0. Scope framing: developable surfaces only — and why that widens Phase 3's options

C5 (ratified) restricts v2's geometric scope to **developable surfaces**: planar
panels at any orientation, plus cylindrical/conical bend and roll surfaces. Nothing
in this system ever needs general NURBS-surface booleans, free-form surface fitting,
or arbitrary curved-surface intersection — the full generality a heavyweight B-Rep
kernel exists to provide. That has a direct, useful consequence for the capability
list below: **not every capability needs the same weight of tool.**

Two tiers, used throughout §1:
- **HEAVY** — genuinely needs a real solid-modeling / B-Rep kernel: reading arbitrary
  STEP files, general boolean operations on realized solids, standards-compliant
  STEP export.
- **LIGHT** — expressible as plain computational geometry directly on 13's *exact*
  point-array/parametric output (regions, `bottomFace`/`topFace`, bridge charts,
  13 §3.3), with no B-Rep kernel involvement at all: polygon-and-cylinder
  tessellation, distance/clearance between exact shapes, DXF writing.

**Consequence for Phase 3, stated now so it isn't lost:** the stack decision does not
have to be "pick one kernel for everything." A heavy kernel may be needed only for
import/heal, general booleans, and STEP export — a narrow, well-defined slice — while
the LIGHT capabilities can be served by small, dependency-light code with no B-Rep
engine at all. This also means most of the system **never touches the kernel** —
worth keeping in view against N13's memory-discipline concern, since it shrinks the
surface where native handle lifecycle actually matters.

## 1. The ports

Each port is a capability group in the P7 sense (small, independently fake-able for
testing) — not a class, not an interface signature. Inputs/outputs are described
conceptually.

### Port A — Import & Heal `[HEAVY]`

- **Purpose:** read a CAD interchange file (STEP, at minimum — v1's evidence base) and
  produce a valid, manifold solid; repair non-manifold edges, sliver faces, and
  similar defects where feasible.
- **Conceptual I/O:** file bytes/path in → a solid handle out, or a typed failure
  (defects found but unrepairable).
- **Failure modes → error taxonomy (15 §2):** `IMPORT_UNHEALABLE` (AC-A.4).
- **Consumers:** `import_part` (15 §4.1).

### Port B — Measurement (piece outlines + fold/adjacency detection) `[HEAVY]`

- **Purpose:** given a solid, enumerate its faces and report, per face: its plane
  (origin + normal), its boundary as an ordered ring (with arc segments where the
  boundary is genuinely curved — never a raw trim-curve handle the domain would have
  to interpret), and its adjacency to neighbouring faces — specifically the shared
  edge and the dihedral angle there. This is 13 §6's "per-piece measured outlines"
  and "fold detection between adjacent pieces," generalized: it is *also* what
  `split_body_by_bends`/`remove_protrusions` (15 §4.2) need to (re-)classify an
  existing solid, and what `merge_bodies_with_bend` needs to align two parts' edges
  at the proposed seam.
- **Conceptual I/O:** a solid handle in → a list of `{plane, boundaryRing,
  neighbours: [{sharedEdge, dihedralAngle}]}` out.
- **What this port does *not* do:** classify panel vs. protrusion, or decide bend
  angle/radius/K — that interpretation (thresholds, policy) is domain logic (13/14),
  reading this port's raw geometric facts. The kernel measures; the domain decides.
  Keeping this boundary sharp is what P1's layering actually buys.
- **Failure modes:** `REGION_CLIP_FAILED`-class outcomes if a boundary can't be
  represented as a clean ring (degenerate face, etc.) — surfaces as the same code
  named in 15 §2 (which today describes a domain-side clip failure; a kernel-side
  measurement failure feeding into the same clipping step is the same user-facing
  problem and should share the code, not invent a parallel one).
- **Consumers:** `import_part`, `split_body_by_bends`, `remove_protrusions`,
  `merge_bodies_with_bend` (15 §4.1–4.2); 13 §6's reconciliation step directly.

### Port C — Boolean Realization (on already-placed solids) `[HEAVY]`

- **Purpose:** union, subtraction, and plane-split on realized solids that may come
  from independent origins (not guaranteed to share exact boundary material) — the
  general case, which genuinely can fail (self-intersection, non-manifold result).
- **Conceptual I/O:** two (or more) solid handles + an operation kind → a solid
  handle, or a typed failure.
- **Failure modes:** a new `BOOLEAN_OP_FAILED` code (15 §2 doesn't currently name
  this — add it there when this doc is folded in).
- **Consumers:** `fuse_bodies`, `cut_panel` (boolean `kind`), `split_body_by_plane`
  (15 §4.2).
- **Explicitly distinct from Port D:** Port C is the *general*, can-fail case,
  reserved for the tools above. Ordinary part construction never calls it (below).

### Port D — Solid Construction (thicken + stitch, from exact geometry) `[HEAVY, but
constrained]`

- **Purpose:** given 13 §3.3's exact `bottomFace`/`topFace` point arrays for a set of
  regions and their bridges' exact parametric descriptions, construct the realized
  3D solid: thicken each region, stitch side walls, connect bridges. This is 13 §6's
  "solid realization downstream," named as its own port because its **input
  guarantee is much stronger than Port C's**: adjoining regions share exact boundary
  material by construction (14 §0) — this is a consumer of already-correct
  placement, never a producer of it, and in the well-formed case (which is the *only*
  case the domain ever constructs, given P3's single-geometric-solution discipline)
  it should not realistically fail. Worth stating plainly: **ordinary part
  construction (FR-E) has no meaningful failure mode at this boundary** — a defect
  here would indicate a bug upstream in 13, not a legitimate kernel-reported error to
  design UX around.
- **Conceptual I/O:** exact point arrays + bridge parametrics in → a solid handle
  out.
- **Consumers:** FR-E part construction generally; feeds Port G (STEP export) and, if
  a mesh is requested at very fine resolution, may feed Port E rather than
  duplicating tessellation logic.

### Port E — Tessellation `[LIGHT — likely no B-Rep kernel needed]`

- **Purpose:** triangulate exact geometry (a region's polygon-with-holes, a bridge's
  cylinder sector) at a caller-specified chordal tolerance, for the `mesh` resource
  (15 §3.3). Because the inputs are already exact polygons and cylinder sectors
  (never general NURBS), this is answerable with a plain polygon triangulator plus
  parametric arc sampling — not a reason by itself to require a heavy kernel.
- **Conceptual I/O:** exact geometry + a resolution parameter → a triangle
  mesh buffer.
- **Note:** `graph://part/{id}/boundary` (15 §3.3, the *primary* viewport resource
  per the earlier UI discussion) needs **no kernel capability at all** — it's a
  direct read of 13 §3.3's pure output. Only `mesh` needs this port, and only when a
  consumer specifically wants triangles instead of exact boundary data.
- **Consumers:** `graph://part/{id}/mesh` (15 §3.3).

### Port F — Clearance / Distance `[LIGHT — likely no B-Rep kernel needed]`

- **Purpose:** minimum distance and interference detection between two placed exact
  shapes (regions and/or bridges), same or different parts. Again, because inputs
  are exact polygons/cylinder-sectors, this is computational geometry (polygon and
  cylinder distance queries), not general B-Rep proximity — a much smaller problem
  than the general case a heavyweight kernel solves.
- **Conceptual I/O:** two shape references (+ optional profile tolerance) → a
  distance value and/or an interference report.
- **Consumers:** `check_clearance` (15 §4.4 resource), `close_gap` (needs the closing
  vector), `synthesize_joints` (needs proximity to place weld/rivet features).

### Port G — CAD Interchange Export

- **STEP export `[HEAVY]`** — write a standards-compliant STEP file from a Port-D/
  Port-C-realized solid. Needed by `export_production_pack` (15 §4.5) for downstream
  CAM/customer use.
- **DXF export `[LIGHT]`** — write valid DXF entities (LWPOLYLINE with bulge, layers)
  directly from 13 §3.3's flat-pattern point arrays. v1's DXF writer is explicit
  salvage material for this (12-domain-notes §5) — a reference implementation, not a
  reason to route this through a heavy kernel.
- **Consumers:** `export_production_pack`; `graph://part/{id}/flat-pattern` and
  `.../drawings` (DXF half) for the lighter path.

## 2. Consumer traceability (15 tools/resources → ports touched)

| 15 tool/resource | Ports | Notes |
|---|---|---|
| `import_part` | A, B | |
| `create_part` | *(none)* | Pure graph authoring, Level A |
| `split_body_by_bends` | B | Re-measurement; classification is domain logic |
| `remove_protrusions` | B | Same |
| `split_body_by_plane` | C | |
| `merge_bodies_with_bend` | B | Reconciliation/alignment, not a boolean |
| `fuse_bodies` | C, D | |
| `cut_panel` (boolean) | C | |
| `cut_panel` (parametric), `add_hole`-equivalent | *(none)* | Pure outline/feature-ring edit (14 §2) |
| `add_flange`, `generate_reliefs`, `rip_edge` | *(none)* | Pure 2D clipping via 13's own algorithm — **deliberately kernel-free**, reinforcing "the graph is the source of truth" |
| `close_gap` | F | Needs the closing vector |
| `synthesize_joints` | F | Placement proximity |
| `graph://part/{id}/findings`, `.../full`, `.../parts`, `.../semantics` | *(none)* | Pure graph/Layout reads |
| `graph://part/{id}/flat-pattern`, `.../boundary` | *(none)* | 13 §3.3 pure output |
| `graph://part/{id}/mesh` | E | |
| `graph://clearance` | F | |
| `graph://part/{id}/drawings` | G (DXF half only) | 2D drafting from `DrawingModel`, no kernel for the drafting itself |
| `export_production_pack` | D, G | |
| `simulate_nesting` | *(none)* | 2D packing over flat-pattern point arrays |

**Reading this table plainly:** more than half the tool/resource surface never
touches a kernel at all. That is the payoff of 13's purity (§0) made concrete and
countable, not just asserted.

## 3. Boundary discipline (P1/P7, applied concretely to this list)

- **One adapter per port, no shared "kernel god object."** A future implementation
  may route several ports through the same underlying library, but the *port*
  boundaries stay separate — each independently fakeable for tests (P7), each with
  its own typed failure surface (P5).
- **Nothing outside a port's adapter imports kernel bindings** — enforced by the P1
  boundary lint once a stack exists (Phase 4). This doc is what that lint is
  eventually checked against.
- **Kernel failures always cross the boundary as typed domain errors** (P5) — a raw
  kernel exception/string must never reach the MCP layer. §1 names the taxonomy
  entries each port needs; `BOOLEAN_OP_FAILED` is new and should be added to 15 §2
  when this doc lands.
- **Native handle lifecycle (N13) applies only where ports actually run** — per §0's
  tiering, that's Ports A, B, C, D, and the STEP half of G. Acquire/release,
  scope-bound to one request, never cached (14 §3.1, Layer 1) — this list is what
  makes that scope concrete rather than a general principle with nothing to point at.

## 4. What is explicitly NOT decided here

Per Paul (2026-07-18): no concrete kernel/library selection, no binding mechanism
(NAPI, FFI, subprocess, WASM, etc.), and no decision about whether all HEAVY ports
come from one kernel or several. §0 argues for keeping that last question open
deliberately — it may be a real Phase 3 finding that HEAVY and LIGHT capabilities
are best served by different tools entirely (e.g., a mature open-source B-Rep kernel
for A/B/C/D/G-STEP, and a small first-party or lightweight-library implementation for
E/F/G-DXF) rather than assuming a single kernel dependency.

## 5. Decisions

- **OPEN-16.1 — RESOLVED 2026-07-20 (Paul): eager, async-shaped, but wait time still
  matters.** Port B's measurement runs on the *whole* imported solid eagerly, as part
  of `import_part`'s single job — confirmed, matching A4's "import bootstraps the
  full graph from the onset." "Async" (N9) is the correct *protocol* shape (the MCP
  call doesn't block), but it is **not** license to ignore wait time: "the user is
  probably going to wait before doing anything else, so wait times still need to be
  reasonable" (Paul). Consequences, folded into N9 (02-requirements.md) and 15
  §4.1's `import_part` row:
  - `import_part`'s job must report **meaningful, granular `progress`** (15 §1's
    envelope already has the field) — not a bare `queued→running→done` with nothing
    in between — because the realistic usage pattern is a human watching, not
    walking away. Per-piece measurement (Port B) is naturally incremental
    (piece-by-piece), so progress reporting is close to free once the pipeline is
    built this way, not a bolted-on feature.
  - N9's "accuracy takes precedence over performance" for heavy ops is unchanged —
    this does **not** authorize trading correctness for speed — but it does not mean
    latency is unconstrained either: reasonable engineering effort (parallelizing
    independent per-piece measurement, incremental graph construction) is expected
    within the accuracy budget, not treated as optional because the op is async.
- **OPEN-16.2 — RESOLVED 2026-07-20 (Paul): agreed, Port D should not fail.**
  Promoted from "worth testing" to a stated acceptance criterion — see AC-E.5
  (11-acceptance-criteria.md, added, under FR-E part construction — not FR-D, since
  this is about construction succeeding, not composition geometry): Port D
  construction must not fail for any well-formed graph in the case inventory (08),
  checked directly once a suite driver exists, not merely assumed in this doc.
- ~~`[OPEN-16.3]`~~ **DONE** — `BOOLEAN_OP_FAILED` added to 15 §2's error table.
