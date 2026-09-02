/**
 * MCP-AQL operation layer for the read-only Discord adapter: the operation
 * registry (schema-driven dispatch, ADR-002), parameter validation, the
 * `{ success, data } | { success, error }` envelope, and introspection.
 *
 * Everything here is a pure function of its inputs plus one injected
 * `evaluate` (ADR-003: no request state lives in the module). The runnable
 * server binds these operations to MCP tools; this module has no I/O of
 * its own.
 *
 * The adapter is read-only by construction. Every operation is a READ, and
 * every expression an operation sends to the page comes from the builders
 * registered in `discord-scripts.ts`, whose side effects are tested. The
 * `effects` field on each operation names the effects its scripts may
 * declare, so the same scan can be run over what an operation actually
 * evaluates (see test/discord-operations.test.ts).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { CdpTransportError } from "./browser-cdp.js";
import { readMessages, type ReadMessagesDeps, type ReadMessagesParams } from "./discord-history.js";
import {
  DEFAULT_LIST_LIMIT,
  OpenChannelTimeout,
  SNOWFLAKE_PATTERN,
  buildListExpression,
  isSnowflake,
} from "./discord-nav.js";
import type { DeclaredEffect } from "./discord-scripts.js";

// --- Registry ---

export type ParamType = "string" | "integer" | "boolean";

export interface ParamDefinition {
  name: string;
  type: ParamType;
  required: boolean;
  description: string;
  default?: unknown;
  /** Inclusive bounds for integers; values outside are clamped, as the library does. */
  min?: number;
  max?: number;
  /** Regex source a string must match. */
  pattern?: string;
}

export interface DiscordOperation {
  name: string;
  /** Every Discord operation is a read. */
  endpoint: "READ";
  description: string;
  params: readonly ParamDefinition[];
  /** Page-script effects this operation's scripts may declare; nothing else may appear in what it evaluates. */
  effects: readonly DeclaredEffect[];
  danger_level: "safe";
  /** The one observable effect on the user's account, when there is one. */
  side_effect: string | null;
}

/** The only tool an all-read adapter exposes. */
export const DISCORD_TOOL_NAME = "mcp_aql_read";

/** The origin the transport is pinned to; nothing else is ever attached. */
export const DISCORD_ORIGIN = "https://discord.com";

const LIMIT_MAX = 1000;
const SNOWFLAKE_HELP = "a Discord snowflake id (15 to 22 digits)";

const limitParam = (what: string): ParamDefinition => ({
  name: "limit",
  type: "integer",
  required: false,
  default: DEFAULT_LIST_LIMIT,
  min: 1,
  max: LIMIT_MAX,
  description: `Most ${what} to return. There is no cursor: raise the limit and call again when truncated is true.`,
});

export const DISCORD_OPERATIONS: readonly DiscordOperation[] = [
  {
    name: "list_dms",
    endpoint: "READ",
    description: "Direct and group message conversations from the Discord sidebar: id, name, kind, presence, unread. Friends, Nitro, Shop, and message requests are excluded.",
    params: [limitParam("conversations")],
    effects: [],
    danger_level: "safe",
    side_effect: null,
  },
  {
    name: "list_guilds",
    endpoint: "READ",
    description: "Servers the signed-in user belongs to, from the server rail: id, name, and the raw sidebar label.",
    params: [limitParam("servers")],
    effects: [],
    danger_level: "safe",
    side_effect: null,
  },
  {
    name: "list_channels",
    endpoint: "READ",
    description: "Text and voice channels of the server currently open in the Discord tab, with their category, plus that server's id and name. Open the server in the tab first.",
    params: [limitParam("channels")],
    effects: [],
    danger_level: "safe",
    side_effect: null,
  },
  {
    name: "read_messages",
    endpoint: "READ",
    description: "Messages of one channel or conversation, newest first, with author, timestamp, full text, replies, reactions, attachment links, embeds, links, and edited flag. Scrolls for older history until limit is filled or a bound stops it; every stop is named and resumable.",
    params: [
      { name: "channel_id", type: "string", required: true, pattern: SNOWFLAKE_PATTERN, description: `Channel or conversation id, ${SNOWFLAKE_HELP}.` },
      { name: "guild_id", type: "string", required: false, pattern: SNOWFLAKE_PATTERN, description: `Server id for a server channel, ${SNOWFLAKE_HELP}. Omit for a direct or group message.` },
      { name: "before", type: "string", required: false, pattern: SNOWFLAKE_PATTERN, description: "Return only messages older than this message id. Pass the cursor of a previous read to continue." },
      { name: "limit", type: "integer", required: false, default: 50, min: 1, max: 500, description: "Messages wanted." },
      { name: "scan_cap", type: "integer", required: false, default: 2000, min: 1, max: 100_000, description: "Most rows examined across all scroll steps." },
      { name: "time_budget_ms", type: "integer", required: false, default: 20_000, min: 1000, max: 300_000, description: "Wall-clock budget for the whole read, in milliseconds." },
      { name: "window_max_bytes", type: "integer", required: false, default: 4 * 1024 * 1024, min: 64 * 1024, max: 8 * 1024 * 1024, description: "Bytes allowed per in-page extraction." },
      { name: "redact", type: "boolean", required: false, default: false, description: "Mask high and critical untrusted-content findings with [CONTENT_BLOCKED]. Flags are reported either way." },
    ],
    effects: ["navigate-same-origin", "scroll-message-list"],
    danger_level: "safe",
    side_effect: "Opening the channel marks it read in Discord, exactly as clicking it does.",
  },
];

