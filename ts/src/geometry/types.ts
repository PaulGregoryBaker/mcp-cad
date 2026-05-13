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

export interface TopologyGraph {
  solidId: string;
  faces: FaceNode[];
  edges: EdgeNode[];
  adjacency: AdjacencyEntry[];
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
