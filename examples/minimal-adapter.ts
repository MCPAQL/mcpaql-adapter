/**
 * Minimal MCP-AQL Adapter
 *
 * Demonstrates the bare minimum required to implement an MCP-AQL adapter:
 * - One CRUDE endpoint (READ)
 * - The required `introspect` operation
 * - Discriminated union response format
 *
 * Usage: npx tsx examples/minimal-adapter.ts
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// --- Operation registry ---

const OPERATIONS = [
  {
    name: "introspect",
    endpoint: "READ",
    description: "Discover available operations and types",
    parameters: [
      { name: "query", type: "string", required: true, description: "Query type: 'operations' or 'types'" },
      { name: "name", type: "string", required: false, description: "Filter by operation or type name" },
    ],
  },
  {
    name: "get_status",
    endpoint: "READ",
    description: "Get adapter status",
    parameters: [],
  },
];

// --- Handlers ---

function handleIntrospect(params: Record<string, unknown>) {
  const query = params.query as string;
  const name = params.name as string | undefined;

  if (query === "operations") {
    if (name) {
      const op = OPERATIONS.find((o) => o.name === name);
      return { success: true, data: { operation: op ?? null } };
    }
    return {
      success: true,
      data: {
        operations: OPERATIONS.map((o) => ({
          name: o.name,
          endpoint: o.endpoint,
          description: o.description,
        })),
      },
    };
  }

  if (query === "types") {
    return { success: true, data: { types: [] } };
  }

  return { success: false, error: `Unknown query type: ${query}` };
}

function handleGetStatus() {
  return {
    success: true,
    data: {
      adapter: "minimal-adapter",
      version: "1.0.0",
      status: "healthy",
      uptime_seconds: Math.floor(process.uptime()),
    },
  };
}

// --- MCP server setup ---

const server = new Server(
  { name: "minimal-mcpaql-adapter", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler("tools/list" as any, async () => ({
  tools: [
    {
      name: "mcp_aql_read",
      description: "Read operations: safe, read-only queries",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", description: "Operation name" },
          params: { type: "object", description: "Operation parameters" },
        },
        required: ["operation"],
      },
    },
  ],
}));

server.setRequestHandler("tools/call" as any, async (request: any) => {
  const { name, arguments: args } = request.params;

  if (name !== "mcp_aql_read") {
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: `Unknown tool: ${name}` }) }],
    };
  }

  const operation = args.operation as string;
  const params = (args.params ?? {}) as Record<string, unknown>;

  let result;
  switch (operation) {
    case "introspect":
      result = handleIntrospect(params);
      break;
    case "get_status":
      result = handleGetStatus();
      break;
    default:
      result = { success: false, error: `Unknown operation: ${operation}` };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
});

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