/** Result types, for `introspect { query: "types" }`. Descriptions, not schemas. */
export const DISCORD_TYPES: ReadonlyArray<{ name: string; kind: "object"; description: string; fields: readonly string[] }> = [
  { name: "DiscordDm", kind: "object", description: "A direct or group conversation from the sidebar.", fields: ["id", "name", "kind", "status", "unread"] },
  { name: "DiscordGuild", kind: "object", description: "A server from the server rail.", fields: ["id", "name", "raw_label"] },
  { name: "DiscordChannel", kind: "object", description: "A channel of the open server.", fields: ["id", "name", "kind", "category", "href"] },
  { name: "DiscordMessage", kind: "object", description: "One rendered message. Attachments are URLs and filenames only; nothing is downloaded.", fields: ["id", "channel_id", "author", "author_inherited", "author_ref", "timestamp", "content", "reply_to", "reply_label", "reactions", "attachments", "embeds", "links", "edited"] },
  { name: "ListResult", kind: "object", description: "Envelope of the three listings. `problem` names why the list is empty when the page did not look as expected.", fields: ["items", "count", "truncated", "problem"] },
  { name: "ReadMessagesResult", kind: "object", description: "Bounded-scan envelope of read_messages. `complete` is true only when limit was filled or the beginning was reached; otherwise `stop_reason` says why and `cursor` is where to continue.", fields: ["channel", "messages", "count", "scanned", "cursor", "complete", "truncated", "stop_reason", "problem", "elapsed_ms", "flags", "flagged_ids", "highest_severity"] },
];

export function findOperation(name: string): DiscordOperation | undefined {
  return DISCORD_OPERATIONS.find((op) => op.name === name);
}

// --- Envelope ---

export interface OperationSuccess {
  success: true;
  data: unknown;
}

export interface OperationFailure {
  success: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export type OperationResult = OperationSuccess | OperationFailure;

/** A failure raised by this layer: validation and lookup, before anything reaches the page. */
export class DiscordOperationError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "DiscordOperationError";
  }
}

/**
 * Map any failure to the MCP-AQL error envelope. Transport failures keep
 * their own codes (a closed port arrives as TRANSPORT_CDP_PORT_CLOSED with
 * the launch hint in its message); a channel that never mounted is a
 * NOT_FOUND_RESOURCE; anything unexpected is INTERNAL_ERROR with its text.
 */
