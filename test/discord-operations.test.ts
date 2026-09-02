/**
 * Tests for the Discord MCP-AQL operation layer: registry, parameter
 * validation, dispatch, the error envelope, introspection, and the
 * read-only scan run over what each operation actually evaluates.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CdpTransportError, launchHint } from "../src/plugins/transport/browser-cdp.js";
import type { DiscordMessage, ExtractResult } from "../src/plugins/transport/discord-dom.js";
import type { ScrollStepResult } from "../src/plugins/transport/discord-history.js";
import { OpenChannelTimeout, buildListExpression, channelPath } from "../src/plugins/transport/discord-nav.js";
import {
  DISCORD_OPERATIONS,
  DISCORD_TOOL_NAME,
  DISCORD_TYPES,
  DiscordOperationError,
  buildIntrospection,
  errorEnvelope,
  findOperation,
  resolveOperationArguments,
  runDiscordOperation,
  validateParams,
  type DiscordOperation,
  type OperationFailure,
} from "../src/plugins/transport/discord-operations.js";
import { FORBIDDEN_PRIMITIVES, GATED_PRIMITIVES, type DeclaredEffect } from "../src/plugins/transport/discord-scripts.js";

const CH = "1520443442982031486";
const G = "1210290974601773056";

function op(name: string): DiscordOperation {
  const found = findOperation(name);
  assert.ok(found, `operation ${name} is registered`);
  return found;
}

/** node:assert's throws() returns nothing; this returns the error so its code can be checked. */
function thrown(fn: () => unknown): DiscordOperationError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof DiscordOperationError, `expected a DiscordOperationError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected a throw");
}

function failure(result: unknown): OperationFailure["error"] {
  const r = result as OperationFailure;
  assert.equal(r.success, false, `expected a failure envelope, got ${JSON.stringify(result)}`);
  return r.error;
}

function msg(n: number): DiscordMessage {
  return {
    id: String(1_544_000_000_000_000_000n + BigInt(n)),
    channel_id: CH,
    author: "Alice",
    author_inherited: false,
    author_ref: null,
    timestamp: null,
    content: `m${n}`,
    reply_to: null,
    reply_label: null,
    reactions: [],
    attachments: [],
    embeds: [],
    links: [],
    edited: false,
  };
}

/**
 * A fake Discord tab driven by the shape of each expression: the channel
 * mounts after a navigation, the extractor sees `rows`, and each scroll step
 * prepends `perScroll` older rows. Records everything evaluated.
 */
function fakeTab(options: { history?: DiscordMessage[]; initial?: number; perScroll?: number; open?: boolean } = {}) {
  const history = options.history ?? [];
  let mountedRows = Math.min(options.initial ?? history.length, history.length);
  let open = options.open ?? false;
  const evaluated: string[] = [];
  const rows = (): DiscordMessage[] => history.slice(history.length - mountedRows);
  const probe = (): ScrollStepResult => ({ count: mountedRows, oldestId: rows()[0]?.id ?? null, moreAbove: mountedRows < history.length, problem: null });
  const evaluate = async (expression: string): Promise<unknown> => {
    evaluated.push(expression);
    if (expression.includes("history.pushState")) { open = true; return true; }
    if (expression.includes("function listDms") || expression.includes("function listGuilds") || expression.includes("function listChannels")) {
      return { items: [{ id: CH, name: "Test Friend" }], count: 1, truncated: false, problem: null, ...(expression.includes("function listChannels") ? { guild: { id: G, name: "Guild" } } : {}) };
    }
    if (expression.includes("function extractMessages")) {
      const window: ExtractResult = { channel: { id: CH, label: "Test Friend" }, messages: rows(), count: mountedRows, scanned: mountedRows, truncated: false, problem: null };
      return window;
    }
    if (expression.includes("function scrollNudge")) {
      const before = probe();
      mountedRows = Math.min(history.length, mountedRows + (options.perScroll ?? 0));
      return before;
    }
    if (expression.includes("function mountedCount")) return probe();
    if (expression.includes("ol[data-list-id=") && !expression.includes("function ")) return open; // mounted probe, plain or anchored
    throw new Error(`fake tab got an unexpected expression: ${expression.slice(0, 80)}`);
  };
  return { evaluate, evaluated, sleep: async () => {} };
}

// --- Registry ---

test("the registry exposes exactly the four read operations, all safe, all READ", () => {
  assert.deepEqual(DISCORD_OPERATIONS.map((o) => o.name), ["list_dms", "list_guilds", "list_channels", "read_messages"]);
  for (const o of DISCORD_OPERATIONS) {
    assert.equal(o.endpoint, "READ");
    assert.equal(o.danger_level, "safe");
    assert.ok(/^[a-z_]+$/.test(o.name), `${o.name} is snake_case`);
    for (const p of o.params) {
      assert.ok(/^[a-z_]+$/.test(p.name), `${o.name}.${p.name} is snake_case`);
      assert.ok(p.description.length > 0);
      if (p.default !== undefined && p.type === "integer") {
        const d = p.default as number;
        assert.ok(Number.isInteger(d) && (p.min === undefined || d >= p.min) && (p.max === undefined || d <= p.max), `${o.name}.${p.name} default within bounds`);
      }
    }
  }
  assert.equal(DISCORD_TOOL_NAME, "mcp_aql_read");
});

test("only read_messages has a side effect, and it is the documented one", () => {
  for (const o of DISCORD_OPERATIONS) {
    if (o.name === "read_messages") assert.match(o.side_effect ?? "", /marks it read/);
    else assert.equal(o.side_effect, null);
  }
});

// --- Parameters ---

test("validateParams fills defaults and clamps integers to their bounds", () => {
  assert.deepEqual(validateParams(op("list_dms"), {}), { limit: 200 });
  assert.deepEqual(validateParams(op("list_dms"), { limit: 0 }), { limit: 1 });
  assert.deepEqual(validateParams(op("list_dms"), { limit: 5000 }), { limit: 1000 });
  const rm = validateParams(op("read_messages"), { channel_id: CH });
  assert.deepEqual(rm, { channel_id: CH, limit: 50, scan_cap: 2000, time_budget_ms: 20_000, window_max_bytes: 4 * 1024 * 1024, redact: false });
});

test("validateParams treats null as absent, so a required null is a missing parameter", () => {
  const rm = validateParams(op("read_messages"), { channel_id: CH, guild_id: null, before: null });
  assert.equal("guild_id" in rm, false);
  assert.equal("before" in rm, false);
  const err = thrown(() => validateParams(op("read_messages"), { channel_id: null }));
  assert.equal(err.code, "VALIDATION_MISSING_PARAM");
});

test("validateParams names the missing, mistyped, malformed, and unknown parameter", () => {
  const missing = thrown(() => validateParams(op("read_messages"), {}));
  assert.equal(missing.code, "VALIDATION_MISSING_PARAM");
  assert.match(missing.message, /'channel_id'/);
  assert.deepEqual(missing.details, { operation: "read_messages", param_name: "channel_id" });

  const typed = thrown(() => validateParams(op("read_messages"), { channel_id: CH, limit: "50" }));
  assert.equal(typed.code, "VALIDATION_INVALID_TYPE");
  assert.match(typed.message, /'limit'.*expected integer, got string/);

  const fractional = thrown(() => validateParams(op("read_messages"), { channel_id: CH, limit: 1.5 }));
  assert.equal(fractional.code, "VALIDATION_INVALID_TYPE");

  const malformed = thrown(() => validateParams(op("read_messages"), { channel_id: "general" }));
  assert.equal(malformed.code, "VALIDATION_INVALID_TYPE");
  assert.match(malformed.message, /snowflake/);

  const bool = thrown(() => validateParams(op("read_messages"), { channel_id: CH, redact: "yes" }));
  assert.equal(bool.code, "VALIDATION_INVALID_TYPE");

  const unknown = thrown(() => validateParams(op("read_messages"), { chanel_id: CH }));
  assert.equal(unknown.code, "VALIDATION_UNKNOWN_PARAM");
  assert.deepEqual(unknown.details, { operation: "read_messages", unknown_params: ["chanel_id"] });
});

test("resolveOperationArguments accepts nested params or flat arguments, nested winning", () => {
  assert.deepEqual(resolveOperationArguments({ operation: "list_dms", params: { limit: 3 } }), { operation: "list_dms", params: { limit: 3 } });
  assert.deepEqual(resolveOperationArguments({ operation: "list_dms", limit: 3 }), { operation: "list_dms", params: { limit: 3 } });
  assert.deepEqual(resolveOperationArguments({ operation: "list_dms", limit: 9, params: { limit: 3 } }), { operation: "list_dms", params: { limit: 3 } });
  assert.deepEqual(resolveOperationArguments({ operation: "read_messages", channel_id: CH, params: { limit: 10 } }), { operation: "read_messages", params: { channel_id: CH, limit: 10 } });
  assert.deepEqual(resolveOperationArguments(undefined), { operation: "", params: {} });
  assert.deepEqual(resolveOperationArguments({ params: [1] }), { operation: "", params: {} });
});

// --- Dispatch ---

test("the listings evaluate exactly the registered builder output and return its result as data", async () => {
  for (const [name, fn] of [["list_dms", "listDms"], ["list_guilds", "listGuilds"], ["list_channels", "listChannels"]] as const) {
    const tab = fakeTab();
    const result = await runDiscordOperation(tab, name, { limit: 7 });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(tab.evaluated, [buildListExpression(fn, { limit: 7 })]);
    const data = (result as { data: { count: number; problem: null } }).data;
    assert.equal(data.count, 1);
    assert.equal(data.problem, null);
  }
});

test("read_messages opens the channel, backfills, and returns the bounded-scan envelope", async () => {
  const history = Array.from({ length: 12 }, (_, i) => msg(i + 1));
  const tab = fakeTab({ history, initial: 4, perScroll: 4 });
  const result = await runDiscordOperation(tab, "read_messages", { channel_id: CH, guild_id: G, limit: 10, time_budget_ms: 5000 });
  assert.equal(result.success, true, JSON.stringify(result));
  const data = (result as { data: { count: number; complete: boolean; stop_reason: string; messages: DiscordMessage[]; cursor: string | null } }).data;
  assert.equal(data.count, 10);
  assert.equal(data.complete, true);
  assert.equal(data.stop_reason, "filled");
  assert.equal(data.messages[0].id, history[11].id, "newest first");
  assert.equal(data.cursor, history[2].id);
  // It navigated to the guild path built from the validated ids, and nothing else.
  const pushes = tab.evaluated.filter((e) => e.includes("history.pushState"));
  assert.equal(pushes.length, 1);
  assert.ok(pushes[0].includes(JSON.stringify(channelPath({ guildId: G, channelId: CH }))));
});

test("a channel that never mounts is NOT_FOUND_RESOURCE with the channel named, never a hang", async () => {
  const tab = fakeTab();
  tab.evaluate = async (expression: string) => {
    if (expression.includes("history.pushState")) return true;
    if (expression.includes("location.pathname")) return false; // never mounts
    throw new Error("unexpected");
  };
  const result = await runDiscordOperation(tab, "read_messages", { channel_id: CH, time_budget_ms: 1000 });
  const error = failure(result);
  assert.equal(error.code, "NOT_FOUND_RESOURCE");
  assert.deepEqual(error.details?.resource_id, CH);
  assert.equal(error.details?.resource_type, "channel");
  assert.match(error.message, /did not open/);
});

test("an unknown operation is NOT_FOUND_OPERATION and evaluates nothing", async () => {
  const tab = fakeTab();
  const error = failure(await runDiscordOperation(tab, "send_message", {}));
  assert.equal(error.code, "NOT_FOUND_OPERATION");
  assert.deepEqual(tab.evaluated, []);
});

test("a validation failure evaluates nothing", async () => {
  const tab = fakeTab();
  const error = failure(await runDiscordOperation(tab, "read_messages", { channel_id: "nope" }));
  assert.equal(error.code, "VALIDATION_INVALID_TYPE");
  assert.deepEqual(tab.evaluated, []);
});

test("a closed port comes back as TRANSPORT_CDP_PORT_CLOSED with the launch hint, not as a throw", async () => {
  const closed = new CdpTransportError("TRANSPORT_CDP_PORT_CLOSED", `Cannot reach Chrome DevTools at http://127.0.0.1:9222/json/list: ECONNREFUSED. ${launchHint(9222)}`, { host: "127.0.0.1", port: 9222 });
  const result = await runDiscordOperation({ evaluate: async () => { throw closed; } }, "list_dms", {});
  const error = failure(result);
  assert.equal(error.code, "TRANSPORT_CDP_PORT_CLOSED");
  assert.ok(error.message.includes(launchHint(9222)));
  assert.deepEqual(error.details, { host: "127.0.0.1", port: 9222 });
});

