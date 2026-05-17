# Contract: Geometry Port Extensions

**Phase**: Phase 1 | **Status**: Draft  
**Feature**: 002-mcp-tools-gap | **Date**: 2026-05-17  
**Reference**: Engineering-Design.md §2.2 (GeometryPort), data-model.md

---

## Overview

This document defines the new methods added to the `GeometryPort` / `GeometryService` interface and the corresponding `GeometryBinding` wrapper in TypeScript.

`check_boundary_compliance` is **excluded** from this contract — it is implemented entirely in the MCP Protocol Layer using existing `getTopology()` output and Manufacturing Domain logistics config. No new C++ method is needed.

---

## C++ GeometryService Additions

New virtual methods appended to `cpp/src/geometry/geometry_service.hpp`:

```cpp
// ── Clash and gap detection (non-mutating) ─────────────────────────────────
virtual ClashReport computeIntersections(
    const std::vector<ShellId>& partIds) = 0;

virtual GapReport computeGaps(
    const ShellId& partAId,
    const ShellId& partBId,
    double         maxDistanceThresholdMm) = 0;

// ── Direct modeling mutations ──────────────────────────────────────────────
virtual TrimBodyResult trimBodyWithPlane(
    const ShellId&      partId,
    const CuttingPlane& plane,
    bool                keepPositiveSide) = 0;

virtual SplitBodyResult splitBodyByPlane(
    const ShellId&      partId,
    const CuttingPlane& plane,
    const std::string&  positiveOutputName,
    const std::string&  negativeOutputName) = 0;

virtual ExtendFaceResult extendFaceToTarget(
    const ShellId&     partId,
    const std::string& faceId,
    const std::string& targetType,   // "plane" | "face_id" | "part_surface"
    const std::string& targetPartId, // empty if targetType = "plane"
    const std::string& targetFaceId, // empty if targetType = "plane"
    const CuttingPlane& targetPlane  // used only when targetType = "plane"
) = 0;

virtual OffsetFaceResult offsetFace(
    const ShellId&     partId,
    const std::string& faceId,
    double             distanceMm) = 0;

// ── Sheet metal detailing ──────────────────────────────────────────────────
virtual AddFlangeResult addFlange(
    const ShellId&     partId,
    const std::string& edgeId,
    double             lengthMm,
    double             angleDeg,
    double             bendRadiusMm) = 0;

virtual RipEdgeResult ripEdge(
    const ShellId&     partId,
    const std::string& edgeId) = 0;

// ── Body topology ──────────────────────────────────────────────────────────
virtual MergeBodyResult mergeBodiesWithBend(
    const ShellId&             partAId,
    const ShellId&             partBId,
    const std::vector<std::string>& targetEdges,
    double                     bendRadiusMm) = 0;
```

---

## TypeScript GeometryAddon Interface Additions

New methods appended to the `GeometryAddon` interface in `ts/src/geometry/binding.ts`:

```typescript
computeIntersections(partIds: string[]): ClashReport;

computeGaps(
  partAId: string,
  partBId: string,
  maxDistanceThresholdMm: number,
): GapReport;

trimBodyWithPlane(
  partId: string,
  normal: { x: number; y: number; z: number },
  origin: { x: number; y: number; z: number },
  keepPositiveSide: boolean,
): TrimBodyResult;

splitBodyByPlane(
  partId: string,
  normal: { x: number; y: number; z: number },
  origin: { x: number; y: number; z: number },
  positiveOutputName: string,
  negativeOutputName: string,
): SplitBodyResult;

extendFaceToTarget(
  partId: string,
  faceId: string,
  targetType: 'plane' | 'face_id' | 'part_surface',
  targetPartId: string,
  targetFaceId: string,
  targetPlane: { normal: { x: number; y: number; z: number }; origin: { x: number; y: number; z: number } },
): ExtendFaceResult;

offsetFace(
  partId: string,
  faceId: string,
  distanceMm: number,
): OffsetFaceResult;

addFlange(
  partId: string,
  edgeId: string,
  lengthMm: number,
  angleDeg: number,
  bendRadiusMm: number,
): AddFlangeResult;

ripEdge(
  partId: string,
  edgeId: string,
): RipEdgeResult;

mergeBodiesWithBend(
  partAId: string,
  partBId: string,
  targetEdges: string[],
  bendRadiusMm: number,
): MergeBodyResult;
```

---

## GeometryBinding Wrapper Methods

Each addon method above gets a corresponding wrapper in `GeometryBinding` following the existing error-conversion pattern:

```typescript
computeIntersections(partIds: string[]): ClashReport {
  try {
    return this.addon.computeIntersections(partIds);
  } catch (err) {
    throw toStructuredError(err);
  }
}
// ... same pattern for all nine new methods
```

---

## Boundary Constraints

| Method | Mutates? | Snapshot required? |
|---|---|---|
| `computeIntersections` | No | No |
| `computeGaps` | No | No |
| `trimBodyWithPlane` | Yes | Yes — before operation |
| `splitBodyByPlane` | Yes | Yes — before operation |
| `extendFaceToTarget` | Yes | Yes — before operation |
| `offsetFace` | Yes | Yes — before operation |
| `addFlange` | Yes | Yes — before operation |
| `ripEdge` | Yes | Yes — before operation |
| `mergeBodiesWithBend` | Yes | Yes — before operation |
