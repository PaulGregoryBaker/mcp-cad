/**
 * MCP server entry point.
 * Initialises stdio transport, registers resources and tools.
 *
 * Task: T035
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from './config/loader';
import { getAllResources } from './mcp/resources';
import { toStructuredError, ErrorCodes } from './mcp/errors';
import { startMeshServer } from './mesh/server';

// ─── Config loading ───────────────────────────────────────────────────────────

const configPath = process.env['CONFIG_PATH'] ?? './config/config.yaml';
let config = loadConfig(configPath);

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: 'mcp-cad',
    version: '0.1.0',
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

// ─── Resource handlers ────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const resources = getAllResources(config);
  return {
    resources: Object.entries(resources).map(([uri]) => ({
      uri,
      name: uri,
      mimeType: 'application/json',
      description: `MCP-CAD resource: ${uri}`,
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request: { params: { uri: string } }) => {
  const uri = request.params.uri;
  const resources = getAllResources(config);

  if (!(uri in resources)) {
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({
            error: ErrorCodes.INTERNAL_ERROR,
            message: `Resource not found: ${uri}`,
          }),
        },
      ],
    };
  }

  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(resources[uri]),
      },
    ],
  };
});

// ─── Tool handlers ────────────────────────────────────────────────────────────

// Tool implementations are lazy-loaded to avoid requiring NAPI addon at startup
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { getToolDefinitions } = await import('./mcp/tools.js');
  return { tools: getToolDefinitions() };
});

server.setRequestHandler(
  CallToolRequestSchema,
  async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
  try {
    const { dispatchTool } = await import('./mcp/tools.js');
    const toolArgs = request.params.arguments;
    if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) {
      throw new Error('Tool call requires an explicit arguments object. Pass {} when no arguments are needed.');
    }
    const result = await dispatchTool(request.params.name, toolArgs, config);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  } catch (err) {
    const structured = toStructuredError(err);
    return {
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      isError: true,
    };
  }
});

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const meshPort = Number(process.env['MESH_PORT'] ?? '3001');
  startMeshServer(meshPort);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
