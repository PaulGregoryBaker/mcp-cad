/**
 * MCP tool dispatch — routes a tool call to its handler function.
 */

import { toStructuredError, throwError, ErrorCodes } from './errors.js';
import type { ManufacturingConfig } from '../config/loader.js';

import { handleFuseBodies, handleCutBodies, handleIntersectBodies } from './handlers/booleans.js';
import { handleMapTo2D, handleMapTo3D } from './handlers/mapping.js';
import {
  handleRollback, handleBeginTransaction, handleCommitTransaction,
  handleRollbackTransaction, handleGetTransactionHistory,
} from './handlers/transactions.js';
import {
  handleDeclareSemanticEntity, handleBindSemanticEntity,
  handleResolveGeometry, handleSemanticLineage,
} from './handlers/semantic.js';
import {
  handleCleanGeometry, handleCenterAndAlignBody,
  handleBoundingBox, handleMassProperties, handleMeasureDistance, handleExploreTopology,
  handleTranslateBody, handleRotateBody, handleMirrorBody, handleScaleBody,
  handleAlignToFace, handleFilletEdges, handleChamferEdges, handleSimplifyBody,
  handleHealGeometryEx, handleOffsetShape, handleDeleteFace, handleSewFaces,
} from './handlers/body-ops.js';
import {
  handleSplitBodyByPlane, handleMergeBodiesWithBend, handleCloseGap, handleIsPanelValid,
  handleExtendFaceToTarget, handleOffsetFace, handleAddFlange, handleRipEdge,
  handleComputeIntersections, handleComputeGaps, handleTrimBodyWithPlane,
  handleCheckBoundaryCompliance, handleSplitBodyByBends, handleRemoveProtrusions,
} from './handlers/shape-ops.js';
import {
  handleDecomposeVolume, handleSynthesizeJoints, handleGenerateReliefs,
  handleValidateSheetMetal, handleReconstructCurvedBends,
  handleEvaluateManufacturability, handleValidateBendSequence, handleSimulateNesting,
} from './handlers/manufacturing.js';
import {
  handleGetUnfold, handleExportProductionPack,
  handleGetExportJobStatus, handleGetExportJobResult,
} from './handlers/unfold-export.js';
import {
  handleCreateAssemblyDocument, handleAddAssemblyInstance,
  handleMateRigid, handleListAssemblyTree, handleValidateAssembly,
} from './handlers/assembly.js';
import {
  handleCreatePart, handleSetActivePart, handleListParts, handleDeletePart,
  handleBootstrapGraph, handleAddBend, handleSolveGeometry, handleCheckFoldability,
  handleQueryGraph, handleResetGraph, handleUpdateNode, handleRemoveNode,
  handleAddJoin, handleAddCut,
} from './handlers/graph.js';

