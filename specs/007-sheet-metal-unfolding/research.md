# Research: Advanced Sheet Metal Unfolding (007)

**Phase 0 output** | **Date**: 2026-05-26

---

## Research Questions & Findings

### R-001: Robust Sheet Metal Thin-Panel Validation Heuristics

**Decision**: Implement a validation routine that scans the topological faces of the `TopoDS_Shape`, groups planar faces by parallel or anti-parallel normal pairs, and validates thickness uniformity.

**Rationale**:
1. **Normal Grouping**: Group all planar faces whose outward normals are parallel or anti-parallel (dot product magnitude $\geq 0.99$).
2. **Offset Pairs**: For each face $F_A$ with normal $N_A$, locate the corresponding face $F_B$ with normal $N_B \approx -N_A$. Verify that the perpendicular distance between their infinite plane equations is within $\pm 10\%$ of the nominal sheet thickness $t$.
3. **Face Area Ratio**: Ensure that the sum of the areas of these matched parallel face pairs covers at least $85\%$ of the total surface area of the shape. The remaining $15\%$ accounts for thickness boundary faces, corner reliefs, or holes.
4. **Thickness Consistency**: Reject models with multiple mismatched nominal thicknesses (e.g. some flanges are $1.5\text{ mm}$ and others are $3.0\text{ mm}$) or bulky 3D features (which lack offset pairs).

**Alternatives considered**:
- **Ray-casting thickness validation**: Casting rays from face centers to compute thickness. This is computationally expensive and error-prone for noisy imports.
- **Bounding box height check**: Only checking if one of the bounding box dimensions is thin. Rejected because curved or bent sheets will have large 3D bounding boxes.

---

### R-002: Topological Unfoldability and Joint Checks

**Decision**: Construct a Face-Bend Connectivity Graph from the validated sheet metal body. Verify that it forms a valid spanning tree without cycles or T-junctions.

**Rationale**:
1. **Connectivity Graph**: Vertices in the graph represent unique planar sheet faces (the parallel pairs treated as a single mid-plane layer). Edges represent bend lines (cylindrical segments or sharp fold lines).
2. **Cycle Detection**: Run a DFS/BFS cycle detection algorithm. If a cycle of bends is found (e.g. four sides of a closed box joined without any rip edges), the sheet cannot be unfolded in a single piece. The cycle must be flagged, and the user must insert a rip edge.
3. **T-Junction Detection**: Check the degree of every edge in the topological graph. If an edge is shared by more than two planar faces (e.g. a middle flange forming a T-junction), it cannot be unfolded. The degree of all valid bend edges must be exactly $2$.
4. **Boundary Bend Check**: Validate that bend lines originate exclusively along the boundaries of the connected planar faces, not floating inside a face.

**Verification**:
The connectivity graph is verified using standard graph algorithms (BFS/DFS) operating on the topological graph extracted via OCCT.

---

### R-003: Superficial Disconnect Repair using `BRepBuilderAPI_Sewing`

**Decision**: Use OCCT's `BRepBuilderAPI_Sewing` with a configurable maximum tolerance gap of $0.1\text{ mm}$ (Option A) to stitch minor superficial gaps along seams before unfolding.

**Rationale**:
- `BRepBuilderAPI_Sewing` is extremely robust for resolving mismatched edge tolerances and stitching open shell boundaries into a closed manifold.
- Setting the sewing tolerance to $0.1\text{ mm}$ guarantees that minor translation or precision errors in the imported CAD file are silently healed without distorting the design's physical dimensions.
- If gaps remain after sewing (i.e. `BRepCheck_Analyzer` still detects open seams exceeding $0.1\text{ mm}$), the tool will reject the part and return detailed diagnostic coordinates of the open edges so the user can address them.

**Alternatives considered**:
- **Automatic face extension**: Extending co-planar faces to intersect. This was rejected for Phase 1 due to high complexity and risk of unexpected topological distortions in complex corner joints.

---

### R-004: Sharp-to-Curved Reconstruction via Filleting

**Decision**: Reconstruct the 3D model by replacing sharp joint transitions with realistic cylindrical bends using a default radius mapping where the internal radius equals the thickness ($R_i = t$) and the external radius equals twice the thickness ($R_e = 2t$).

**Rationale**:
- **Implementation Strategy**:
  1. Find the sharp edge shared by two planar faces.
  2. Apply `BRepFilletAPI_MakeFillet` to the interior sharp edge with fillet radius $R_i = t$.
  3. Apply `BRepFilletAPI_MakeFillet` to the corresponding exterior sharp edge with fillet radius $R_e = 2t$.
  4. This naturally replaces the sharp intersection with a uniform-thickness cylindrical bend.
- This K-factor-based neutral axis calculation is applied during flattening to compute the precise bend allowance (BA). The analytical 3D representation is built using these curved fillets so the refolded model represents real sheet metal.

**Verification**:
Standard solid model filleting is highly stable in OCCT and maintains manifold validity.

---

### R-005: DXF Layer Separation and Metadata Export

**Decision**: Export the flattened profile as a DXF file organized by functional layers ('CUT', 'BEND_UP', 'BEND_DOWN') with text annotations.

**Rationale**:
- The outer blank profile and internal cutout loops (holes, slots) are output on the `'CUT'` layer as closed polylines.
- During the BFS flattening traversal, the 3D bend edges are projected into the 2D coordinate system of the base face.
- These projected lines represent the bend centerlines and are output on `'BEND_UP'` or `'BEND_DOWN'` based on the sign of the rotation angle ($\theta$) between the normals.
- TEXT entities containing the bend angle (e.g. `90.0°`) and direction (e.g. `UP`) are placed adjacent to the centerlines on the respective bend layers.

---

## References & OCCT Header Map

To support these decisions, the following headers will be added to the geometry service translation unit:

```cpp
#include <BRepBuilderAPI_Sewing.hxx>        // Auto-sewing of disconnects
#include <BRepFilletAPI_MakeFillet.hxx>     // Sharp-to-curved fillet generation
#include <BRepAlgoAPI_Section.hxx>          // Boundary intersection computation
#include <Geom_CylindricalSurface.hxx>      // Curved bend validation
```
