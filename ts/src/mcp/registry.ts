/**
 * MCP tool registry — aggregates tool definitions from every handler module.
 */

import { booleanDefinitions } from './handlers/booleans.js';
import { mappingDefinitions } from './handlers/mapping.js';
import { transactionDefinitions } from './handlers/transactions.js';
import { semanticDefinitions } from './handlers/semantic.js';
import { bodyOpsDefinitions } from './handlers/body-ops.js';
import { shapeOpsDefinitions } from './handlers/shape-ops.js';
import { manufacturingDefinitions } from './handlers/manufacturing.js';
import { unfoldExportDefinitions } from './handlers/unfold-export.js';
import { assemblyDefinitions } from './handlers/assembly.js';
import { graphDefinitions } from './handlers/graph.js';

export function getToolDefinitions(): object[] {
  return [
    ...bodyOpsDefinitions,
    ...manufacturingDefinitions,
    ...unfoldExportDefinitions,
    ...transactionDefinitions,
    ...semanticDefinitions,
    ...shapeOpsDefinitions,
    ...booleanDefinitions,
    ...assemblyDefinitions,
    ...graphDefinitions,
    ...mappingDefinitions,
  ];
}
