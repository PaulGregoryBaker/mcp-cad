/**
 * Manufacturing Graph type definitions.
 * All entities for the sheet-metal intent DAG.
 *
 * Spec: specs/009-manufacturing-graph/data-model.md
 * Tasks: T002, T032
 */

import type { PanelFrame } from '../dxf/orientation';
export type { PanelFrame };

// ─── Branded ID types ─────────────────────────────────────────────────────────

/** Caller-supplied human-readable node identifier. Stable across Geometry Solves. */
export type NodeId = string & { readonly __brand: 'NodeId' };

/** Server-generated UUID for a B-Rep body. Volatile — replaced on every Solve. */
export type BodyId = string & { readonly __brand: 'BodyId' };

/** Cast a plain string to NodeId (validated at system boundaries). */
export function toNodeId(s: string): NodeId {
  if (s.trim().length === 0) throw new Error('NodeId must be non-empty');
  return s as NodeId;
}

/** Cast a plain string to BodyId. */
export function toBodyId(s: string): BodyId {
  return s as BodyId;
}

// ─── Node types ───────────────────────────────────────────────────────────────

export interface PanelNode {
  readonly type: 'PanelNode';
  id: NodeId;
  bodyId: BodyId | null;       // null before first Geometry Solve
  dirty: boolean;
  materialType: string;         // key in the loaded material table
  nominalThickness: number;     // mm
  flatWidth: number | null;     // mm — null before first Solve
  flatHeight: number | null;    // mm — null before first Solve
  canonical: boolean;           // true if this is the canonical unfold target in a merged graph
  shapeDxf: string | null;      // DXF content of flat panel outline & details; the source of truth manufacturing drawing; null before split_body_by_bends
  panelFrame?: PanelFrame | null; // 3D orientation frame (origin, u, v axes); derived from bbox at split time
}

export interface BendNode {
  readonly type: 'BendNode';
  id: NodeId;
  dirty: boolean;
  panelAId: NodeId;             // upstream panel
  panelBId: NodeId;             // downstream panel
  innerRadius: number;          // mm, > 0
  angle: number;                // degrees, 1–179 inclusive
  kFactor: number;              // 0 < k ≤ 1
  bendAllowance: number | null; // mm — computed by Solve; null before first Solve
}

// ─── JoinNode params ──────────────────────────────────────────────────────────

export type JoinType = 'FLANGE' | 'TAB_SLOT' | 'RIVET_PATTERN' | 'WELD_PREP';

export interface RivetPatternParams {
  readonly joinParamType: 'RIVET_PATTERN';
  spacing: number;              // mm, centre-to-centre
  diameter: number;             // mm, rivet hole diameter
  edgeOffset: number;           // mm, distance from panel edge
}

export interface FlangeParams {
  readonly joinParamType: 'FLANGE';
  width: number;                // mm, flange lip width
  bendAngle: number;            // degrees, 1–179
}

export interface TabSlotParams {
  readonly joinParamType: 'TAB_SLOT';
  tabWidth: number;             // mm
  tabDepth: number;             // mm
  count: number;                // number of tab-slot pairs along the edge
}

export interface WeldPrepParams {
  readonly joinParamType: 'WELD_PREP';
  grooveAngle: number;          // degrees (e.g. 60 for V-groove)
  rootGap: number;              // mm
}

export type JoinParams = RivetPatternParams | FlangeParams | TabSlotParams | WeldPrepParams;

export interface JoinNode {
  readonly type: 'JoinNode';
  id: NodeId;
  dirty: boolean;
  panelAId: NodeId;
  panelBId: NodeId;
  referenceEdgeA: string;       // edge identifier in panel A's local frame
  referenceEdgeB: string;       // edge identifier in panel B's local frame
  joinType: JoinType;
  params: JoinParams;
}

// ─── CutNode profiles ─────────────────────────────────────────────────────────

export interface CircleProfile {
  readonly type: 'CIRCLE';
  centreX: number;              // mm, panel-local
  centreY: number;              // mm, panel-local
  radius: number;               // mm, > 0
}

export interface RectangleProfile {
  readonly type: 'RECTANGLE';
  originX: number;              // mm, panel-local (bottom-left corner)
  originY: number;              // mm, panel-local
  width: number;                // mm, > 0
  height: number;               // mm, > 0
}

export interface PolygonProfile {
  readonly type: 'POLYGON';
  vertices: ReadonlyArray<{ x: number; y: number }>;  // ≥ 3 vertices, panel-local
}

export interface FreeformProfile {
  readonly type: 'FREEFORM';
  vertices: ReadonlyArray<{ x: number; y: number }>;  // ≥ 3 vertices, panel-local; closure implicit
}

