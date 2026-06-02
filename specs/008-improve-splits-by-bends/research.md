# Research & Architectural Decisions: Splits by Bends and Viewport Alignment Enhancements (008)

**Phase 0 Output** | **Date**: 2026-06-01
**Spec**: [spec.md](./spec.md)

---

## Technical Context

This enhancement extends the **Geometry Engine (C++)** and **MCP Protocol Layer (TypeScript)** to improve sheet metal panel decomposition, coordinate system re-orientation, complex body merging, and protrusion extraction.

*   **Geometry Stack**: OpenCASCADE (OCCT 7.8.1 via vcpkg).
*   **State Persistence**: Dolt-persisted semantic binding graph (in-memory session-scoped CAD shape registry).
*   **Testing Frameworks**: `vitest` (TypeScript integration), `Google Test` (native C++ geometry tests).

---

## Research Findings & Architectural Decisions

### 1. Trapezoidal Face Merging in `split_body_by_bends`

*   **Problem**: Faceted/segmented imports like `cauldron.step` are decomposed by `split_body_by_bends` into multiple separate triangular panels. This is unexpected because coplanar or near-coplanar adjacent triangular facets should represent a single flat trapezoidal panel.
*   **Research**: OCCT's B-Rep face explorer returns each facet as a separate `TopoDS_Face`. The current grouping logic only aggregates exact coplanar faces sharing flat seams. Faceted parts have slight floating-point normal variations or complex triangulation boundaries that fail strict coplanar checks.
*   **Decision**: Implement a **Facet Unification Pass** in `split_body_by_bends`. After identifying the segmented face groups, the C++ engine will invoke `ShapeUpgrade_UnifySameDomain` on the merged shells or execute an explicit topological adjacency traversal that merges adjacent faces sharing collinear/flat edges where the dihedral angle is within `angle_threshold_deg`. This unifies co-planar triangular facets into single flat trapezoidal/rectangular panel bodies before registration.

---

### 2. Viewport Orientation & Centering On-Demand

*   **Problem**: Models imported with off-center centroids or non-standard coordinate systems (like `cauldron.step`) pivot incorrectly in the UI viewport, causing rotation camera controls to swing the part out of view.
*   **Research**: The frontend viewport controls rotate about `[0,0,0]` by default. Forcing automatic centering/rotation on all imports might disrupt assemblies with valid coordinate alignments.
*   **Decision**: Introduce an explicit, mutating tool and C++ service function: `center_and_align_body`. 
    *   It computes the Center of Mass (centroid) of the part using `BRepGProp` and translates it to `[0,0,0]`.
    *   It calculates the principal inertia axes and rotates the part so the dominant planar face normal aligns with the vertical Z-axis.
    *   This is callable **on-demand** when viewport centering is incorrect, preventing unnecessary UI clutter or forced transformations for already-correct models.

---

### 3. Merge by Bend on Complex Adjacent Panels

*   **Problem**: `merge_bodies_with_bend` fails on the adjacent faces of complex models like `cauldron.step`, returning non-manifold shells or failing to stitch the seam.
*   **Research**: The existing stitcher uses strict spatial matching of edge boundaries. Segmented cauldron edges contain minute coordinate gaps or faceted curves.
*   **Decision**: Update `merge_bodies_with_bend` in `GeometryServiceImpl` to utilize the standard `BRepFeat_Gluer` or perform an initial `BRepBuilderAPI_Sewing` pass with a dynamic fuzzy tolerance based on material thickness. This heals edge boundaries of the adjacent non-planar faces before filleting the seam, ensuring manifold continuity for complex curved panels.

---

### 4. Mesh-based Loop-Traversal Protrusion Removal

*   **Problem**: The volumetric/bounding-box protrusion removal algorithm performs slow solid 3D boolean operations and can over-capture panel boundaries.
*   **Research**: A protrusion meets a host panel along a localized intersection boundary. In B-Rep meshes, this interface is represented by a cycle of connected boundary edges with high dihedral angles (sharp seams) and narrow cross-sectional widths (thickness).
*   **Decision**: Implement a **Mesh Edge-Traversal Loop Algorithm**.
    *   Traverse the boundary edges of the part shell to identify cycles of narrow closed loops representing the interface seams of protrusions.
    *   Split the B-Rep shape precisely along the detected loop.
    *   To facilitate comparative testing, the old volumetric algorithm will be kept as a separate benchmarking tool `remove_protrusions_legacy` in the C++ layer and Node wrapper, and only completely deprecated/removed once the new loop-traversal algorithm is verified as superior.

---

### 5. Shape History and PR Review Differences

*   **Problem**: Geometry changes during branches and PR reviews are currently represented as a delete and recreate of the solid, making precise semantic delta analysis impossible.
*   **Research**: The semantic mapping database (Dolt) can track entity history across revisions.
*   **Decision**: Add full `shape_history` mapping outputs to `split_body_by_bends`. When the transaction commits, the `MappingLayer` intercepts the history and automatically maps any declared semantic entities (e.g. `semantic://cauldron/front-left-panel`) from the parent shell/face IDs to the newly created split panel face/body IDs. This enables the UI or PR review tools to perform time-travel queries across branches using Dolt AS OF, establishing clean identity continuity for diffs.
