/**
 * Tests for the runnable Discord adapter: the MCP server over an in-memory
 * transport, the closed-port path through the real CDP transport, and the
 * stdio entry point as a child process.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { BrowserCdpTransport, launchHint } from "../src/plugins/transport/browser-cdp.js";
import { buildListExpression } from "../src/plugins/transport/discord-nav.js";
import { DISCORD_TOOL_NAME, type OperationResult } from "../src/plugins/transport/discord-operations.js";
import { DISCORD_ADAPTER_NAME, createDiscordServer, createQueue } from "../src/servers/discord.js";

const CH = "1520443442982031486";

async function connected(evaluate: (expression: string) => Promise<unknown>) {
  const server = createDiscordServer({ deps: { evaluate, sleep: async () => {} }, version: "9.9.9" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientSide);
  return { client, server, close: async () => { await client.close(); await server.close(); } };
}

function envelope(result: unknown): OperationResult {
  const r = result as CallToolResult;
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].type, "text");
  return JSON.parse((r.content[0] as { text: string }).text) as OperationResult;
}

test("the server reports its name and serves exactly one read-only tool", async () => {
  const c = await connected(async () => ({ items: [], count: 0, truncated: false, problem: null }));
  try {
    assert.equal(c.client.getServerVersion()?.name, DISCORD_ADAPTER_NAME);
    assert.equal(c.client.getServerVersion()?.version, "9.9.9");
    const { tools } = await c.client.listTools();
    assert.equal(tools.length, 1);
    const tool = tools[0];
    assert.equal(tool.name, DISCORD_TOOL_NAME);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.match(tool.description ?? "", /introspect, list_dms, list_guilds, list_channels, read_messages/);
    assert.match(tool.description ?? "", /never sends/);
    assert.deepEqual(tool.inputSchema.required, ["operation"]);
  } finally {
    await c.close();
  }
});

test("introspect answers through the tool with the server's version", async () => {
  const c = await connected(async () => null);
  try {
    const result = envelope(await c.client.callTool({ name: DISCORD_TOOL_NAME, arguments: { operation: "introspect", params: { query: "operations" } } }));
    assert.equal(result.success, true);
    const data = (result as { data: { _protocol: { version: string }; operations: Array<{ name: string }> } }).data;
    assert.equal(data._protocol.version, "9.9.9");
    assert.ok(data.operations.some((o) => o.name === "read_messages"));
  } finally {
    await c.close();
  }
});

test("a listing call reaches evaluate with the registered expression and returns the envelope", async () => {
  const evaluated: string[] = [];
  const c = await connected(async (e) => { evaluated.push(e); return { items: [{ id: CH, name: "A" }], count: 1, truncated: false, problem: null }; });
  try {
    const nested = envelope(await c.client.callTool({ name: DISCORD_TOOL_NAME, arguments: { operation: "list_dms", params: { limit: 4 } } }));
    assert.equal(nested.success, true);
    assert.deepEqual(evaluated, [buildListExpression("listDms", { limit: 4 })]);
    const flat = envelope(await c.client.callTool({ name: DISCORD_TOOL_NAME, arguments: { operation: "list_guilds", limit: 2 } }));
    assert.equal(flat.success, true);
    assert.equal(evaluated[1], buildListExpression("listGuilds", { limit: 2 }));
  } finally {
    await c.close();
  }
});

test("failures are envelopes, never MCP errors: unknown operation, bad parameter, wrong tool", async () => {
  const c = await connected(async () => null);
  try {
    const unknown = envelope(await c.client.callTool({ name: DISCORD_TOOL_NAME, arguments: { operation: "send_message", params: { content: "hi" } } }));
    assert.equal(unknown.success, false);
    if (!unknown.success) assert.equal(unknown.error.code, "NOT_FOUND_OPERATION");
    const bad = envelope(await c.client.callTool({ name: DISCORD_TOOL_NAME, arguments: { operation: "read_messages", params: { channel_id: "general" } } }));
    assert.equal(bad.success, false);
    if (!bad.success) assert.equal(bad.error.code, "VALIDATION_INVALID_TYPE");
    const wrongTool = envelope(await c.client.callTool({ name: "mcp_aql_create", arguments: { operation: "list_dms" } }));
    assert.equal(wrongTool.success, false);
    if (!wrongTool.success) assert.match(wrongTool.error.message, /every Discord operation is a read on mcp_aql_read/);
  } finally {
    await c.close();
  }
});

test("operations run one at a time in arrival order, so two reads never fight over the tab", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const order: string[] = [];
  const c = await connected(async (e) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    order.push(/listDms/.test(e) ? "dms" : "guilds");
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return { items: [], count: 0, truncated: false, problem: null };
  });
  try {
    const results = await Promise.all([
      c.client.callTool({ name: DISCORD_TOOL_NAME, arguments: { operation: "list_dms" } }),
      c.client.callTool({ name: DISCORD_TOOL_NAME, arguments: { operation: "list_guilds" } }),
      c.client.callTool({ name: DISCORD_TOOL_NAME, arguments: { operation: "list_dms" } }),
    ]);
    assert.equal(results.length, 3);
    assert.equal(maxInFlight, 1);
    assert.deepEqual(order, ["dms", "guilds", "dms"]);
  } finally {
    await c.close();
  }
});

test("createQueue keeps going after a rejected task", async () => {
  const queue = createQueue();
  await assert.rejects(queue(async () => { throw new Error("first"); }), /first/);
  assert.equal(await queue(async () => "second"), "second");
});

test("a closed port through the real transport is TRANSPORT_CDP_PORT_CLOSED with the launch hint, not a hang", async () => {
  const transport = new BrowserCdpTransport(
    { allowedOrigin: "https://discord.com", port: 9333, timeoutMs: 2000 },
    { fetchImpl: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:9333"); } },
  );
  const c = await connected((e) => transport.evaluate(e));
  try {
    const result = envelope(await c.client.callTool({ name: DISCORD_TOOL_NAME, arguments: { operation: "list_dms" } }));
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.error.code, "TRANSPORT_CDP_PORT_CLOSED");
    assert.ok(result.error.message.includes(launchHint(9333)));
    assert.deepEqual(result.error.details, { host: "127.0.0.1", port: 9333 });
  } finally {
    transport.close();
    await c.close();
  }
});

// --- The stdio entry point as a child process ---

const BIN = fileURLToPath(new URL("../src/bin/discord.ts", import.meta.url));

function runBin(env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", BIN], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
  return { child, stderr: () => stderr, stdout: () => stdout };
}

test("the entry point refuses an invalid environment by name and exits 2", async () => {
  const run = runBin({ MCPAQL_CDP_PORT: "nine" });
  const [code] = (await once(run.child, "exit")) as [number | null];
  assert.equal(code, 2);
  assert.match(run.stderr(), /CONFIG_INVALID_VALUE: MCPAQL_CDP_PORT must be an integer/);
  assert.equal(run.stdout(), "", "stdout is the MCP channel and carries nothing else");
});

test("the entry point serves over stdio with a closed port: tools/list answers and stderr carries the launch commands", { timeout: 30_000 }, async () => {
  const port = String(40_000 + Math.floor(Math.random() * 20_000));
  const run = runBin({ MCPAQL_CDP_PORT: port, MCPAQL_CDP_TIMEOUT_MS: "1500" });
  const send = (msg: object): void => { run.child.stdin.write(`${JSON.stringify(msg)}\n`); };
  const lines: string[] = [];
  let buffer = "";
  run.child.stdout.on("data", (d: Buffer) => {
    buffer += d.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) { lines.push(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); }
  });
  const waitFor = (id: number): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no response ${id}; stderr: ${run.stderr()}`)), 20_000);
    const poll = (): void => {
      const hit = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).find((m) => m?.id === id);
      if (hit) { clearTimeout(timer); resolve(hit); } else setTimeout(poll, 25);
    };
    poll();
  });
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    const init = await waitFor(1);
    assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, DISCORD_ADAPTER_NAME);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await waitFor(2);
    assert.equal((list.result as { tools: Array<{ name: string }> }).tools[0].name, DISCORD_TOOL_NAME);
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: DISCORD_TOOL_NAME, arguments: { operation: "list_dms" } } });
    const call = await waitFor(3);
    const result = JSON.parse((call.result as { content: Array<{ text: string }> }).content[0].text) as OperationResult;
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "TRANSPORT_CDP_PORT_CLOSED");
    // The startup probe wrote the commands to stderr, once.
    const deadline = Date.now() + 5000;
    while (!/TRANSPORT_CDP_PORT_CLOSED/.test(run.stderr()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const err = run.stderr();
    assert.match(err, /Discord adapter \(read-only\): DevTools at http:\/\/127\.0\.0\.1:/);
    assert.match(err, /TRANSPORT_CDP_PORT_CLOSED/);
    assert.equal((err.match(/--remote-debugging-port=/g) ?? []).length, 2, "macOS and Linux commands, once each");
    assert.match(err, /every call will return that error until Chrome is up/);
  } finally {
    run.child.kill("SIGTERM");
    await once(run.child, "exit");
  }
});