export function errorEnvelope(err: unknown): OperationFailure {
  if (err instanceof DiscordOperationError) {
    return { success: false, error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } };
  }
  if (err instanceof CdpTransportError) {
    return { success: false, error: { code: err.code, message: err.message, ...(err.detail ? { details: err.detail } : {}) } };
  }
  if (err instanceof OpenChannelTimeout) {
    return {
      success: false,
      error: {
        code: "NOT_FOUND_RESOURCE",
        message: err.message,
        details: { resource_type: "channel", resource_id: err.channelId, timeout_ms: err.timeoutMs, path: err.path },
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { success: false, error: { code: "INTERNAL_ERROR", message: message === "" ? "Unexpected failure with no message." : message } };
}

// --- Parameters ---

/**
 * The `{ operation, params }` shape MCP-AQL tools take. Parameters may be
 * nested under `params` or given flat beside `operation`; nested wins.
 */
export function resolveOperationArguments(args: unknown): { operation: string; params: Record<string, unknown> } {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return { operation: "", params: {} };
  const a = args as Record<string, unknown>;
  const operation = typeof a.operation === "string" ? a.operation : "";
  if (typeof a.params === "object" && a.params !== null && !Array.isArray(a.params)) {
    return { operation, params: a.params as Record<string, unknown> };
  }
  const flat = { ...a };
  delete flat.operation;
  delete flat.params;
  return { operation, params: flat };
}

/**
 * Check `raw` against an operation's parameter definitions and return the
 * values the handler receives: defaults filled, integers clamped to their
 * bounds, `null` treated as absent. Unknown
 * parameters are refused rather than ignored, so a misspelled `chanel_id`
 * cannot silently read the wrong thing.
 */
export function validateParams(op: DiscordOperation, raw: Record<string, unknown>): Record<string, unknown> {
  const known = new Set(op.params.map((p) => p.name));
  const unknown = Object.keys(raw).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new DiscordOperationError(
      "VALIDATION_UNKNOWN_PARAM",
      `Operation '${op.name}' does not accept parameter(s) '${unknown.join("', '")}'. Use introspect for the parameter list.`,
      { operation: op.name, unknown_params: unknown },
    );
  }
  const out: Record<string, unknown> = {};
  for (const def of op.params) {
    let value = raw[def.name];
    if (value === null) value = undefined;
    if (value === undefined) {
      if (def.required) {
        throw new DiscordOperationError(
          "VALIDATION_MISSING_PARAM",
          `Missing required parameter '${def.name}' for operation '${op.name}'.`,
          { operation: op.name, param_name: def.name },
        );
      }
      if (def.default !== undefined) out[def.name] = def.default;
      continue;
    }
    out[def.name] = checkValue(op, def, value);
  }
  return out;
}

function checkValue(op: DiscordOperation, def: ParamDefinition, value: unknown): unknown {
  const invalid = (expected: string): DiscordOperationError =>
    new DiscordOperationError(
      "VALIDATION_INVALID_TYPE",
      `Invalid type for parameter '${def.name}' of operation '${op.name}': expected ${expected}, got ${describeValue(value)}.`,
      { operation: op.name, param_name: def.name, expected, actual: typeof value },
    );
  switch (def.type) {
    case "string": {
      if (typeof value !== "string") throw invalid("string");
      if (def.pattern !== undefined && !new RegExp(def.pattern).test(value)) throw invalid(def.pattern === SNOWFLAKE_PATTERN ? SNOWFLAKE_HELP : `a string matching ${def.pattern}`);
      return value;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) throw invalid("integer");
      let n = value;
      if (def.min !== undefined) n = Math.max(def.min, n);
      if (def.max !== undefined) n = Math.min(def.max, n);
      return n;
    }
    case "boolean": {
      if (typeof value !== "boolean") throw invalid("boolean");
      return value;
    }
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return `string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`;
  return typeof value;
}

// --- Dispatch ---

/** What an operation needs from the outside world: the transport's evaluate, plus test injection points. */
export type DiscordOperationDeps = ReadMessagesDeps;

/**
 * Run one operation and return its envelope. Never throws: every failure,
 * including a transport that cannot reach Chrome, comes back as
 * `{ success: false, error }` so a client always gets a named answer.
 */
export async function runDiscordOperation(deps: DiscordOperationDeps, name: string, rawParams: Record<string, unknown>): Promise<OperationResult> {
  try {
    const op = findOperation(name);
    if (op === undefined) {
      throw new DiscordOperationError("NOT_FOUND_OPERATION", `Operation '${name}' not found. Use introspect for the list.`, { operation: name });
    }
    const params = validateParams(op, rawParams);
    return { success: true, data: await dispatch(deps, op, params) };
  } catch (err) {
    return errorEnvelope(err);
  }
}

async function dispatch(deps: DiscordOperationDeps, op: DiscordOperation, params: Record<string, unknown>): Promise<unknown> {
  switch (op.name) {
    case "list_dms":
      return deps.evaluate(buildListExpression("listDms", { limit: params.limit as number }));
    case "list_guilds":
      return deps.evaluate(buildListExpression("listGuilds", { limit: params.limit as number }));
    case "list_channels":
      return deps.evaluate(buildListExpression("listChannels", { limit: params.limit as number }));
    case "read_messages": {
      // Validated above; the library re-checks the snowflakes itself.
      if (!isSnowflake(params.channel_id)) throw new DiscordOperationError("VALIDATION_INVALID_TYPE", "channel_id must be a Discord snowflake.");
      return readMessages(deps, params as unknown as ReadMessagesParams);
    }
    default:
      throw new DiscordOperationError("NOT_FOUND_OPERATION", `Operation '${op.name}' has no handler.`, { operation: op.name });
  }
}

// --- Introspection ---

const INTROSPECT_DETAILS = {
  name: "introspect",
  endpoint: "READ",
  mcpTool: DISCORD_TOOL_NAME,
  description: "Discover available operations and result types.",
  parameters: [
    { name: "query", type: "string", required: true, description: "'operations' or 'types'", enum: ["operations", "types"] },
    { name: "name", type: "string", required: false, description: "Operation or type name for details." },
  ],
} as const;

function operationDetails(op: DiscordOperation) {
  return {
    name: op.name,
    endpoint: op.endpoint,
    mcpTool: DISCORD_TOOL_NAME,
    description: op.description,
    danger_level: op.danger_level,
    side_effect: op.side_effect,
    parameters: op.params.map((p) => ({
      name: p.name,
      type: p.type,
      required: p.required,
      description: p.description,
      ...(p.default !== undefined ? { default: p.default } : {}),
      ...(p.min !== undefined ? { min: p.min } : {}),
      ...(p.max !== undefined ? { max: p.max } : {}),
      ...(p.pattern !== undefined ? { pattern: p.pattern } : {}),
    })),
  };
}

/** The `introspect` operation. `version` is the adapter's, reported under `_protocol`. */
export function buildIntrospection(params: Record<string, unknown>, version: string): OperationResult {
  const query = typeof params.query === "string" ? params.query : undefined;
  const name = typeof params.name === "string" ? params.name : undefined;
  if (query === "operations") {
    if (name !== undefined) {
      if (name === "introspect") return { success: true, data: { operation: INTROSPECT_DETAILS } };
      const op = findOperation(name);
      if (op === undefined) return errorEnvelope(new DiscordOperationError("NOT_FOUND_OPERATION", `Operation '${name}' not found.`, { operation: name }));
      return { success: true, data: { operation: operationDetails(op) } };
    }
    return {
      success: true,
      data: {
        _protocol: { version, mode: "crude", read_only: true },
        operations: [
          { name: "introspect", endpoint: "READ", description: INTROSPECT_DETAILS.description },
          ...DISCORD_OPERATIONS.map((op) => ({ name: op.name, endpoint: op.endpoint, description: op.description })),
        ],
      },
    };
  }
  if (query === "types") {
    if (name !== undefined) {
      const type = DISCORD_TYPES.find((t) => t.name === name);
      if (type === undefined) return errorEnvelope(new DiscordOperationError("NOT_FOUND_RESOURCE", `Type '${name}' not found.`, { resource_type: "type", resource_id: name }));
      return { success: true, data: { type } };
    }
    return { success: true, data: { types: DISCORD_TYPES } };
  }
  return errorEnvelope(new DiscordOperationError(
    "VALIDATION_INVALID_TYPE",
    `Invalid type for parameter 'query' of operation 'introspect': expected 'operations' or 'types', got ${describeValue(params.query)}.`,
    { operation: "introspect", param_name: "query", expected: "'operations' | 'types'" },
  ));
}