test("errorEnvelope keeps transport codes, maps the channel timeout, and never returns an empty message", () => {
  assert.equal(errorEnvelope(new CdpTransportError("TRANSPORT_CDP_ORIGIN_REFUSED", "left origin")).error.code, "TRANSPORT_CDP_ORIGIN_REFUSED");
  assert.equal(errorEnvelope(new OpenChannelTimeout(CH, 100, "/channels/@me/" + CH)).error.code, "NOT_FOUND_RESOURCE");
  assert.equal(errorEnvelope(new Error("boom")).error.code, "INTERNAL_ERROR");
  assert.equal(errorEnvelope(new Error("")).error.message.length > 0, true);
  assert.equal(errorEnvelope("plain string").error.message, "plain string");
  assert.equal("details" in errorEnvelope(new Error("boom")).error, false);
});

// --- Read-only scan over what operations actually evaluate ---

test("everything an operation evaluates passes the read-only scan under that operation's declared effects", async () => {
  const history = Array.from({ length: 12 }, (_, i) => msg(i + 1));
  const runs: Array<[string, Record<string, unknown>, ReturnType<typeof fakeTab>]> = [
    ["list_dms", { limit: 3 }, fakeTab()],
    ["list_guilds", {}, fakeTab()],
    ["list_channels", {}, fakeTab()],
    ["read_messages", { channel_id: CH, guild_id: G, before: history[11].id, limit: 6, time_budget_ms: 5000 }, fakeTab({ history, initial: 4, perScroll: 4 })],
  ];
  const effects = Object.keys(GATED_PRIMITIVES) as DeclaredEffect[];
  for (const [name, params, tab] of runs) {
    const result = await runDiscordOperation(tab, name, params);
    assert.equal(result.success, true, `${name}: ${JSON.stringify(result)}`);
    assert.ok(tab.evaluated.length > 0, `${name} evaluated something`);
    const declared = op(name).effects;
    for (const text of tab.evaluated) {
      for (const primitive of FORBIDDEN_PRIMITIVES) {
        assert.ok(!text.includes(primitive), `${name} evaluated forbidden primitive ${JSON.stringify(primitive)}`);
      }
      for (const effect of effects) {
        if (declared.includes(effect)) continue;
        for (const primitive of GATED_PRIMITIVES[effect]) {
          assert.ok(!text.includes(primitive), `${name} evaluated ${JSON.stringify(primitive)} without declaring ${effect}`);
        }
      }
    }
  }
  // read_messages really did navigate and scroll, so the declarations are exercised, not decorative.
  const rm = runs[3][2].evaluated;
  assert.ok(rm.some((e) => e.includes("history.pushState")));
  assert.ok(rm.some((e) => e.includes("scrollTop")));
});

