/**
 * Public exports for the manufacturing/graph sub-module.
 *
 * Task: T001, T009
 */

export { ManufacturingGraph } from './graph';
export { GeometrySolver, addonToBinding } from './solver';
export type { GeometryBinding } from './solver';
export { DrcChecker } from './drc';
export type { DrcCheckRequest, DrcCheckResult, MaterialDrcConfig } from './drc';
export { FoldabilityChecker } from './foldability';
export type { FoldabilityCheckRequest, FoldabilityCheckResult } from './foldability';
export { bootstrapGraph } from './bootstrap';
export type { BootstrapOptions, BootstrapResult } from './bootstrap';

export {
  toNodeId,
  toBodyId,
  computeBendAllowance,
} from './types';

export type {
  NodeId,
  BodyId,
  PanelNode,
  BendNode,
  JoinNode,
  CutNode,
  GraphNode,
  JoinType,
  JoinParams,
  RivetPatternParams,
  FlangeParams,
  TabSlotParams,
  WeldPrepParams,
  CircleProfile,
  RectangleProfile,
  PolygonProfile,
  FreeformProfile,
  CutProfile,
  ManufacturingGraphData,
  GeometrySolveResult,
  SolvedNode,
  DrcViolation,
  DrcSeverity,
  AccessibilityState,
  PanelAccessibility,
  MutationResult,
  SolveOutcome,
  FlatPatternDimensions,
  BendZone,
} from './types';

export { GraphErrorCodes } from './errors';
export type { GraphErrorCode } from './errors';
