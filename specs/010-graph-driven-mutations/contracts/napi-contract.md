# NAPI Contract: buildShellFromFlatPattern

**Feature**: 010-graph-driven-mutations | **Updated**: 2026-06-06

---

## New Method: `buildShellFromFlatPattern`

### TypeScript signature

In `ts/src/geometry/binding.ts` — `GeometryAddon` interface and `GeometryBinding` interface:

```typescript
// BendZoneSpec — passed as a plain JS object array over the NAPI boundary
interface NapiBendZoneSpec {
  offsetMm: number;       // x-position of bend zone start in flat pattern (mm)
  widthMm: number;        // bend allowance width (mm)
  angleDeg: number;       // bend angle in degrees (90.0 for MVP)
  innerRadiusMm: number;  // inner bend radius (mm)
  kFactor: number;        // 0 < k ≤ 1
}

// Added to GeometryAddon (full NAPI interface)
buildShellFromFlatPattern(
  dxfContent: string,
  bendZones: NapiBendZoneSpec[],
  thicknessMm: number
): { shellId: string };

// Added to GeometryBinding (solver-facing subset)
buildShellFromFlatPattern?(
  dxfContent: string,
  bendZones: NapiBendZoneSpec[],
  thicknessMm: number
): { shellId: string };
```

The method is optional on `GeometryBinding` (matching the existing pattern for `buildSheetFromDxf`, `thickenSheet`, `applyBend`) — the solver falls back gracefully if the native addon predates this method.

### C++ signature

In `cpp/src/geometry/geometry_service.hpp`:

```cpp
struct BendZoneSpec {
  double offsetMm;
  double widthMm;
  double angleDeg;
  double innerRadiusMm;
  double kFactor;
};

struct BuildShellFromFlatPatternResult {
  std::string shellId;   // registered UUID; empty on failure
  bool ok;
  std::string errorCode; // "GE_BUILD_FROM_PATTERN_FAILED" | ""
  std::string message;
};

BuildShellFromFlatPatternResult buildShellFromFlatPattern(
  const std::string& dxfContent,
  const std::vector<BendZoneSpec>& bendZones,
  double thicknessMm
);
```

### NAPI binding (geometry_binding.cc)

`bendZones` is received as a JavaScript `Array` of objects; each element is read with `Napi::Object::Get` by field name and converted to `BendZoneSpec`.

---

## Behaviour Contract

| Scenario | Input | Expected output |
|----------|-------|----------------|
| Flat panel | Valid DXF, `bendZones = []`, `thicknessMm > 0` | Flat solid panel, correct footprint and thickness |
| Single 90° bend | Valid DXF, one bend zone at offset X, `angleDeg = 90` | Folded shell that unfolds back to input DXF ±1mm |
| Invalid DXF | No closed polyline in `dxfContent` | `ok: false`, `errorCode: "GE_BUILD_FROM_PATTERN_FAILED"` |
| Non-positive thickness | `thicknessMm ≤ 0` | `ok: false`, `errorCode: "GE_BUILD_FROM_PATTERN_FAILED"` |
| Bend offset exceeds DXF width | `offsetMm + widthMm > flatWidth` | `ok: false`, `errorCode: "GE_BUILD_FROM_PATTERN_FAILED"` |

### Round-trip contract (SC-003)

```
let shell = buildShellFromFlatPattern(dxf, [{offset:X, width:BA, angleDeg:90, radius:R, kFactor:K}], t)
let unfold = unfoldShell(shell.shellId, kFactor: K)
let outDxf = exportDxf(unfold.unfoldId)
// outDxf bounding box must match input dxf bounding box within ±1mm
```

This contract is enforced by the integration test `ts/tests/integration/merge_unfold_dxf_content.test.ts`.

---

## Implementation Strategy (C++)

For a single bend zone (MVP scope — 90° only):

```
1. Parse input DXF → flat ring (use existing DXF parser from buildSheetFromDxf)
2. Validate: ring closed, thicknessMm > 0, bend zone within bounds
3. Split flat ring at [offsetMm, offsetMm + widthMm]:
     subDxfA: x ∈ [0, offsetMm]           → panel A outline
     subDxfB: x ∈ [offsetMm + widthMm, flatWidth] → panel B outline
4. Build solids:
     sheetA  = buildSheetFromDxf(subDxfA)
     solidA  = thickenSheet(sheetA, thicknessMm)
     sheetB  = buildSheetFromDxf(subDxfB)
     solidB  = thickenSheet(sheetB, thicknessMm)
5. Fold:
     merged  = applyBend(solidA, solidB, innerRadiusMm, angleDeg, kFactor)
6. Register merged shell UUID → return BuildShellFromFlatPatternResult { shellId: merged }
```

For zero bend zones: skip steps 3–5; return result of `thickenSheet(buildSheetFromDxf(dxfContent), thicknessMm)`.