// --- Introspection ---

test("introspect lists every operation plus itself, and details one by name", () => {
  const all = buildIntrospection({ query: "operations" }, "0.1.0");
  assert.equal(all.success, true);
  const data = (all as { data: { _protocol: { version: string; read_only: boolean }; operations: Array<{ name: string; endpoint: string }> } }).data;
  assert.equal(data._protocol.version, "0.1.0");
  assert.equal(data._protocol.read_only, true);
  assert.deepEqual(data.operations.map((o) => o.name), ["introspect", "list_dms", "list_guilds", "list_channels", "read_messages"]);
  assert.ok(data.operations.every((o) => o.endpoint === "READ"));

  const one = buildIntrospection({ query: "operations", name: "read_messages" }, "0.1.0");
  const details = (one as { data: { operation: { mcpTool: string; parameters: Array<{ name: string; required: boolean; default?: unknown }>; side_effect: string } } }).data.operation;
  assert.equal(details.mcpTool, "mcp_aql_read");
  assert.equal(details.parameters.find((p) => p.name === "channel_id")?.required, true);
  assert.equal(details.parameters.find((p) => p.name === "limit")?.default, 50);
  assert.match(details.side_effect, /marks it read/);

  const self = buildIntrospection({ query: "operations", name: "introspect" }, "0.1.0");
  assert.equal((self as { data: { operation: { name: string } } }).data.operation.name, "introspect");

  assert.equal(failure(buildIntrospection({ query: "operations", name: "send_message" }, "0.1.0")).code, "NOT_FOUND_OPERATION");
  const badName = failure(buildIntrospection({ query: "operations", name: 123 }, "0.1.0"));
  assert.equal(badName.code, "VALIDATION_INVALID_TYPE");
  assert.match(badName.message, /'name'/);
  assert.equal(buildIntrospection({ query: "operations", name: null }, "0.1.0").success, true, "null name means no filter");
  const misspelled = failure(buildIntrospection({ query: "operations", nmae: "read_messages" }, "0.1.0"));
  assert.equal(misspelled.code, "VALIDATION_UNKNOWN_PARAM");
  assert.deepEqual(misspelled.details?.unknown_params, ["nmae"]);
});

test("introspect describes the result types", () => {
  const all = buildIntrospection({ query: "types" }, "0.1.0");
  assert.deepEqual((all as { data: { types: typeof DISCORD_TYPES } }).data.types.map((t) => t.name), DISCORD_TYPES.map((t) => t.name));
  const one = buildIntrospection({ query: "types", name: "ReadMessagesResult" }, "0.1.0");
  assert.ok((one as { data: { type: { fields: string[] } } }).data.type.fields.includes("cursor"));
  assert.equal(failure(buildIntrospection({ query: "types", name: "Nope" }, "0.1.0")).code, "NOT_FOUND_RESOURCE");
  assert.equal(failure(buildIntrospection({ query: "everything" }, "0.1.0")).code, "VALIDATION_INVALID_TYPE");
  assert.equal(failure(buildIntrospection({}, "0.1.0")).code, "VALIDATION_INVALID_TYPE");
});
