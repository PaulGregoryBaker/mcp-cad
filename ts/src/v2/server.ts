/**
 * v2 MCP server entry point (Phase 5 Slice 1).
 *
 * A clean-break Server instance and tool/resource registry — no shared
 * namespace with v1's ts/src/index.ts. v2's `create_part`/`create_node` are
 * unrelated tools from v1's same-named-but-differently-shaped `create_part`/
 * `add_bend`; running both servers side by side is safe because each has its
 * own registry and its own in-memory GraphStore.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { toStructuredError } from '../mcp/errors';
import { GraphStore } from './graph/store';
import { graphToolDefinitions, dispatchGraphTool } from './tools/graph';
import { graphResourceTemplates, matchesGraphResource, readGraphResource } from './resources/graph';

// ─── Store ─────────────────────────────────────────────────────────────────

const store = new GraphStore();

// ─── Server setup ────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: 'mcp-cad-v2',
    version: '0.1.0',
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

// ─── Tool handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, () => {
  return { tools: graphToolDefinitions };
});

server.setRequestHandler(
  CallToolRequestSchema,
  (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
    try {
      const toolArgs = request.params.arguments;
      if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) {
        throw new Error(
          'Tool call requires an explicit arguments object. Pass {} when no arguments are needed.',
        );
      }
      const result = dispatchGraphTool(store, request.params.name, toolArgs);
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
  },
);

// ─── Resource handlers ────────────────────────────────────────────────────────

server.setRequestHandler(ListResourceTemplatesRequestSchema, () => {
  return { resourceTemplates: graphResourceTemplates };
});

server.setRequestHandler(ReadResourceRequestSchema, (request: { params: { uri: string } }) => {
  const uri = request.params.uri;

  if (!matchesGraphResource(uri)) {
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({
            error: 'RESOURCE_NOT_FOUND',
            message: `Unrecognized v2 resource: ${uri}`,
          }),
        },
      ],
    };
  }

  try {
    const data = readGraphResource(store, uri);
    return {
      contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data) }],
    };
  } catch (err) {
    const structured = toStructuredError(err);
    return {
      contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(structured) }],
    };
  }
});

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('v2 MCP server failed to start:', err);
  process.exit(1);
});
