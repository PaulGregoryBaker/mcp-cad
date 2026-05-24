# Research: Geometric Primitive Tools (006)

**Phase 0 output** | **Date**: 2026-05-24

---

## Research Questions & Findings

### R-001: XCAF availability in the current build

**Decision**: XCAF is available. No changes to `vcpkg.json` or `CMakeLists.txt` required.

**Rationale**: The project's `CMakeLists.txt` links `${OpenCASCADE_LIBRARIES}`, which vcpkg resolves to *all* OpenCASCADE modules in the installed distribution. vcpkg's `opencascade` package (7.8.1) ships with `TKXCAF`, `TKBinXCAF`, `TKXCAF`, `TKXDESTEP`, and `TKXDESSTEP` by default. The XCAF headers (`XCAFDoc_ShapeTool.hxx`, `TDocStd_Document.hxx`, etc.) are present in the vcpkg include tree.

**Verification**: The existing `generate_fixtures.cc` tool links `${OpenCASCADE_LIBRARIES}` without specifying modules — confirming the whole-library approach. Any XCAF inclusion in `geometry_service.cc` will compile without additional CMake changes.

**Alternatives considered**: Explicit module listing (e.g. `find_package(OpenCASCADE COMPONENTS TKXCAF REQUIRED)`) — rejected because the current approach already works and changing it risks breaking the existing build.

---

### R-002: Already-imported OCCT APIs that can be used immediately

**Decision**: Several APIs listed in `docs/MoreMCPTools.md` are already `#include`d in `geometry_service.cc` and simply need to be wired to NAPI — they will not require new imports.

| API | Status |
|---|---|
| `BRepAlgoAPI_Fuse` | ✅ Already `#include`d (line ~75 in geometry_service.cc) |
| `BRepAlgoAPI_Common` | ✅ Already `#include`d |
| `BRepFilletAPI_MakeFillet` | ✅ Already `#include`d |
| `BRepBuilderAPI_Sewing` | ✅ Already `#include`d |
| `ShapeFix_Shape` | ✅ Already `#include`d |
| `BRepBndLib` + `Bnd_Box` | ✅ Already `#include`d |
| `BRepGProp` + `GProp_GProps` | ✅ Already `#include`d |
| `BRepExtrema_DistShapeShape` | ✅ Already `#include`d |
| `TopExp_Explorer` | ✅ Already `#include`d |
| `gp_Trsf` | ✅ Implied by `gp_Pln` etc. — already included via `gp_Ax3.hxx` |

**New imports needed** (additions to `geometry_service.cc`):

```cpp
#include <BRepBuilderAPI_Transform.hxx>    // gp_Trsf application to shapes
#include <ShapeUpgrade_UnifySameDomain.hxx> // simplify_body
#include <BRepOffsetAPI_MakeOffsetShape.hxx> // offset_shape (3D, distinct from BRepOffsetAPI_MakeOffset)
// XCAF:
#include <TDocStd_Application.hxx>
#include <TDocStd_Document.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <XCAFDoc_Location.hxx>
#include <XDE_ShapeTool.hxx>              // if alias needed
#include <TDF_Label.hxx>
#include <TDF_LabelMapHasher.hxx>
```

All are in modules already linked.

