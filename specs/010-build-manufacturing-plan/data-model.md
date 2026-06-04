# Data Model: Build Manufacturing Plan

This document defines the key data structures and TypeScript interfaces used by the `build_manufacturing_plan` orchestrator.

## 1. Reconstruction Output Report

The main output of the `build_manufacturing_plan` tool is the `ReconstructionReport`.

```typescript
export interface ReconstructionReport {
  /** True if the overall model was processed without structural failures */
  success: boolean;

  /** List of successfully reconstructed parts, each associated with its manufacturing graph */
  reconstructed_parts: ReconstructedPart[];

  /** List of parts/bodies that were left unmerged/independent */
  unmerged_parts: UnmergedPart[];

  /** List of joints that were skipped during reconstruction due to violations */
  skipped_joints: SkippedJoint[];
}
```

---

## 2. Supporting Entities

### ReconstructedPart
Represents a merged sheet metal part containing multiple panels.

```typescript
export interface ReconstructedPart {
  /** The final merged shell body ID */
  part_id: string;

  /** The generated manufacturing graph containing all panels and bends */
  graph: {
    part_id: string;
    nodes: Array<PanelNode | BendNode | JoinNode | CutNode>;
    edges: Array<{ from: string; to: string }>;
  };
}
```

### UnmergedPart
Represents a body that was left unmerged, either because it was classified as a non-panel protrusion, failed sheet metal validation, or failed the test merge.

```typescript
export interface UnmergedPart {
  /** The body/shell ID in the session */
  part_id: string;

  /** Reason why it was left unmerged */
  reason: 'protrusion' | 'panel_validation_failed' | 'merge_failed';

  /** 3D Bounding box of the part */
  bbox: {
    x_min: number;
    y_min: number;
    z_min: number;
    x_max: number;
    y_max: number;
    z_max: number;
  };
  
  /** Parent panel ID, if it was classified as a protrusion of a panel */
  parent_panel_id: string | null;
}
```

### SkippedJoint
Represents a potential bend joint that was skipped because it violated press-brake limits, foldability, or caused a physical collision.

```typescript
export interface SkippedJoint {
  /** The ID of the first panel */
  part_a_id: string;

  /** The ID of the second panel */
  part_b_id: string;

  /** Reason why the joint could not be merged */
  reason: 'collision' | 'foldability_violation' | 'drc_violation';

  /** Structured violations returned by checkers */
  violations: Array<{
    code: string;
    message: string;
    severity: 'WARNING' | 'ERROR';
  }>;
}
```

---

## 3. Orchestrator Internal Entities

### PrioritizedJoint
Represents a candidate joint that has been scored and ranked for reconstruction.

```typescript
export interface PrioritizedJoint {
  /** The ID of the first panel */
  part_a_id: string;

  /** The ID of the second panel */
  part_b_id: string;

  /** Priority score computed based on dihedral angle, panel size, and clearance */
  priority_score: number;

  /** Measured dihedral angle between the panels */
  dihedral_angle: number;

  /** True if panels are coplanar and should be fused rather than bent */
  is_coplanar: boolean;
}
```