export type CutProfile = CircleProfile | RectangleProfile | PolygonProfile | FreeformProfile;

export interface CutNode {
  readonly type: 'CutNode';
  id: NodeId;
  dirty: boolean;
  parentPanelId: NodeId;
  profile: CutProfile;
  label?: string;               // optional DXF annotation label
}

// ─── Discriminated union ──────────────────────────────────────────────────────

export type GraphNode = PanelNode | BendNode | JoinNode | CutNode;

// ─── Manufacturing Graph container ────────────────────────────────────────────

export interface ManufacturingGraphData {
  sessionId: string;
  rootPanelId: NodeId | null;
  nodes: Map<NodeId, GraphNode>;
  /** Outgoing edges: A → downstream */
  edges: Map<NodeId, Set<NodeId>>;
  /** Incoming edges (for Kahn's in-degree) */
  reverseEdges: Map<NodeId, Set<NodeId>>;
  dirtyNodes: Set<NodeId>;
  coplanarityThresholdDeg: number;
}

// ─── Geometry Solve result ────────────────────────────────────────────────────

export interface SolvedNode {
  nodeId: NodeId;
  newBodyId: BodyId;
}

export interface GeometrySolveResult {
  solveId: string;              // UUID
  timestamp: string;            // ISO 8601
  solvedNodes: SolvedNode[];
  invalidatedBodyIds: BodyId[];
  dirtyCountBefore: number;
  solveMs: number;
}

// ─── Graph-driven geometry reconstruction plan ───────────────────────────────

export type GeometryRebuildStepType =
  | 'BUILD_PANEL_FROM_DXF'
  | 'THICKEN_PANEL'
  | 'APPLY_BEND'
  | 'APPLY_JOIN'
  | 'APPLY_CUT'
  | 'PLACE_IN_ASSEMBLY';

export interface GeometryRebuildStep {
  stepType: GeometryRebuildStepType;
  nodeId: NodeId;
  detail: Record<string, unknown>;
}

export interface GeometryRebuildPlan {
  partId: string;
  orderedNodeIds: NodeId[];
  steps: GeometryRebuildStep[];
}

// ─── DRC types ────────────────────────────────────────────────────────────────

export type DrcSeverity = 'ERROR' | 'WARNING';

export interface DrcViolation {
  ruleId: string;
  errorCode: string;
  message: string;
  severity: DrcSeverity;
  affectedNodeId: NodeId;
}

// ─── Foldability types ────────────────────────────────────────────────────────

export type AccessibilityState = 'OPEN' | 'CONSTRAINED' | 'INACCESSIBLE';

export interface PanelAccessibility {
  panelId: NodeId;
  state: AccessibilityState;
  lockingBendIds: NodeId[];
}

// ─── Bend-allowance pure function (FR-005, FR-008) ────────────────────────────

/**
 * Compute bend allowance using the standard sheet-metal formula:
 *   BA = (π × A / 180) × (R + K × T)
 *
 * @param angleDeg  - bend angle in degrees (1–179)
 * @param radius    - inner radius in mm
 * @param kFactor   - K-factor (0 < k ≤ 1)
 * @param thickness - material thickness in mm
 */
export function computeBendAllowance(
  angleDeg: number,
  radius: number,
  kFactor: number,
  thickness: number,
): number {
  return (Math.PI * angleDeg / 180) * (radius + kFactor * thickness);
}

// ─── Internal event contracts (from contracts/graph-events.md) ───────────────

export interface MutationResult {
  success: true;
  dirtiedNodeIds: NodeId[];
  drcViolations: DrcViolation[];
  rollbackToken: string;
}

export type SolveOutcome =
  | { ok: true; result: GeometrySolveResult }
  | { ok: false; errorCode: 'SOLVE_FAILED'; offendingNodeId: NodeId; message: string };

export interface BendZone {
  offset: number;     // mm from panel A's near edge
  width: number;      // BA in mm
  nodeId: NodeId;
  radius?: number;    // inner bend radius (mm)
  kFactor?: number;   // neutral-axis factor 0 < k ≤ 1
  angle?: number;     // bend angle in degrees
}

export interface FlatPatternDimensions {
  width: number;
  height: number;
  bendZones: BendZone[];
}

// ─── Profile validation (T048) ────────────────────────────────────────────────

export interface FlatPanelBounds {
  width: number;   // mm
  height: number;  // mm
}

/**
 * Validate a CutProfile against the parent panel's flat dimensions.
 * Returns an array of DrcViolation objects. Empty array = pass.
 */
