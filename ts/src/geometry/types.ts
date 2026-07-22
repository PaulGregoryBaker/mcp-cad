/**
 * Geometry type definitions shared between binding.ts and session.ts.
 * These mirror the contracts/geometry-port.md type definitions.
 */

export interface FaceNode {
  faceId: string;
  surfaceType: 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'bspline' | 'other';
  areaMm2: number;
  normalX: number;
  normalY: number;
  normalZ: number;
}

export interface EdgeNode {
  edgeId: string;
  curveType: 'line' | 'circle' | 'ellipse' | 'bspline' | 'other';
  lengthMm: number;
}

export interface AdjacencyEntry {
  faceIdA: string;
  faceIdB: string;
  sharedEdgeId: string;
  dihedralAngleDeg: number;
}

// Phase C: manufactured features extracted from topology (populated when C++ ACL is wired in)
export interface TopologyBend {
  featureId: string;
  angleDeg: number;
  radiusMm: number;
  lengthMm: number;
  kFactor: number;
  bendAllowanceMm: number;
  faceIds: string[];
}

export interface TopologyHole {
  featureId: string;
  centerX: number;
  centerY: number;
  diameterMm: number;
  throughHole: boolean;
  faceId: string;
}

export interface TopologyFlange {
  featureId: string;
  widthMm: number;
  lengthMm: number;
  adjacentBendId: string;
  faceId: string;
}

export interface TopologyGraph {
  solidId: string;
  faces: FaceNode[];
  edges: EdgeNode[];
  adjacency: AdjacencyEntry[];
  // Optional: populated after ACL feature extraction (Phase C/D)
  bends?: TopologyBend[];
  holes?: TopologyHole[];
  flanges?: TopologyFlange[];
}

export interface ManifoldIssue {
  type: 'free_edge' | 'non_manifold_edge' | 'degenerate_face' | 'sliver_face';
  faceId?: string;
  edgeId?: string;
  description: string;
}

export interface ManifoldResult {
  isManifold: boolean;
  issues: ManifoldIssue[];
}

export interface ShapeHistoryRecord {
  verdict: 'modified' | 'generated' | 'deleted';
  original_id: string;
  new_id: string;
  operation_label: string;
}

