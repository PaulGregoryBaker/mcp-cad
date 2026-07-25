/**
 * Structured error model for MCP-CAD.
 * All tool errors return { code, message, recoverable, suggested_tool }.
 * Constitution Principle VI: no unstructured throws reach the MCP boundary.
 *
 * Task: T037
 */

// ─── Error codes (from Engineering-Design §3.4) ──────────────────────────────

export const ErrorCodes = {
  // Geometry Engine errors
  GE_IMPORT_FAILED: 'GE_IMPORT_FAILED',
  GE_INVALID_SOLID: 'GE_INVALID_SOLID',
  GE_SOLID_NOT_FOUND: 'GE_SOLID_NOT_FOUND',
  GE_SHELL_NOT_FOUND: 'GE_SHELL_NOT_FOUND',
  GE_UNFOLD_NOT_FOUND: 'GE_UNFOLD_NOT_FOUND',
  GE_HEAL_FAILED: 'GE_HEAL_FAILED',
  GE_BOOLEAN_FAILURE: 'GE_BOOLEAN_FAILURE',
  GE_EMPTY_RESULT: 'GE_EMPTY_RESULT',
  GE_TAB_SLOT_FAILED: 'GE_TAB_SLOT_FAILED',
  GE_UNFOLD_FAILED: 'GE_UNFOLD_FAILED',
  GE_RELIEF_FAILED: 'GE_RELIEF_FAILED',
  GE_NEST_FAILED: 'GE_NEST_FAILED',
  GE_SNAPSHOT_NOT_FOUND: 'GE_SNAPSHOT_NOT_FOUND',
  GE_RESTORE_FAILED: 'GE_RESTORE_FAILED',

  // Manufacturing Domain errors
  MD_MATERIAL_NOT_FOUND: 'MD_MATERIAL_NOT_FOUND',
  MD_SAFETY_VIOLATION: 'MD_SAFETY_VIOLATION',
  MD_RULE_VIOLATION: 'MD_RULE_VIOLATION',

  // Anti-Corruption Layer errors
  ACL_EXTRACTION_FAILED: 'ACL_EXTRACTION_FAILED',

  // Export errors
  EXPORT_JOB_NOT_FOUND: 'EXPORT_JOB_NOT_FOUND',
  EXPORT_JOB_NOT_COMPLETE: 'EXPORT_JOB_NOT_COMPLETE',

  // Config errors
  CONFIG_INVALID: 'CONFIG_INVALID',

  // Gap-closure geometry errors (Feature 002-mcp-tools-gap)
  GE_CLASH_DETECTION_FAILED: 'GE_CLASH_DETECTION_FAILED',
  GE_GAP_DETECTION_FAILED: 'GE_GAP_DETECTION_FAILED',
  GE_TRIM_FAILED: 'GE_TRIM_FAILED',
  GE_SPLIT_FAILED: 'GE_SPLIT_FAILED',
  GE_EXTEND_FAILED: 'GE_EXTEND_FAILED',
  GE_OFFSET_FAILED: 'GE_OFFSET_FAILED',
  GE_FLANGE_FAILED: 'GE_FLANGE_FAILED',
  GE_EDGE_NOT_OPEN: 'GE_EDGE_NOT_OPEN',
  GE_RIP_FAILED: 'GE_RIP_FAILED',
  GE_EDGE_NOT_INTERIOR: 'GE_EDGE_NOT_INTERIOR',
  GE_MERGE_FAILED: 'GE_MERGE_FAILED',
  MD_LOGISTICS_NOT_CONFIGURED: 'MD_LOGISTICS_NOT_CONFIGURED',
  GE_DECOMPOSE_BY_BENDS_FAILED: 'GE_DECOMPOSE_BY_BENDS_FAILED',
  GE_DECOMPOSE_THICKNESS_MISMATCH: 'GE_DECOMPOSE_THICKNESS_MISMATCH',
  GE_DECOMPOSE_EXTRUDE_FAILED: 'GE_DECOMPOSE_EXTRUDE_FAILED',
  GE_DECOMPOSE_CUT_FAILED: 'GE_DECOMPOSE_CUT_FAILED',
  GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED: 'GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED',

  // Feature 006-geometry-primitives
  GE_BOOLEAN_EMPTY_RESULT: 'GE_BOOLEAN_EMPTY_RESULT',
  GE_ALIGN_UNSUPPORTED: 'GE_ALIGN_UNSUPPORTED',
  GE_SCALE_NON_UNIFORM: 'GE_SCALE_NON_UNIFORM',
  GE_FILLET_TOO_LARGE: 'GE_FILLET_TOO_LARGE',
  GE_CHAMFER_TOO_LARGE: 'GE_CHAMFER_TOO_LARGE',
  GE_HEAL_INCOMPLETE: 'GE_HEAL_INCOMPLETE',
  GE_SEW_INCOMPLETE: 'GE_SEW_INCOMPLETE',
  GE_ASSEMBLY_MATE_UNSUPPORTED: 'GE_ASSEMBLY_MATE_UNSUPPORTED',
  GE_ASSEMBLY_CROSS_DOCUMENT: 'GE_ASSEMBLY_CROSS_DOCUMENT',

  // Feature 007-sheet-metal-unfolding
  GE_INVALID_SHEET_METAL: 'GE_INVALID_SHEET_METAL',
  GE_UNFOLD_CYCLE_DETECTED: 'GE_UNFOLD_CYCLE_DETECTED',
  GE_UNFOLD_T_JUNCTION: 'GE_UNFOLD_T_JUNCTION',
  GE_UNFOLD_SEWING_FAILED: 'GE_UNFOLD_SEWING_FAILED',
  GE_UNFOLD_REBUILD_FAILED: 'GE_UNFOLD_REBUILD_FAILED',
  GE_PANEL_INVALID: 'GE_PANEL_INVALID',
  GE_MERGE_GAP: 'GE_MERGE_GAP',
  GE_MERGE_DISCONNECTED: 'GE_MERGE_DISCONNECTED',
  GE_MERGE_FILLET_FAILED: 'GE_MERGE_FILLET_FAILED',
  GE_MERGE_NO_SEAM_EDGES: 'GE_MERGE_NO_SEAM_EDGES',
  GE_MERGE_BEND_AXIS_AMBIGUOUS: 'GE_MERGE_BEND_AXIS_AMBIGUOUS',
  GE_MERGE_BEND_EXTENT_TOO_SHORT: 'GE_MERGE_BEND_EXTENT_TOO_SHORT',
  GE_MERGE_THICKNESS_MISMATCH: 'GE_MERGE_THICKNESS_MISMATCH',
  GE_MERGE_RADIUS_TOO_LARGE: 'GE_MERGE_RADIUS_TOO_LARGE',
  GE_MERGE_WEDGE_FAILED: 'GE_MERGE_WEDGE_FAILED',
  GE_CLOSE_GAP_FAILED: 'GE_CLOSE_GAP_FAILED',

  // Feature 008-splits-by-bends-viewport-alignment
  GE_ALIGN_FAILED: 'GE_ALIGN_FAILED',
  GE_MERGE_NON_MANIFOLD: 'GE_MERGE_NON_MANIFOLD',
  GE_PROTRUSION_LOOP_FAILED: 'GE_PROTRUSION_LOOP_FAILED',

  // Transaction primitive errors (Feature 004-transaction-primitive)
  TRANSACTION_NOT_FOUND: 'TRANSACTION_NOT_FOUND',
  TRANSACTION_NOT_ACTIVE: 'TRANSACTION_NOT_ACTIVE',
  TRANSACTION_ALREADY_ACTIVE: 'TRANSACTION_ALREADY_ACTIVE',
  TRANSACTION_MISMATCH: 'TRANSACTION_MISMATCH',
  TRANSACTION_REQUIRED: 'TRANSACTION_REQUIRED',

  // Semantic Mapping Layer errors (Feature 005-semantic-mapping-layer)
  PERSISTENCE_UNAVAILABLE: 'PERSISTENCE_UNAVAILABLE',
  PERSISTENCE_COMMIT_FAILED: 'PERSISTENCE_COMMIT_FAILED',
  SEMANTIC_ID_EXISTS: 'SEMANTIC_ID_EXISTS',
  SEMANTIC_ID_NOT_FOUND: 'SEMANTIC_ID_NOT_FOUND',
  SEMANTIC_ID_INVALID: 'SEMANTIC_ID_INVALID',
  SEMANTIC_TYPE_NOT_SUPPORTED: 'SEMANTIC_TYPE_NOT_SUPPORTED',
  SEMANTIC_RELATIONSHIP_NOT_SUPPORTED: 'SEMANTIC_RELATIONSHIP_NOT_SUPPORTED',
  BINDING_FACE_ALREADY_BOUND: 'BINDING_FACE_ALREADY_BOUND',
  BINDING_KIND_NOT_SUPPORTED: 'BINDING_KIND_NOT_SUPPORTED',
  SEMANTIC_CONSTITUENT_NOT_FOUND: 'SEMANTIC_CONSTITUENT_NOT_FOUND',
  REVISION_NOT_FOUND: 'REVISION_NOT_FOUND',

  // Manufacturing Graph errors (Feature 009-manufacturing-graph)
  NODE_ID_ALREADY_EXISTS: 'NODE_ID_ALREADY_EXISTS',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  MANUFACTURING_GRAPH_CYCLE_DETECTED: 'MANUFACTURING_GRAPH_CYCLE_DETECTED',
  REMOVE_WOULD_ORPHAN_NODES: 'REMOVE_WOULD_ORPHAN_NODES',
  JOIN_EDGE_ALREADY_BOUND: 'JOIN_EDGE_ALREADY_BOUND',
  GRAPH_INTEGRITY_ERROR: 'GRAPH_INTEGRITY_ERROR',
  BOOTSTRAP_PARTIAL: 'BOOTSTRAP_PARTIAL',
  GRAPH_ALREADY_POPULATED: 'GRAPH_ALREADY_POPULATED',
  SOLVE_FAILED: 'SOLVE_FAILED',
  GEOMETRY_STALE: 'GEOMETRY_STALE',
  DRC_BEND_RADIUS_VIOLATION: 'DRC_BEND_RADIUS_VIOLATION',
  DRC_MIN_FLANGE_WIDTH_VIOLATION: 'DRC_MIN_FLANGE_WIDTH_VIOLATION',
  DRC_FOLDABILITY_VIOLATION: 'DRC_FOLDABILITY_VIOLATION',
  DRC_FOLDABILITY_UNCERTAIN: 'DRC_FOLDABILITY_UNCERTAIN',
  DRC_CUT_IN_BEND_ZONE: 'DRC_CUT_IN_BEND_ZONE',
  CUT_PROFILE_OUT_OF_BOUNDS: 'CUT_PROFILE_OUT_OF_BOUNDS',
  CUT_OVERLAP: 'CUT_OVERLAP',
  CUT_INVALID_PROFILE: 'CUT_INVALID_PROFILE',

  // Feature 010-graph-driven-mutations
  GE_FUSE_THICKNESS_MISMATCH: 'GE_FUSE_THICKNESS_MISMATCH',
  GE_FUSE_NOT_COPLANAR: 'GE_FUSE_NOT_COPLANAR',
  GE_FUSE_DISJOINT_RESULT: 'GE_FUSE_DISJOINT_RESULT',

  // Feature 011-graph-driven-geometry (bug fixes + coordinate mapping)
  GE_MERGE_EDGE_MISALIGNED: 'GE_MERGE_EDGE_MISALIGNED',
  GE_POINT_NOT_ON_PANEL: 'GE_POINT_NOT_ON_PANEL',
  GE_NO_MANUFACTURING_GRAPH: 'GE_NO_MANUFACTURING_GRAPH',

  // Feature 012-accurate-coord-mapping
  GE_PANEL_FRAME_FAILED: 'GE_PANEL_FRAME_FAILED',

  // Phase 5 Slice 1 — v2 graph-authored construction. The GE_* codes below are
  // verbatim string matches for translation::EvaluateErrorCode /
  // ConstructPartSolidResult.errorCode (manufacturing_graph_evaluator.hpp,
  // part_solid_construction.hpp) — passed through unchanged, never re-derived,
  // so there is exactly one place each code's meaning is defined (the C++
  // header comments). The GRAPH_* codes are this store's own (ts/src/v2/graph).
  GE_TREE_CYCLE_DETECTED: 'GE_TREE_CYCLE_DETECTED',
  GE_BEND_SELF_REFERENCE: 'GE_BEND_SELF_REFERENCE',
  GE_DANGLING_BEND_REFERENCE: 'GE_DANGLING_BEND_REFERENCE',
  GE_REGION_CLIP_FAILED: 'GE_REGION_CLIP_FAILED',
  GE_DEGENERATE_OUTLINE: 'GE_DEGENERATE_OUTLINE',
  GE_INVALID_LAYOUT: 'GE_INVALID_LAYOUT',
  GE_EMPTY_LAYOUT: 'GE_EMPTY_LAYOUT',
  GE_POLYGON_BUILD_FAILED: 'GE_POLYGON_BUILD_FAILED',
  // Phase 5 Slice 6 (fuse_bodies / remove_protrusions polygon_boolean.hpp).
  GE_POLYGON_BOOLEAN_FAILED: 'GE_POLYGON_BOOLEAN_FAILED',
  GE_POLYGON_HAS_HOLES: 'GE_POLYGON_HAS_HOLES',
  GE_EXTRUDE_FAILED: 'GE_EXTRUDE_FAILED',
  GE_BRIDGE_EDGE_NOT_FOUND: 'GE_BRIDGE_EDGE_NOT_FOUND',
  GE_BRIDGE_UNSUPPORTED_TOPOLOGY: 'GE_BRIDGE_UNSUPPORTED_TOPOLOGY',
  GE_BRIDGE_BUILD_FAILED: 'GE_BRIDGE_BUILD_FAILED',
  GE_CONSTRUCTION_FAILED: 'GE_CONSTRUCTION_FAILED',
  GRAPH_PART_NOT_FOUND: 'GRAPH_PART_NOT_FOUND',
  GRAPH_REGION_PANEL_NOT_FOUND: 'GRAPH_REGION_PANEL_NOT_FOUND',
  GRAPH_REGION_PANEL_ALIASED: 'GRAPH_REGION_PANEL_ALIASED',
  // Phase 5 Slice 4: a part already absorbed by a prior merge_bodies_with_bend
  // (mergedIntoPartId != null) can't be a merge participant again — mirrors
  // GRAPH_REGION_PANEL_ALIASED one level up.
  GRAPH_PART_ALIASED: 'GRAPH_PART_ALIASED',
  // Phase 5 Slice 6: fuse_bodies' first-cut scope guard — part B must be a
  // simple flat part (no bends of its own) to be fused onto another part.
  // See rebuild/06-plan.md Slice 6's own deferred-scope note.
  GRAPH_FUSE_PART_B_NOT_SIMPLE: 'GRAPH_FUSE_PART_B_NOT_SIMPLE',

  // Phase 5 Slice 3 — point mapping (rebuild/13-translation-module-design.md §4/§5).
  // Verbatim string matches for translation::MapErrorCode, same convention as
  // the Slice 1 GE_* codes above.
  GE_POINT_NOT_ON_PART: 'GE_POINT_NOT_ON_PART',

  // Phase 5 Slice 4 — merge_bodies_with_bend (rebuild/14-graph-schema.md §2.1.2).
  // Verbatim string matches for translation::MergeErrorCode
  // (part_merge.hpp). Deliberately distinct from v1's similarly-named
  // GE_MERGE_EDGE_MISALIGNED/GE_POINT_NOT_ON_PANEL above — same precedent as
  // Slice 3's GE_POINT_NOT_ON_PART: a new module gets its own code rather
  // than reusing a v1 code whose exact semantics/threshold belong to a
  // different implementation.
  GE_INVALID_EDGE_REF: 'GE_INVALID_EDGE_REF',
  GE_MERGE_EDGE_MISMATCH: 'GE_MERGE_EDGE_MISMATCH',
  GE_MERGE_SELF_INTERSECTION: 'GE_MERGE_SELF_INTERSECTION',

  // Phase 5 Slice 5 — ingest STEP -> graph (rebuild/13-translation-module-
  // design.md §6). Verbatim string matches for translation::ReconcileErrorCode
  // (step_reconciliation.hpp).
  GE_TOO_FEW_PIECES: 'GE_TOO_FEW_PIECES',
  GE_DISCONNECTED_PIECES: 'GE_DISCONNECTED_PIECES',
  // Named IMPORT_NOT_DEVELOPABLE in 15-mcp-contract.md's error taxonomy —
  // shipped as GE_NON_DEVELOPABLE_FOLD instead, matching the GE_* naming
  // convention every other error in this Slice 5 block uses (verbatim
  // strings from step_reconciliation.hpp's ReconcileErrorCode). Naming
  // drift only, not a behavior gap — left as-is rather than renamed, since
  // this code is already shipped/tested and renaming now is pure churn.
  GE_NON_DEVELOPABLE_FOLD: 'GE_NON_DEVELOPABLE_FOLD',
  GE_RECONCILE_SELF_INTERSECTION: 'GE_RECONCILE_SELF_INTERSECTION',
  // Caught by replaying the reconciled graph through the REAL Evaluate()
  // pose chain, not just the reconciliation module's own math — catches
  // input pieces that are each individually well-formed but mutually
  // inconsistent about which physical surface they reference (found in
  // practice: a bottom/top surface mismatch between getPanelFrame calls
  // for different panels of the same decomposed part).
  GE_DOWNSTREAM_POSE_MISMATCH: 'GE_DOWNSTREAM_POSE_MISMATCH',
  // import_part's own orchestration-level errors (not from the pure
  // reconciliation module itself — these cover the kernel-measurement steps
  // around it: nothing survived removeProtrusions'/splitBodyByBends'
  // panel classification, or the file path itself doesn't exist/isn't STEP).
  GE_IMPORT_NO_PANELS_FOUND: 'GE_IMPORT_NO_PANELS_FOUND',

  // Internal errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// ─── Structured error type ───────────────────────────────────────────────────

export interface StructuredError {
  code: ErrorCode;
  message: string;
  recoverable: boolean;
  suggestedTool?: string;
}

// ─── McpToolError — carries a StructuredError as a thrown object ──────────────

export class McpToolError extends Error {
  public readonly structured: StructuredError;

  constructor(structured: StructuredError) {
    super(structured.message);
    this.structured = structured;
    this.name = 'McpToolError';
  }
}

// ─── Error factories ──────────────────────────────────────────────────────────

export function makeError(
  code: ErrorCode,
  message: string,
  recoverable: boolean,
  suggestedTool?: string,
): StructuredError {
  return { code, message, recoverable, suggestedTool };
}

export function throwError(
  code: ErrorCode,
  message: string,
  recoverable: boolean,
  suggestedTool?: string,
): never {
  throw new McpToolError(makeError(code, message, recoverable, suggestedTool));
}

/**
 * Converts any thrown value (including NAPI errors from the C++ addon)
 * into a StructuredError. Ensures no unstructured throws escape to MCP.
 */
export function toStructuredError(err: unknown): StructuredError {
  if (err instanceof McpToolError) {
    return err.structured;
  }

  // Handle POJO StructuredError recursively passed
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const errObj = err as Record<string, unknown>;
    if (typeof errObj.code === 'string') {
      return {
        code: (errObj.code as ErrorCode) ?? ErrorCodes.INTERNAL_ERROR,
        message: String(errObj.message),
        recoverable: Boolean(errObj.recoverable),
        suggestedTool: typeof errObj.suggestedTool === 'string' ? errObj.suggestedTool : undefined,
      };
    }
  }

  if (err instanceof Error) {
    // Try to parse code from NAPI-thrown errors (JSON format in message)
    try {
      const parsed = JSON.parse(err.message) as Record<string, unknown>;
      if (typeof parsed.code === 'string' && typeof parsed.message === 'string') {
        return {
          code: (parsed.code as ErrorCode) ?? ErrorCodes.INTERNAL_ERROR,
          message: parsed.message,
          recoverable: typeof parsed.recoverable === 'boolean' ? parsed.recoverable : false,
          suggestedTool:
            typeof parsed.suggestedTool === 'string' ? parsed.suggestedTool : undefined,
        };
      }
    } catch {
      // Not JSON; fall through
    }

    // Check if error has a code property (from C++ addon)
    // (Unreachable in practice: the object-check above already handles Error+code cases)
    /* v8 ignore next 7 */
    const errWithCode = err as Error & { code?: string };
    if (typeof errWithCode.code === 'string') {
      return {
        code: (errWithCode.code as ErrorCode) ?? ErrorCodes.INTERNAL_ERROR,
        message: err.message,
        recoverable: false,
      };
    }

    return {
      code: ErrorCodes.INTERNAL_ERROR,
      message: err.message,
      recoverable: false,
    };
  }

  return {
    code: ErrorCodes.INTERNAL_ERROR,
    message: String(err),
    recoverable: false,
  };
}