export function validateProfile(
  profile: CutProfile,
  panelBounds: FlatPanelBounds,
  existingCuts: CutProfile[] = [],
  bendZones: BendZone[] = [],
): DrcViolation[] {
  const violations: DrcViolation[] = [];

  // Helper: axis-aligned bounding box of a profile
  function profileBBox(p: CutProfile): { minX: number; minY: number; maxX: number; maxY: number } {
    switch (p.type) {
      case 'CIRCLE':
        return { minX: p.centreX - p.radius, minY: p.centreY - p.radius, maxX: p.centreX + p.radius, maxY: p.centreY + p.radius };
      case 'RECTANGLE':
        return { minX: p.originX, minY: p.originY, maxX: p.originX + p.width, maxY: p.originY + p.height };
      case 'POLYGON':
      case 'FREEFORM': {
        const xs = p.vertices.map((v) => v.x);
        const ys = p.vertices.map((v) => v.y);
        return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
      }
    }
  }

  // Out-of-bounds check
  const bb = profileBBox(profile);
  if (bb.minX < 0 || bb.minY < 0 || bb.maxX > panelBounds.width || bb.maxY > panelBounds.height) {
    violations.push({
      ruleId: 'CUT_PROFILE_OUT_OF_BOUNDS',
      errorCode: 'CUT_PROFILE_OUT_OF_BOUNDS',
      message: `Cut profile bounding box [${bb.minX.toFixed(1)}, ${bb.minY.toFixed(1)}]–[${bb.maxX.toFixed(1)}, ${bb.maxY.toFixed(1)}] exceeds panel bounds ${panelBounds.width}×${panelBounds.height} mm.`,
      severity: 'ERROR',
    } as DrcViolation);
    return violations; // Early exit — no point checking further
  }

  // Polygon/Freeform: minimum 3 vertices + no self-intersection (cross-product sign test)
  if (profile.type === 'POLYGON' || profile.type === 'FREEFORM') {
    if (profile.vertices.length < 3) {
      violations.push({
        ruleId: 'CUT_INVALID_PROFILE',
        errorCode: 'CUT_INVALID_PROFILE',
        message: `Profile must have at least 3 vertices, got ${profile.vertices.length}.`,
        severity: 'ERROR',
      } as DrcViolation);
      return violations;
    }
    // Cross-product sign test for self-intersection (simplified: convexity check)
    // A simple polygon is valid if all cross products have the same sign (convex),
    // or alternatively we detect sign flips in the chain.
    const verts = profile.vertices;
    let prevSign = 0;
    let selfIntersects = false;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i]!;
      const b = verts[(i + 1) % verts.length]!;
      const c = verts[(i + 2) % verts.length]!;
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const sign = cross > 0 ? 1 : cross < 0 ? -1 : 0;
      if (sign !== 0) {
        if (prevSign !== 0 && sign !== prevSign) { selfIntersects = true; break; }
        prevSign = sign;
      }
    }
    if (selfIntersects) {
      violations.push({
        ruleId: 'CUT_INVALID_PROFILE',
        errorCode: 'CUT_INVALID_PROFILE',
        message: 'Polygon/freeform profile has self-intersecting edges.',
        severity: 'ERROR',
      } as DrcViolation);
      return violations;
    }
  }

  // Overlap check: AABB overlap with existing cuts (warning-level)
  for (const existing of existingCuts) {
    const ebb = profileBBox(existing);
    const overlaps = !(bb.maxX <= ebb.minX || bb.minX >= ebb.maxX || bb.maxY <= ebb.minY || bb.minY >= ebb.maxY);
    if (overlaps) {
      violations.push({
        ruleId: 'CUT_OVERLAP',
        errorCode: 'CUT_OVERLAP',
        message: 'Cut profile overlaps with an existing cut.',
        severity: 'ERROR',
      } as DrcViolation);
      break;
    }
  }

  // Bend-zone intersection: warn (not block) when profile AABB overlaps a bend zone.
  // Cutting through a bend zone weakens the bend; DRC_CUT_IN_BEND_ZONE is advisory
  // so the operation proceeds (constitution §X: Graceful Failure — warn, do not silently ignore).
  for (const zone of bendZones) {
    const zoneMinX = zone.offset;
    const zoneMaxX = zone.offset + zone.width;
    const overlapsZone = !(bb.maxX <= zoneMinX || bb.minX >= zoneMaxX);
    if (overlapsZone) {
      violations.push({
        ruleId: 'DRC_CUT_IN_BEND_ZONE',
        errorCode: 'DRC_CUT_IN_BEND_ZONE',
        message: `Cut profile overlaps bend zone at offset ${zone.offset.toFixed(1)}–${(zone.offset + zone.width).toFixed(1)} mm (node ${zone.nodeId}). Cutting through a bend zone weakens the fold.`,
        severity: 'WARNING',
      } as DrcViolation);
    }
  }

  return violations;
}