export interface BooleanCutResult {
  shellIds: string[];
  rollbackToken: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface TabSlotResult {
  modifiedShellIds: string[];
  kerfOffsetApplied: number;
  rollbackToken: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface RivetHoleResult {
  modifiedShellId: string;
  holeFeatureId: string;
  rollbackToken: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface UnfoldResult {
  unfoldId: string;
  flatWidthMm: number;
  flatHeightMm: number;
  kFactorUsed: number;
  bendCount: number;
  validated?: boolean;
  detectedThickness?: number;
  rollbackToken: string;
  shape_history?: ShapeHistoryRecord[];
  improvedPartId?: string;
}

export interface DxfExportResult {
  dxfContent: string;
  wireCount: number;
  bboxWidthMm: number;
  bboxHeightMm: number;
}

export interface DxfSheetResult {
  sheetId: string;
}

export interface ThickenSheetResult {
  solidId: string;
}

export interface ApplyBendResult {
  mergedShellId: string;
}

export interface NapiBendZoneSpec {
  /** Hinge-line start X in DXF-local coordinates. */
  hingeX1: number;
  /** Hinge-line start Y in DXF-local coordinates. */
  hingeY1?: number;
  /** Hinge-line end X in DXF-local coordinates. */
  hingeX2: number;
  /** Hinge-line end Y in DXF-local coordinates. */
  hingeY2?: number;
  widthMm: number;
  angleDeg: number;
  innerRadiusMm: number;
  kFactor: number;
  // World-space fold frame used to place the rebuilt shell on the correct side
  // (canonical +X → bendDir, canonical +Z → foldNormal) — manufacturing-graph
  // data only; there is no live-shell fallback.
  foldNormalX?: number;
  foldNormalY?: number;
  foldNormalZ?: number;
  bendDirX?: number;
  bendDirY?: number;
  bendDirZ?: number;
  // World-space anchor: panel A's own oriented-bbox centre, computed from its
  // stored panelFrame + flat extents + midplaneOffsetMm. The flat centroid of
  // panel A's region in the merged DXF maps to this point.
  hasAnchor?: boolean;
  anchorX?: number;
  anchorY?: number;
  anchorZ?: number;
  // How far Panel B's TRUE hinge edge sits inside its own flat pattern, past
  // its near/glue edge — zero (default) when B's hinge IS its own DXF
  // origin. Nonzero when B is a composite panel with material continuing
  // past its hinge with A (e.g. a flange tab overhanging a wall's own bend
  // line): B's DXF origin then sits at its far/free edge instead, and this
  // tells the fold where the true pivot is within B's own flat extent.
  bHingeOffsetMm?: number;
}

// Explicit placement frame for buildShellFromFlatPattern's coplanar (no bend
// zones) path. world = origin + x*U + y*V + (z - t/2)*N + nCentreMm*N. All
// values come from the manufacturing graph (a panel's stored panelFrame +
// midplaneOffsetMm) — there is no live-shell fallback when hasFrame is false.
export interface FlatPanelPlacement {
  hasFrame: boolean;
  originX: number;
  originY: number;
  originZ: number;
  uX: number;
  uY: number;
  uZ: number;
  vX: number;
  vY: number;
  vZ: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  nCentreMm: number;
}

export interface BuildShellFromFlatPatternResult {
  shellId: string;
}

// Oriented panel frame P(x): local (u, v, n) → world via origin + u*U + v*V + n*N.
// uExtent/vExtent are the true in-plane flat dimensions (tilt-independent).
export interface PanelFrameResult {
  originX: number;
  originY: number;
  originZ: number;
  uX: number;
  uY: number;
  uZ: number;
  vX: number;
  vY: number;
  vZ: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  uExtentMm: number;
  vExtentMm: number;
  thicknessMm: number;
  // Outer-wire boundary, already projected onto (u, v) and shifted local to
  // origin — each point lies in [0,uExtentMm] x [0,vExtentMm]. Self-consistent
  // by construction with origin/u/v/extents above.
  ring: Array<{ x: number; y: number }>;
}

export interface NestPlacement {
  unfoldId: string;
  sheetIndex: number;
  x: number;
  y: number;
  rotationDeg: number;
}

export interface NestResult {
  nestId: string;
  placements: NestPlacement[];
  utilisationPct: number;
  sheetsRequired: number;
}

export interface RestoreResult {
  restoredSolidIds: string[];
  restoredShellIds: string[];
}

// ─── Gap-closure tool types ───────────────────────────────────────────────────

export interface CuttingPlane {
  normal: { x: number; y: number; z: number };
  origin: { x: number; y: number; z: number };
}

interface BBox3 {
  origin: { x: number; y: number; z: number };
  dimensions: { x: number; y: number; z: number };
}

export interface ClashPair {
  partIdA: string;
  partIdB: string;
  intersectionVolumeMm3: number;
  clashBoundingBox: BBox3;
  suggestedCuttingPlane: CuttingPlane;
}

export interface ClashReport {
  intersects: boolean;
  clashes: ClashPair[];
}

export interface GapReport {
  hasGap: boolean;
  minimumDistanceMm: number;
  closestElements: { partAFaceId: string; partBFaceId: string };
  extensionVector: { x: number; y: number; z: number };
  gapBoundingBox: BBox3;
}

export interface TrimBodyResult {
  trimmedShellId: string;
  rollbackToken: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface SplitBodyResult {
  positiveShellId: string;
  negativeShellId: string;
  rollbackToken: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface ExtendFaceResult {
  modifiedShellId: string;
  extensionDistanceMm: number;
  rollbackToken: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface OffsetFaceResult {
  modifiedShellId: string;
  rollbackToken: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface AddFlangeResult {
  modifiedShellId: string;
  flangeFeatureId: string;
  rollbackToken: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface RipEdgeResult {
  modifiedShellId: string;
  rollbackToken: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface MergeBodyResult {
  mergedShellId: string;
  rollbackToken: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface CloseGapResult {
  partBId: string;
  gapClosedMm: number;
  rollbackToken: string;
}

export interface PanelValidationError {
  code: string; // e.g. "GE_PANEL_DISCONNECTED"
  message: string; // human-readable explanation
}

export interface PanelValidationResult {
  isValid: boolean;
  canFlatten: boolean;
  nominalThicknessMm: number;
  errors: PanelValidationError[];
}

// ── Assembly IDs ──────────────────────────────────────────────────────────────
export type AssemblyId = string;
export type ComponentId = string;

// ── Boolean results ───────────────────────────────────────────────────────────
export interface FuseResult {
  solid_id: string;
  disjoint: boolean;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface CutResult {
  solid_id: string;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface IntersectResult {
  solid_id: string;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

// ── Interrogation results ─────────────────────────────────────────────────────
export interface BoundingBoxResult {
  x_min: number;
  y_min: number;
  z_min: number;
  x_max: number;
  y_max: number;
  z_max: number;
}

export interface MassPropertiesResult {
  volume?: number;
  surface_area?: number;
  centroid?: [number, number, number];
  inertia_tensor?: [number, number, number, number, number, number, number, number, number];
}

export interface MeasureResult {
  value: number;
  measurement_type: string;
}

export interface ExploreResult {
  entity_ids: string[];
}

// ── Transform result ──────────────────────────────────────────────────────────
export interface TransformResult {
  solid_id: string;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

// ── Direct edit results ───────────────────────────────────────────────────────
export interface FilletResult {
  solid_id: string;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}
export interface ChamferResult extends FilletResult {} // same shape
export interface SimplifyResult extends FilletResult {}
export interface OffsetShapeResult extends FilletResult {}

export interface HealExResult {
  solid_id: string;
  heal_complete: boolean;
  remaining_issues: string[];
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface DeleteFaceResult {
  solid_ids: string[];
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

// ── Sewing ────────────────────────────────────────────────────────────────────
export interface SewResult {
  solid_id: string;
  sew_complete: boolean;
  free_edges: string[];
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

// ── Assembly ──────────────────────────────────────────────────────────────────
export interface CreateAssemblyResult {
  assembly_id: string;
}

export interface AddInstanceResult {
  component_id: string;
  rollback_token: string;
}

export type LocationMatrix16 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface MateRigidResult {
  component_id: string;
  location_matrix: LocationMatrix16;
  rollback_token: string;
}

export interface AssemblyNode {
  component_id: string;
  shape_id: string;
  location_matrix: LocationMatrix16;
  children: AssemblyNode[];
}

export interface ListAssemblyResult {
  assembly_id: string;
  root: AssemblyNode;
}

// ── Feature 007-sheet-metal-unfolding ───────────────────────────────────────
export interface SheetMetalValidationResult {
  is_valid: boolean;
  nominal_thickness: number;
  can_flatten: boolean;
  validation_errors: string[];
}

// Dominant Face Method: thickness = distance between the shape's single
// largest planar face and its best anti-parallel, overlapping partner.
export interface PanelThicknessResult {
  ok: boolean;
  thickness_mm: number;
  midplane_offset_mm: number;
  // The dominant face's own outward normal that midplane_offset_mm was
  // projected onto — an arbitrary tie-break between a panel's two near-equal-
  // area skins. Callers re-expressing the offset along a DIFFERENT reference
  // normal (e.g. a panel frame's own N) must check
  // dot(dominant_normal, theirNormal) and negate midplane_offset_mm when
  // negative.
  dominant_normal_x: number;
  dominant_normal_y: number;
  dominant_normal_z: number;
  error_code: string;
  message: string;
}

export interface GapSewResult {
  solid_id: string;
  sew_complete: boolean;
  max_gap_found: number;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface CurvedRebuildResult {
  solid_id: string;
  bends_replaced: number;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

// ── Feature 008-splits-by-bends-viewport-alignment ───────────────────────────
export interface AlignmentResult {
  solid_id: string;
  centroid: [number, number, number];
  rotation_matrix: [number, number, number, number, number, number, number, number, number];
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface SplitBodyByBendsResult {
  panel_ids: string[];
  panel_count: number;
  panel_bboxes: Array<{
    x_min: number;
    y_min: number;
    z_min: number;
    x_max: number;
    y_max: number;
    z_max: number;
  }>;
  protrusion_ids: string[];
  protrusion_count: number;
  protrusion_bboxes: Array<{
    x_min: number;
    y_min: number;
    z_min: number;
    x_max: number;
    y_max: number;
    z_max: number;
  }>;
  protrusion_parents: Array<{ protrusion_id: string; parent_panel_id: string | null }>;
  detected_mode: string;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface RemoveProtrusionsResult {
  cleaned_part_id: string;
  protrusion_ids: string[];
  protrusion_bboxes: Array<{
    x_min: number;
    y_min: number;
    z_min: number;
    x_max: number;
    y_max: number;
    z_max: number;
  }>;
  protrusion_count: number;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

// ── Feature 009-validate-all ──────────────────────────────────────────────────
export interface AutofixRecommendation {
  tool_name: string;
  arguments: Record<string, any>;
}

export interface ValidationError {
  id: string;
  category: 'sheet_metal' | 'clash_detection' | 'semantic_graph' | 'manufacturing' | 'nesting';
  severity: 'error' | 'warning' | 'info';
  message: string;
  affected_part_ids: string[];
  autofix?: AutofixRecommendation;
}

export interface ValidationReport {
  valid: boolean;
  errors: ValidationError[];
  summary: {
    total_parts_checked: number;
    rule_count: number;
    execution_time_ms: number;
  };
}

// ── Phase 5 Slice 1: graph-authored construction (manufacturing_graph_evaluator) ──
//
// Mirrors cpp/src/geometry/translation/manufacturing_graph_evaluator.hpp and
// part_solid_construction.hpp field-for-field (see cpp/src/napi/translation_binding.cc
// for the exact marshaling). No geometric computation happens on the TS side
// (constitution v2.0.0 principle IV) — these types only carry data in and out of
// evaluatePartGraph/constructPartSolid.

export interface NapiPoint2 {
  x: number;
  y: number;
}

export interface NapiPoint3 {
  x: number;
  y: number;
  z: number;
}

// Row-major 3x3 rotation (r, 9 elements) + translation (t, 3 elements) — the
// same layout Transform3 itself uses in C++, so this is a direct field copy.
export interface NapiTransform3 {
  r: [number, number, number, number, number, number, number, number, number];
  t: [number, number, number];
}

export interface NapiBendSpec {
  id: string;
  parentRegionPanelId: string;
  childRegionPanelId: string;
  hingeA: NapiPoint2;
  hingeB: NapiPoint2;
  angleDeg: number;
  radiusMm?: number;
  kFactor?: number;
}

export interface NapiPartGraphSpec {
  partId: string;
  rootRegionPanelId: string;
  outline: { outer: NapiPoint2[] };
  bends: NapiBendSpec[];
  thicknessMm: number;
  anchor?: { transform: NapiTransform3 };
}

export interface NapiRegionPanelLayout {
  regionPanelId: string;
  regionOuter: NapiPoint2[];
  bottomFace: NapiPoint3[];
  topFace: NapiPoint3[];
  pose: NapiTransform3;
  // edgeBendId[i] names the bend whose zone the edge (regionOuter[i],
  // regionOuter[i+1]) borders, or "" for a true outer boundary.
  edgeBendId: string[];
}

export interface NapiBridgeLayout {
  bendId: string;
  parentRegionPanelId: string;
  childRegionPanelId: string;
  pivotOriginWorld: NapiPoint3;
  pivotAxisWorld: NapiPoint3;
  angleDeg: number;
}

export interface EvaluatePartGraphResult {
  ok: boolean;
  errorCode: string; // "" | "GE_TREE_CYCLE_DETECTED" | "GE_BEND_SELF_REFERENCE" |
  // "GE_DANGLING_BEND_REFERENCE" | "GE_REGION_CLIP_FAILED" | "GE_DEGENERATE_OUTLINE"
  message: string;
  panels: NapiRegionPanelLayout[];
  bridges: NapiBridgeLayout[];
}

export interface ConstructPartSolidResult {
  ok: boolean;
  shellId: string;
  errorCode: string; // "" | "GE_INVALID_LAYOUT" | "GE_EMPTY_LAYOUT" |
  // "GE_INVALID_SHEET_METAL" | "GE_POLYGON_BUILD_FAILED" | "GE_EXTRUDE_FAILED" |
  // "GE_BRIDGE_EDGE_NOT_FOUND" | "GE_BRIDGE_UNSUPPORTED_TOPOLOGY" |
  // "GE_BRIDGE_BUILD_FAILED" | "GE_CONSTRUCTION_FAILED"
  message: string;
}

// rebuild/13-translation-module-design.md §4/§5 — Phase 5 Slice 3.
export interface MapToWorldResult {
  ok: boolean;
  errorCode: string; // "" | "GE_POINT_NOT_ON_PART" | "GE_INVALID_LAYOUT"
  message: string;
  point3d: NapiPoint3;
  // Exactly one of these is non-empty on success.
  regionPanelId: string;
  bendId: string;
}

export interface MapToFlatResult {
  ok: boolean;
  errorCode: string; // "" | "GE_POINT_NOT_ON_PART" | "GE_INVALID_LAYOUT"
  message: string;
  point2d: NapiPoint2;
  regionPanelId: string;
  bendId: string;
  residualMm: number;
}

// rebuild/14-graph-schema.md §2.1.2 / part_merge.hpp — Phase 5 Slice 4. Pure
// 2D outline reconciliation for merge_bodies_with_bend: given a free edge on
// each of two parts' outlines, returns the spliced combined outline plus the
// shared hinge segment (in A's frame). No graph bookkeeping (region panels,
// bends, re-parenting) happens here — that's GraphStore.mergePartsWithBend's
// job, reusing this purely-geometric result.
export interface ReconcileOutlinesResult {
  ok: boolean;
  errorCode: string; // "" | "GE_INVALID_EDGE_REF" | "GE_MERGE_EDGE_MISMATCH" | "GE_MERGE_SELF_INTERSECTION"
  message: string;
  combinedOutline: NapiPoint2[];
  hingeA: NapiPoint2;
  hingeB: NapiPoint2;
}
