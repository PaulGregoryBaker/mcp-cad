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
  code: string;     // e.g. "GE_PANEL_DISCONNECTED"
  message: string;  // human-readable explanation
}

export interface PanelValidationResult {
  isValid: boolean;
  canFlatten: boolean;
  nominalThicknessMm: number;
  errors: PanelValidationError[];
}

// ── Assembly IDs ──────────────────────────────────────────────────────────────
export type AssemblyId  = string;
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
  x_min: number; y_min: number; z_min: number;
  x_max: number; y_max: number; z_max: number;
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
export interface ChamferResult  extends FilletResult {}   // same shape
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
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number
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
  panel_bboxes: Array<{ x_min: number; y_min: number; z_min: number; x_max: number; y_max: number; z_max: number }>;
  protrusion_ids: string[];
  protrusion_count: number;
  protrusion_bboxes: Array<{ x_min: number; y_min: number; z_min: number; x_max: number; y_max: number; z_max: number }>;
  protrusion_parents: Array<{ protrusion_id: string; parent_panel_id: string | null }>;
  detected_mode: string;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface RemoveProtrusionsResult {
  cleaned_part_id: string;
  protrusion_ids: string[];
  protrusion_bboxes: Array<{ x_min: number; y_min: number; z_min: number; x_max: number; y_max: number; z_max: number }>;
  protrusion_count: number;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}
