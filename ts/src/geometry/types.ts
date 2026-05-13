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

export interface BooleanCutResult {
  shellIds: string[];
  rollbackToken: string;
}

export interface TabSlotResult {
  modifiedShellIds: string[];
  kerfOffsetApplied: number;
  rollbackToken: string;
}

export interface RivetHoleResult {
  modifiedShellId: string;
  holeFeatureId: string;
  rollbackToken: string;
}

export interface UnfoldResult {
  unfoldId: string;
  flatWidthMm: number;
  flatHeightMm: number;
  kFactorUsed: number;
  bendCount: number;
  rollbackToken: string;
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
