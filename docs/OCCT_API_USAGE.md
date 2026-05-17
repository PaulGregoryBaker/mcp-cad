# OCCT API Usage Audit

**Task**: T018 | **Date**: 2026-05-13  
**Purpose**: Document which OCCT APIs are used; audit surface for stability.

---

## Principles

1. **Facade isolation**: All OCCT APIs are accessed exclusively through `cpp/src/geometry/geometry_service.hpp`. No OCCT types leak into NAPI or TypeScript layers.
2. **Version pin**: OCCT 7.8.1 is pinned in `cpp/vcpkg.json`. No upgrades without re-running fixture suite.
3. **Exception wrapping**: All `Standard_Failure` exceptions are caught at `geometry_service.cc` boundaries and converted to structured JavaScript `Error` objects.

---

## OCCT Module Usage

### TKernel — Core types

| API | Usage | Stability |
|-----|-------|-----------|
| `Standard_Failure` | Exception base class | ✅ Stable |
| `TCollection_AsciiString` | String operations | ✅ Stable |
| `NCollection_Sequence` | Collection type | ✅ Stable |

---

### TKMath — Math primitives

| API | Usage | Stability |
|-----|-------|-----------|
| `gp_Pnt` | 3D point | ✅ Stable |
| `gp_Vec` | 3D vector | ✅ Stable |
| `gp_Dir` | Unit direction | ✅ Stable |
| `gp_Pln` | Plane (for boolean cut) | ✅ Stable |
| `gp_Trsf` | Transformation | ✅ Stable |

---

### TKBRep — B-Rep data structures

| API | Usage | Stability |
|-----|-------|-----------|
| `TopoDS_Shape` | Generic shape | ✅ Stable |
| `TopoDS_Solid` | 3D solid | ✅ Stable |
| `TopoDS_Shell` | Shell (after decomp) | ✅ Stable |
| `TopoDS_Face` | Single face | ✅ Stable |
| `TopoDS_Edge` | Single edge | ✅ Stable |
| `BRep_Tool::Surface` | Extract surface from face | ✅ Stable |
| `BRep_Tool::Curve` | Extract curve from edge | ✅ Stable |
| `BRepTools` | B-Rep I/O utilities | ✅ Stable |

---

### TKTopAlgo — Topology algorithms

| API | Usage | Stability |
|-----|-------|-----------|
| `TopExp_Explorer` | Iterate topology (faces, edges) | ✅ Stable |
| `TopExp::MapShapes` | Index shape elements | ✅ Stable |
| `BRepCheck_Analyzer` | Manifold detection | ✅ Stable |
| `ShapeFix_Shape` | Topological healing | ✅ Stable (minor caveats — see OCCT_STABILITY.md) |

---

### TKBool — Boolean operations

| API | Usage | Stability |
|-----|-------|-----------|
| `BRepAlgoAPI_Cut` | Volume decomposition; `trim_body_with_plane` keeps one half | ⚠️ See OCCT_STABILITY.md §Brittle Operations |
| `BRepAlgoAPI_Section` | Cross-section extraction | ⚠️ Near-tangent face edge case |
| `BRepAlgoAPI_Common` | `compute_intersections` — computes volumetric intersection between shell pairs | ⚠️ Can raise `Standard_Failure` on degenerate inputs |
| `BRepPrimAPI_MakeHalfSpace` | `trim_body_with_plane` — builds infinite cutting tool from plane face | ✅ Stable |

**Mitigation**: Wrap in `try { ... } catch (Standard_Failure& e)`. Return `GE_BOOLEAN_FAILURE` / `GE_CLASH_DETECTION_FAILED` / `GE_TRIM_FAILED` as appropriate.

---

### TKOffset — Offset operations

| API | Usage | Stability |
|-----|-------|-----------|
| `BRepOffsetAPI_MakeOffset` | Kerf offset for tab-slot; also used for `offset_face` (post-INF-03) | ✅ Stable for convex shapes |
| `BRepOffsetAPI_MakeFlatFace` | Sheet metal unfolding fallback | ⚠️ Post-MVP only (180° hems) |

---

### TKSTEP — STEP import/export

| API | Usage | Stability |
|-----|-------|-----------|
| `STEPControl_Reader` | STEP AP203/AP214 import | ✅ Stable |
| `Interface_Static::SetCVal` | Tolerance configuration | ✅ Stable |
| `IFSelect_ReturnStatus` | Import status checking | ✅ Stable |

---

### TKShHealing — Shape healing

| API | Usage | Stability |
|-----|-------|-----------|
| `ShapeFix_Shape` | Post-import shape healing | ✅ Stable |
| `ShapeFix_Edge` | Edge geometry repair | ✅ Stable |
| `ShapeFix_Face` | Degenerate face repair | ✅ Stable |

---

### TKGeomAlgo — Distance and metric computation

| API | Usage | Stability |
|-----|-------|-----------|
| `BRep_DistShapeShape` | `compute_gaps` — minimum distance between two shells, including closest sub-shape pair | ✅ Stable |
| `GProp_GProps` + `BRepGProp::VolumeProperties` | `compute_intersections` — volumetric mass of intersection body; `compute_gaps` — centroid for plane orientation | ✅ Stable |
| `Bnd_Box` + `BRepBndLib::Add` | `compute_intersections` — axis-aligned bounding box of clash region | ✅ Stable |

---

## APIs Explicitly NOT Used (Deferred Post-MVP)

| API | Reason Deferred |
|-----|-----------------|
| `BRepOffsetAPI_MakeFlatFace` (full) | CadQuery handles MVP unfolding |
| `BRepPrimAPI_MakeSphere/Cylinder` | No primitive creation needed |
| `Geom_BSplineSurface` (authoring) | Read-only; no NURBS authoring |
| `STEPControl_Writer` | STEP assembly export post-MVP |
| `BRepAlgoAPI_Fuse` | `merge_bodies_with_bend` — post-INF-03 scope |
| `BRepBuilderAPI_MakeWire` (for rip) | `rip_edge` — post-INF-03 scope |

---

## Exception Handling Pattern

All OCCT calls follow this wrapper pattern in `geometry_service.cc`:

```cpp
try {
  // OCCT operation
  STEPControl_Reader reader;
  reader.ReadFile(filePath.c_str());
  reader.TransferRoots();
  // ...
} catch (const Standard_Failure& e) {
  throw std::runtime_error(
    std::string("{\"code\":\"GE_IMPORT_FAILED\",\"message\":\"") +
    e.GetMessageString() + "\"}"
  );
}
```

NAPI wrapper converts `std::runtime_error` to JavaScript `Error` with JSON-parsed `code`.
