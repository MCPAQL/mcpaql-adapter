/**
 * The runnable read-only Discord adapter: an MCP server that exposes the
 * MCP-AQL READ endpoint (`mcp_aql_read`) over the operation layer in
 * `discord-operations.ts`. Every operation is a read; the server has one
 * tool and it is annotated read-only.
 *
 * This module builds the server around an injected `evaluate` so it can be
 * tested in-process over an in-memory transport. `src/bin/discord.ts` wires
 * it to the real transport and stdio.
 *
 * Operations run one at a time. Two reads at once would fight over the one
 * Discord tab (a navigation for one while the other is scrolling), so calls
 * are queued in arrival order; a client that fans out still gets every
 * answer, just serially.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolRequest, CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

import {
  DISCORD_OPERATIONS,
  DISCORD_TOOL_NAME,
  buildIntrospection,
  resolveOperationArguments,
  runDiscordOperation,
  type DiscordOperationDeps,
  type OperationResult,
} from "../plugins/transport/discord-operations.js";

/** The name the server reports to clients. */
export const DISCORD_ADAPTER_NAME = "mcpaql-discord";

export interface DiscordServerOptions {
  deps: DiscordOperationDeps;
  /** Reported in the MCP handshake and in `introspect`'s `_protocol.version`. */
  version: string;
}

/** The one tool's description: what it serves and how to discover parameters. */
export function buildToolDescription(): string {
  return [
    "READ operations for the read-only Discord adapter. Reads the Discord web client already open in your own Chrome: no bot, no token, no Discord API, never sends, reacts, edits, types, or clicks.",
    "",
    `Supported operations: introspect, ${DISCORD_OPERATIONS.map((op) => op.name).join(", ")}`,
    "",
    "Discover parameters:",
    '{ operation: "introspect", params: { query: "operations", name: "read_messages" } }',
  ].join("\n");
}

/** MCP-AQL tool results are the envelope as JSON text; `success` is the discriminator a client reads. */
export function textResult(payload: OperationResult): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** Run tasks strictly one after another, in arrival order. */
export function createQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function createDiscordServer(options: DiscordServerOptions): Server {
  const server = new Server({ name: DISCORD_ADAPTER_NAME, version: options.version }, { capabilities: { tools: {} } });
  const queue = createQueue();

  server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => ({
    tools: [
      {
        name: DISCORD_TOOL_NAME,
        description: buildToolDescription(),
        inputSchema: {
          type: "object",
          properties: {
            operation: { type: "string", description: "MCP-AQL operation name." },
            params: { type: "object", description: "Operation parameters." },
          },
          required: ["operation"],
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<CallToolResult> => {
    const toolName = request.params.name;
    const { operation, params } = resolveOperationArguments(request.params.arguments);
    if (toolName !== DISCORD_TOOL_NAME) {
      return textResult({
        success: false,
        error: { code: "NOT_FOUND_OPERATION", message: `Tool '${toolName}' is not served; every Discord operation is a read on ${DISCORD_TOOL_NAME}.`, details: { tool: toolName } },
      });
    }
    if (operation === "introspect") return textResult(buildIntrospection(params, options.version));
    return textResult(await queue(() => runDiscordOperation(options.deps, operation, params)));
  });

  return server;
}
