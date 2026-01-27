/**
 * User Management MCP-AQL Adapter
 *
 * Demonstrates a full CRUDE adapter with all five endpoints:
 * - CREATE: create_user, add_role
 * - READ: introspect, list_users, get_user
 * - UPDATE: update_user
 * - DELETE: delete_user, remove_role
 * - EXECUTE: send_verification_email
 *
 * Uses an in-memory store for demonstration purposes.
 *
 * Usage: npx tsx examples/user-management-adapter.ts
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// --- Types ---

interface User {
  id: string;
  email: string;
  name: string;
  roles: string[];
  verified: boolean;
  created_at: string;
}

// --- In-memory store ---

const users = new Map<string, User>();
let nextId = 1;

// --- Operation registry ---

const OPERATIONS = [
  { name: "introspect", endpoint: "READ", description: "Discover available operations and types" },
  { name: "create_user", endpoint: "CREATE", description: "Create a new user account" },
  { name: "add_role", endpoint: "CREATE", description: "Add a role to a user" },
  { name: "list_users", endpoint: "READ", description: "List all users" },
  { name: "get_user", endpoint: "READ", description: "Get a user by ID" },
  { name: "update_user", endpoint: "UPDATE", description: "Update user details" },
  { name: "delete_user", endpoint: "DELETE", description: "Delete a user account" },
  { name: "remove_role", endpoint: "DELETE", description: "Remove a role from a user" },
  { name: "send_verification_email", endpoint: "EXECUTE", description: "Send email verification" },
];

// --- CRUDE endpoint mapping ---

const ENDPOINT_TOOLS = ["mcp_aql_create", "mcp_aql_read", "mcp_aql_update", "mcp_aql_delete", "mcp_aql_execute"];

function getEndpointForTool(toolName: string): string {
  return toolName.replace("mcp_aql_", "").toUpperCase();
}

// --- Handlers ---

type Handler = (params: Record<string, unknown>) => { success: boolean; data?: unknown; error?: string };

const handlers: Record<string, Handler> = {
  introspect(params) {
    const query = params.query as string;
    if (query === "operations") {
      const name = params.name as string | undefined;
      if (name) {
        const op = OPERATIONS.find((o) => o.name === name);
        return { success: true, data: { operation: op ?? null } };
      }
      return { success: true, data: { operations: OPERATIONS } };
    }
    if (query === "types") {
      return {
        success: true,
        data: {
          types: [
            { name: "User", kind: "object", description: "User account" },
            { name: "UserRole", kind: "enum", values: ["admin", "user", "guest"] },
          ],
        },
      };
    }
    return { success: false, error: `Unknown query: ${query}` };
  },

  create_user(params) {
    const email = params.email as string;
    const name = params.name as string;
    if (!email) return { success: false, error: "Missing required parameter: email" };
    if (!name) return { success: false, error: "Missing required parameter: name" };

    const id = String(nextId++);
    const user: User = {
      id,
      email,
      name,
      roles: [(params.role as string) ?? "user"],
      verified: false,
      created_at: new Date().toISOString(),
    };
    users.set(id, user);
    return { success: true, data: user };
  },

  add_role(params) {
    const user = users.get(params.user_id as string);
    if (!user) return { success: false, error: "User not found" };
    const role = params.role as string;
    if (!role) return { success: false, error: "Missing required parameter: role" };
    if (!user.roles.includes(role)) user.roles.push(role);
    return { success: true, data: user };
  },

  list_users() {
    return { success: true, data: { items: Array.from(users.values()), total: users.size } };
  },

  get_user(params) {
    const user = users.get(params.user_id as string);
    if (!user) return { success: false, error: "User not found" };
    return { success: true, data: user };
  },

  update_user(params) {
    const user = users.get(params.user_id as string);
    if (!user) return { success: false, error: "User not found" };
    if (params.name) user.name = params.name as string;
    if (params.email) user.email = params.email as string;
    return { success: true, data: user };
  },

  delete_user(params) {
    const id = params.user_id as string;
    if (!users.has(id)) return { success: false, error: "User not found" };
    users.delete(id);
    return { success: true, data: { deleted: id } };
  },

  remove_role(params) {
    const user = users.get(params.user_id as string);
    if (!user) return { success: false, error: "User not found" };
    const role = params.role as string;
    user.roles = user.roles.filter((r) => r !== role);
    return { success: true, data: user };
  },

  send_verification_email(params) {
    const user = users.get(params.user_id as string);
    if (!user) return { success: false, error: "User not found" };
    // In a real adapter, this would call an email service
    user.verified = true;
    return { success: true, data: { sent_to: user.email, status: "sent" } };
  },
};

// --- MCP server setup ---

const server = new Server(
  { name: "user-management-mcpaql-adapter", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler("tools/list" as any, async () => ({
  tools: ENDPOINT_TOOLS.map((name) => ({
    name,
    description: `${getEndpointForTool(name)} operations`,
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", description: "Operation name" },
        params: { type: "object", description: "Operation parameters" },
      },
      required: ["operation"],
    },
  })),
}));

server.setRequestHandler("tools/call" as any, async (request: any) => {
  const { name: toolName, arguments: args } = request.params;

  if (!ENDPOINT_TOOLS.includes(toolName)) {
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: `Unknown tool: ${toolName}` }) }],
    };
  }

  const expectedEndpoint = getEndpointForTool(toolName);
  const operation = args.operation as string;
  const params = (args.params ?? {}) as Record<string, unknown>;

  // Validate endpoint routing
  const opDef = OPERATIONS.find((o) => o.name === operation);
  if (!opDef) {
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: `Unknown operation: ${operation}` }) }],
    };
  }

  if (opDef.endpoint !== expectedEndpoint) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: `Operation '${operation}' must be called via mcp_aql_${opDef.endpoint.toLowerCase()}, not ${toolName}`,
          }),
        },
      ],
    };
  }

  const handler = handlers[operation];
  const result = handler(params);

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
});

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
