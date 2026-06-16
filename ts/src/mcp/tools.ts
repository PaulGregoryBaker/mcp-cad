/**
 * MCP tool barrel — re-exports the public dispatch surface.
 */

export {
  setGeometryBindingMock,
  setSemanticStore,
  resetMcpGraphStateForTests,
  registerTestPart,
  MERGE_EDGE_ALIGNMENT_TOLERANCE_MM,
  COORD_MAP_ACCURACY_THRESHOLD_MM,
} from './state.js';

export { getToolDefinitions } from './registry.js';
export { dispatchTool } from './dispatch.js';