**Rationale**: Identifying pre-included APIs reduces implementation risk and time. `BRepAlgoAPI_Fuse` and `BRepFilletAPI_MakeFillet` were imported for anticipated future use when the file was originally written (verified by checking `docs/OCCT_API_USAGE.md` — `BRepAlgoAPI_Fuse` is listed under "APIs Explicitly NOT Used" as deferred, confirming it's included but not yet wired up).

---

### R-003: `BRepOffsetAPI_MakeOffsetShape` vs `BRepOffsetAPI_MakeOffset`

**Decision**: Use `BRepOffsetAPI_MakeOffsetShape` for `offset_shape`.

**Rationale**:
- `BRepOffsetAPI_MakeOffset` (existing, used for kerf) operates on **2D wires/faces** (projections) — it's the right class for `offset_face` and kerf generation.
- `BRepOffsetAPI_MakeOffsetShape` operates on **3D shells/solids** — it offsets every face of a solid outward or inward by a scalar distance, producing a thickened or thinned solid. This is what `offset_shape` requires.
- Constructor: `BRepOffsetAPI_MakeOffsetShape(const TopoDS_Shape& S, Standard_Real Offset, Standard_Real Tol, BRepOffset_Mode Mode = BRepOffset_Skin, ...)`.
- Mode `BRepOffset_Skin` is the standard "skin offset" used for shell thickening.

**Alternatives considered**: `BRepOffsetAPI_MakeThickSolid` — considered for hollow-shell creation (removing a face and offsetting). Not needed for `offset_shape` since we keep all faces. Retained as a future tool candidate.

---

### R-004: Edge-ID resolution for fillet/chamfer

**Decision**: Use `TopExp_Explorer` iteration with `shapeId(edge)` matching. O(E) per call — acceptable.

**Rationale**: The project already resolves face IDs in `compute_intersections`, `splitBodyByBends`, and other tools using the same O(N) iteration pattern. Edge counts in the MVP are < 500 per solid (verified by fixture table in `OCCT_STABILITY.md`). At < 500 edges and < 50 ms per tool call budget, linear scan is fine.

**Implementation pattern**:
```cpp
FilletResult GeometryServiceImpl::filletEdges(const ShellId& partId,
    const std::vector<std::string>& edgeIds, double radiusMm) {
  auto it = shells_.find(partId);
  if (it == shells_.end()) throw GeometryError("GE_SHELL_NOT_FOUND", ...);

  const TopoDS_Shape& shape = it->second.shape;
  BRepFilletAPI_MakeFillet fillet(shape);

  TopExp_Explorer exp(shape, TopAbs_EDGE);
  std::set<std::string> requested(edgeIds.begin(), edgeIds.end());
  for (; exp.More(); exp.Next()) {
    const TopoDS_Edge& edge = TopoDS::Edge(exp.Current());
    if (requested.count(shapeId(edge))) {
      fillet.Add(radiusMm, edge);
    }
  }
  fillet.Build();
  if (!fillet.IsDone()) throw GeometryError("GE_FILLET_TOO_LARGE", ...);
  // ... register result, capture history
}
```

**Alternatives considered**: Pre-building an edge-ID → TDF_Label index at load time. Rejected — too complex and not needed at MVP scale.

---

### R-005: Transform body semantics — new shell ID vs in-place mutation

**Decision**: Transforms produce a **new `ShellId`**; the original is removed from `shells_` unless `keep_original: true`. The new id is returned.

**Rationale**: Consistent with every other mutating operation in the project (split, trim, merge, etc.). All mutations invalidate the input id and produce a new one. The `ShapeHistoryRecord`s link old face ids to new face ids via `verdict: "modified"`, which is exactly the mapping the semantic layer needs for remap.

`BRepBuilderAPI_Transform` always produces a new `TopoDS_Shape` (it copies). So the C++ side naturally produces a new object regardless — we simply register it under a new UUID and optionally delete the old UUID from the map.

**Alternatives considered**: In-place topology update (overwriting the old shape under the same id). Rejected — breaks shape history (the old face ids are gone, the semantic layer has no origin to remap from). Rejected also because `captureHistory` needs both the old shape and the new shape to enumerate pairs.

---

### R-006: `align_to_face` — surface normal extraction

**Decision**: Use `BRep_Tool::Surface(face, loc)` → dynamic cast to `Geom_Plane` → `Geom_Plane::Axis()` → `gp_Ax3`. Build the relative `gp_Trsf` between the two `gp_Ax3`s.

**Rationale**: For Phase 1 (planar-only), this is the standard pattern:

```cpp
Handle(Geom_Surface) surf = BRep_Tool::Surface(face, loc);
Handle(Geom_Plane) plane = Handle(Geom_Plane)::DownCast(surf);
if (plane.IsNull()) throw GeometryError("GE_ALIGN_UNSUPPORTED", "Non-planar face", true);
gp_Ax3 ax3 = plane->Position();
ax3.Transform(loc.IsIdentity() ? gp_Trsf() : loc.IsTopLevelTransformation());
// ... build trsf from src ax3 to dst ax3
```

Then `gp_Trsf::SetTransformation(srcAx3, dstAx3)` gives the required transform, applied via `BRepBuilderAPI_Transform`.

**Alternatives considered**: Using `BRepGProp_Face` for face centroid and `gp_Dir` for normal — more complex and error-prone for rotational alignment. The `gp_Ax3` approach directly encodes both the translation and rotation needed.

---

### R-007: XCAF assembly session state and rollback

**Decision**: Use a `std::unordered_map<ComponentId, TDF_Label>` as the component registry. Rollback saves/restores a copy of this map (labels are stable across mutations). The `TDocStd_Document` is not deep-copied; only the component-label registry is snapshotted.

**Rationale**: For Phase 1, the only mutable XCAF state is:
1. Which components exist (add_instance adds entries).
2. What location each component has (mate_rigid updates `XCAFDoc_Location`).

The existing `SnapshotRegistry` in the project stores a `ShellState` map snapshot. Assembly state is extended similarly. On rollback:
- Removed components: their `TDF_Label`s are marked invalid in XCAF via `XCAFDoc_ShapeTool::RemoveShape`. This is XCAF's standard approach.
- Changed locations: the saved label reference is used to re-apply the pre-op location via `XCAFDoc_Location::Set(label, savedLoc)`.

**Alternatives considered**: Full `TDocStd_Document` deep copy via `BinDrivers_DocumentRetrievalDriver` serialise-deserialise. Too slow and complex for the MVP's assembly scale.

---

### R-008: `TRANSACTION_REQUIRED` for assembly operations

**Decision**: Assembly mutations (`add_assembly_instance`, `mate_rigid`) require a `transaction_id` — same rule as all other mutations. `create_assembly_document` is a **special case**: it requires a `transaction_id` too, so the document's creation is rolled back if the transaction is discarded.

**Rationale**: Consistent with Constitution Principle IV. The `create_assembly_document` return value (`assembly_id`) must not outlast the transaction that created it.

**Alternatives considered**: Making `create_assembly_document` transaction-free (like session initialisation). Rejected — if the rest of the session is rolled back, a zombie assembly id would persist.

---

### R-009: `list_assembly_tree` — read or mutating?

**Decision**: `list_assembly_tree` is **non-mutating** (interrogation). No `transaction_id` required; reads current committed state.

**Rationale**: Consistent with `explore_topology`, `bounding_box`, etc. The tree structure is read-only. If called during an active transaction, it reads the pre-transaction assembly state (the committed state), not the in-flight changes. This is the same behaviour as `compute_intersections` etc.

**Alternatives considered**: Making it transaction-aware (showing in-flight instances). Deferred to Phase 2 — not needed for US6 acceptance scenarios.

---

### R-010: `measure_distance` — angle measurement between faces

**Decision**: For `measurement_type: "angle"`, restrict Phase 1 to **planar faces**. Extract both face normals via `BRep_Tool::Surface` → `Geom_Plane::Axis().Direction()`. Compute `Vd1.Angle(Vd2)` (radians, then convert to degrees). Non-planar faces return `GE_ALIGN_UNSUPPORTED` (reusing the "unsupported geometry" code; may be renamed `GE_MEASURE_UNSUPPORTED` in the error registry).

**Rationale**: `BRepExtrema_DistShapeShape` handles min/max distance between any two shapes robustly. Angle is a simpler special case restricted to the common planar-face use case.