export async function dispatchTool(
  toolName: string,
  args: Record<string, unknown>,
  config: ManufacturingConfig,
): Promise<unknown> {
  try {
    switch (toolName) {
      case 'clean_geometry':
        return handleCleanGeometry(args);

      case 'validate_assembly':
        return handleValidateAssembly(args);

      case 'fuse_bodies':
        return handleFuseBodies(args);

      case 'cut_bodies':
        return handleCutBodies(args);

      case 'intersect_bodies':
        return handleIntersectBodies(args);

      case 'bounding_box':
        return handleBoundingBox(args);

      case 'mass_properties':
        return handleMassProperties(args);

      case 'measure_distance':
        return handleMeasureDistance(args);

      case 'explore_topology':
        return handleExploreTopology(args);

      case 'translate_body':
        return handleTranslateBody(args);

      case 'rotate_body':
        return handleRotateBody(args);

      case 'mirror_body':
        return handleMirrorBody(args);

      case 'scale_body':
        return handleScaleBody(args);

      case 'align_to_face':
        return handleAlignToFace(args);

      case 'fillet_edges':
        return handleFilletEdges(args);

      case 'chamfer_edges':
        return handleChamferEdges(args);

      case 'simplify_body':
        return handleSimplifyBody(args);

      case 'heal_geometry_ex':
        return handleHealGeometryEx(args);

      case 'offset_shape':
        return handleOffsetShape(args);

      case 'delete_face':
        return handleDeleteFace(args);

      case 'sew_faces':
        return handleSewFaces(args);

      case 'create_assembly_document':
        return handleCreateAssemblyDocument(args);

      case 'add_assembly_instance':
        return handleAddAssemblyInstance(args);

      case 'mate_rigid':
        return handleMateRigid(args);

      case 'list_assembly_tree':
        return handleListAssemblyTree(args);

      case 'decompose_volume':
        return handleDecomposeVolume(args);

      case 'synthesize_joints':
        return handleSynthesizeJoints(args, config);

      case 'generate_reliefs':
        return handleGenerateReliefs(args);

      case 'validate_sheet_metal':
        return handleValidateSheetMetal(args);

      case 'reconstruct_curved_bends':
        return handleReconstructCurvedBends(args);

      case 'get_unfold':
        return handleGetUnfold(args, config);

      case 'evaluate_manufacturability':
        return handleEvaluateManufacturability(args, config);

      case 'validate_bend_sequence':
        return handleValidateBendSequence(args);

      case 'simulate_nesting':
        return handleSimulateNesting(args);

      case 'export_production_pack':
        return handleExportProductionPack(args, config);

      case 'get_export_job_status':
        return handleGetExportJobStatus(args);

      case 'get_export_job_result':
        return handleGetExportJobResult(args);

      case 'rollback':
        return handleRollback(args);

      case 'begin_transaction':
        return await handleBeginTransaction(args);

      case 'commit_transaction':
        return await handleCommitTransaction(args);

      case 'rollback_transaction':
        return await handleRollbackTransaction(args);

      case 'get_transaction_history':
        return handleGetTransactionHistory(args);

      case 'split_body_by_plane':
        return handleSplitBodyByPlane(args);

      case 'merge_bodies_with_bend':
        return handleMergeBodiesWithBend(args);

      case 'close_gap':
        return handleCloseGap(args);

      case 'is_panel_valid':
        return handleIsPanelValid(args);

      case 'extend_face_to_target':
        return handleExtendFaceToTarget(args);

      case 'offset_face':
        return handleOffsetFace(args);

      case 'add_flange':
        return handleAddFlange(args);

      case 'rip_edge':
        return handleRipEdge(args);

      case 'compute_intersections':
        return handleComputeIntersections(args);

      case 'compute_gaps':
        return handleComputeGaps(args);

      case 'trim_body_with_plane':
        return handleTrimBodyWithPlane(args);

      case 'check_boundary_compliance':
        return handleCheckBoundaryCompliance(args, config);

      case 'split_body_by_bends':
        return await handleSplitBodyByBends(args);

      case 'remove_protrusions':
        return handleRemoveProtrusions(args);

      case 'center_and_align_body':
        return handleCenterAndAlignBody(args);

      case 'declare_semantic_entity':
        return await handleDeclareSemanticEntity(args);

      case 'bind_semantic_entity':
        return await handleBindSemanticEntity(args);

      case 'resolve_geometry':
        return await handleResolveGeometry(args);

      case 'semantic_lineage':
        return await handleSemanticLineage(args);

      // ─── Part management tools (Feature 009 multi-part support) ─────────────
      case 'create_part':
        return handleCreatePart(args);

      case 'set_active_part':
        return handleSetActivePart(args);

      case 'list_parts':
        return handleListParts();

      case 'delete_part':
        return handleDeletePart(args);

      // ─── Manufacturing Graph tools (Feature 009-manufacturing-graph) ────────
      case 'bootstrap_graph':
        return await handleBootstrapGraph(args, config);

      case 'add_bend':
        return await handleAddBend(args, config);

      case 'solve_geometry':
        return await handleSolveGeometry(args);

      case 'check_foldability':
        return handleCheckFoldability(args);

      case 'query_graph':
        return handleQueryGraph(args);

      case 'reset_graph':
        return handleResetGraph(args);

      case 'update_node':
        return handleUpdateNode(args);

      case 'remove_node':
        return handleRemoveNode(args);

      case 'add_join':
        return await handleAddJoin(args, config);

      case 'add_cut':
        return await handleAddCut(args, config);

      // ─── Feature 011: 3D-to-2D coordinate mapping ──────────────────────────
      case 'map_3d_to_2d':
        return handleMapTo2D(args);

      case 'map_2d_to_3d':
        return handleMapTo3D(args);

      default:
        throwError(ErrorCodes.INTERNAL_ERROR, `Unknown tool: ${toolName}`, false);
    }
  } catch (err) {
    throw toStructuredError(err);
  }
}
