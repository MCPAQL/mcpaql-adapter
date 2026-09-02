/**
 * Tests for the browser-session (CDP) transport plugin.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOWED_CDP_METHODS,
  BrowserCdpTransport,
  CdpTransportError,
  FORBIDDEN_CDP_PREFIXES,
  discoverTargets,
  launchHint,
  originOf,
  selectTarget,
  type CdpTarget,
  type FetchLike,
  type WebSocketLike,
} from "../src/plugins/transport/browser-cdp.js";

const ORIGIN = "https://discord.com";

// --- Fakes ---

type Listener = (event: unknown) => void;

/**
 * In-memory WebSocket double. `respond` decides what the "browser" answers
 * to each method; default answers make a logged-in Discord tab.
 */
class FakeSocket implements WebSocketLike {
  readonly sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  closed = false;
  private listeners = new Map<string, Listener[]>();
  respond: (msg: { id: number; method: string; params: Record<string, unknown> }) => unknown =
    (msg) => defaultRespond(msg, ORIGIN);
  autoOpen = true;
  autoError: unknown = undefined;

  constructor(readonly url: string) {}
  send(data: string): void {
    const msg = JSON.parse(data);
    this.sent.push(msg);
    const reply = this.respond(msg);
    if (reply === undefined) return; // caller controls timing
    queueMicrotask(() => this.emit("message", { data: JSON.stringify(reply) }));
  }
  close(): void { this.closed = true; }
  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
    if (type === "open" && this.autoOpen) queueMicrotask(() => listener(undefined));
    if (type === "error" && this.autoError !== undefined) queueMicrotask(() => listener(this.autoError));
  }
  emit(type: string, event: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
}

function defaultRespond(
  msg: { id: number; method: string; params: Record<string, unknown> },
  origin: string,
): unknown {
  if (msg.method === "Runtime.enable") return { id: msg.id, result: {} };
  if (msg.method === "Runtime.evaluate") {
    const expr = String(msg.params.expression);
    if (expr === "location.origin") return { id: msg.id, result: { result: { type: "string", value: origin } } };
    return { id: msg.id, result: { result: { type: "string", value: `evaluated:${expr}` } } };
  }
  return { id: msg.id, error: { code: -32601, message: "unknown method" } };
}

const discordTab: CdpTarget = {
  id: "T1",
  type: "page",
  url: "https://discord.com/channels/@me",
  title: "Discord",
  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/T1",
};

function fakeFetch(targets: unknown, ok = true, status = 200): FetchLike {
  return async () => ({ ok, status, json: async () => targets });
}

function make(options: { targets?: unknown; socket?: FakeSocket; timeoutMs?: number; fetchImpl?: FetchLike } = {}) {
  const socket = options.socket ?? new FakeSocket("");
  const transport = new BrowserCdpTransport(
    { allowedOrigin: ORIGIN, timeoutMs: options.timeoutMs ?? 200 },
    {
      fetchImpl: options.fetchImpl ?? fakeFetch(options.targets ?? [discordTab]),
      socketFactory: () => socket,
    },
  );
  return { transport, socket };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<CdpTransportError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof CdpTransportError, `expected CdpTransportError, got ${String(err)}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    assert.ok(err.message.length > 0, "message must never be empty");
    return err;
  }
  assert.fail(`expected rejection with ${code}`);
}

// --- Allowlist invariants (the read-only guarantee) ---

test("allowlist contains only Runtime evaluation methods", () => {
  assert.deepEqual([...ALLOWED_CDP_METHODS].sort(), ["Runtime.disable", "Runtime.enable", "Runtime.evaluate"]);
});

test("allowlist contains no forbidden (input, navigation, storage, target) methods", () => {
  for (const method of ALLOWED_CDP_METHODS) {
    for (const prefix of FORBIDDEN_CDP_PREFIXES) {
      assert.ok(!method.startsWith(prefix), `${method} matches forbidden prefix ${prefix}`);
    }
  }
});

test("forbidden prefixes cover input and navigation", () => {
  assert.ok(FORBIDDEN_CDP_PREFIXES.includes("Input."));
  assert.ok(FORBIDDEN_CDP_PREFIXES.includes("Page.navigate"));
});

test("send refuses any method outside the allowlist before touching the socket", async () => {
  const { transport, socket } = make();
  await transport.connect();
  const before = socket.sent.length;
  const internals = transport as unknown as { send(m: string, p: Record<string, unknown>): Promise<unknown> };
  const send = internals.send.bind(transport);
  await expectCode(send("Input.dispatchKeyEvent", { type: "keyDown" }), "TRANSPORT_CDP_METHOD_DENIED");
  await expectCode(send("Page.navigate", { url: "https://evil.example" }), "TRANSPORT_CDP_METHOD_DENIED");
  assert.equal(socket.sent.length, before, "denied methods must not be serialized");
});

test("evaluate never requests a user gesture", async () => {
  const { transport, socket } = make();
  await transport.evaluate("1+1");
  const evals = socket.sent.filter((m) => m.method === "Runtime.evaluate" && m.params.expression === "1+1");
  assert.equal(evals.length, 1);
  assert.equal(evals[0].params.userGesture, false);
  assert.equal(evals[0].params.returnByValue, true);
});

// --- Helpers ---

test("launchHint names the port and the flag", () => {
  const hint = launchHint(9333);
  assert.match(hint, /--remote-debugging-port=9333/);
  assert.match(hint, /macOS/);
});

test("originOf returns origin or null", () => {
  assert.equal(originOf("https://discord.com/channels/@me?x=1"), "https://discord.com");
  assert.equal(originOf("not a url"), null);
});

// --- Target selection ---

test("selectTarget picks the page on the allowed origin", () => {
  const other: CdpTarget = { id: "T0", type: "page", url: "https://example.com/", webSocketDebuggerUrl: "ws://x" };
  assert.equal(selectTarget([other, discordTab], ORIGIN).id, "T1");
});

test("selectTarget ignores non-page targets even on the allowed origin", () => {
  const worker: CdpTarget = { id: "W", type: "service_worker", url: "https://discord.com/sw.js", webSocketDebuggerUrl: "ws://w" };
  assert.throws(() => selectTarget([worker], ORIGIN), (e: unknown) => (e as CdpTransportError).code === "TRANSPORT_CDP_NO_TARGET");
});

test("selectTarget refuses other origins and lists what is open", () => {
  const other: CdpTarget = { id: "T0", type: "page", url: "https://example.com/", webSocketDebuggerUrl: "ws://x" };
  assert.throws(
    () => selectTarget([other], ORIGIN),
    (e: unknown) => (e as CdpTransportError).code === "TRANSPORT_CDP_ORIGIN_REFUSED" && /example\.com/.test((e as CdpTransportError).message),
  );
});

test("selectTarget refuses a lookalike origin", () => {
  const lookalike: CdpTarget = { id: "T9", type: "page", url: "https://discord.com.evil.example/", webSocketDebuggerUrl: "ws://x" };
  assert.throws(() => selectTarget([lookalike], ORIGIN), (e: unknown) => (e as CdpTransportError).code === "TRANSPORT_CDP_ORIGIN_REFUSED");
});

test("selectTarget errors when the matching tab has no debugger URL", () => {
  const busy: CdpTarget = { ...discordTab, webSocketDebuggerUrl: undefined };
  assert.throws(() => selectTarget([busy], ORIGIN), (e: unknown) => (e as CdpTransportError).code === "TRANSPORT_CDP_NO_TARGET" && /DevTools/.test((e as CdpTransportError).message));
});

// --- Discovery ---

test("discoverTargets: connection refused becomes PORT_CLOSED with launch hint", async () => {
  const refusing: FetchLike = async () => { throw new Error("ECONNREFUSED"); };
  const err = await expectCode(discoverTargets("127.0.0.1", 9222, refusing, 200), "TRANSPORT_CDP_PORT_CLOSED");
  assert.match(err.message, /--remote-debugging-port=9222/);
});

test("discoverTargets: non-OK HTTP becomes PROTOCOL_ERROR", async () => {
  await expectCode(discoverTargets("h", 1, fakeFetch([], false, 500), 200), "TRANSPORT_CDP_PROTOCOL_ERROR");
});

test("discoverTargets: non-array body becomes PROTOCOL_ERROR", async () => {
  await expectCode(discoverTargets("h", 1, fakeFetch({ nope: true }), 200), "TRANSPORT_CDP_PROTOCOL_ERROR");
});

test("discoverTargets: drops malformed entries", async () => {
  const targets = await discoverTargets("h", 1, fakeFetch([discordTab, { junk: 1 }, null]), 200);
  assert.deepEqual(targets.map((t) => t.id), ["T1"]);
});

test("discoverTargets: hung endpoint times out", async () => {
  const hung: FetchLike = () => new Promise(() => {});
  await expectCode(discoverTargets("h", 1, hung, 30), "TRANSPORT_CDP_TIMEOUT");
});

// --- Constructor ---

test("constructor rejects a non-origin allowedOrigin", () => {
  assert.throws(
    () => new BrowserCdpTransport({ allowedOrigin: "https://discord.com/channels" }),
    (e: unknown) => (e as CdpTransportError).code === "TRANSPORT_CDP_ORIGIN_REFUSED",
  );
  assert.throws(() => new BrowserCdpTransport({ allowedOrigin: "discord.com" }), (e: unknown) => (e as CdpTransportError).code === "TRANSPORT_CDP_ORIGIN_REFUSED");
});

// --- Connect / evaluate lifecycle ---

test("connect discovers, attaches, enables Runtime, and is idempotent", async () => {
  const { transport, socket } = make();
  const target = await transport.connect();
  assert.equal(target.id, "T1");
  assert.equal(transport.attachedTarget?.id, "T1");
  assert.deepEqual(socket.sent.map((m) => m.method), ["Runtime.enable"]);
  await transport.connect();
  assert.equal(socket.sent.length, 1, "second connect must not re-attach");
});

test("connect surfaces a socket error as DISCONNECTED", async () => {
  const socket = new FakeSocket("");
  socket.autoOpen = false;
  socket.autoError = new Error("refused");
  const { transport } = make({ socket });
  await expectCode(transport.connect(), "TRANSPORT_CDP_DISCONNECTED");
});

test("connect times out when the socket never opens", async () => {
  const socket = new FakeSocket("");
  socket.autoOpen = false;
  const { transport } = make({ socket, timeoutMs: 30 });
  await expectCode(transport.connect(), "TRANSPORT_CDP_TIMEOUT");
});

test("evaluate returns the page value", async () => {
  const { transport } = make();
  assert.equal(await transport.evaluate("document.title"), "evaluated:document.title");
});

test("evaluate rejects an empty expression without touching the socket", async () => {
  const { transport, socket } = make();
  await expectCode(transport.evaluate("   "), "TRANSPORT_CDP_EVALUATE_ERROR");
  assert.equal(socket.sent.length, 0);
});

test("evaluate re-checks origin before every call and closes on drift", async () => {
  const { transport, socket } = make();
  await transport.evaluate("1");
  socket.respond = (msg) => defaultRespond(msg, "https://evil.example");
  await expectCode(transport.evaluate("2"), "TRANSPORT_CDP_ORIGIN_REFUSED");
  assert.equal(socket.closed, true, "session must close when the tab leaves the origin");
  assert.equal(transport.attachedTarget, null);
});

test("evaluate surfaces page exceptions as EVALUATE_ERROR", async () => {
  const { transport, socket } = make();
  socket.respond = (msg) => {
    if (msg.method === "Runtime.evaluate" && msg.params.expression === "boom()") {
      return { id: msg.id, result: { exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: boom is not defined" } } } };
    }
    return defaultRespond(msg, ORIGIN);
  };
  const err = await expectCode(transport.evaluate("boom()"), "TRANSPORT_CDP_EVALUATE_ERROR");
  assert.match(err.message, /ReferenceError/);
});

test("evaluate enforces the result size cap", async () => {
  const socket = new FakeSocket("");
  socket.respond = (msg) => {
    if (msg.method === "Runtime.evaluate" && msg.params.expression === "big") {
      return { id: msg.id, result: { result: { type: "string", value: "x".repeat(2000) } } };
    }
    return defaultRespond(msg, ORIGIN);
  };
  const transport = new BrowserCdpTransport(
    { allowedOrigin: ORIGIN, timeoutMs: 200, maxResultBytes: 1000 },
    { fetchImpl: fakeFetch([discordTab]), socketFactory: () => socket },
  );
  await expectCode(transport.evaluate("big"), "TRANSPORT_CDP_RESULT_TOO_LARGE");
});

test("evaluate surfaces DevTools error responses as PROTOCOL_ERROR", async () => {
  const { transport, socket } = make();
  socket.respond = (msg) => {
    if (msg.method === "Runtime.evaluate" && msg.params.expression === "x") {
      return { id: msg.id, error: { code: -32000, message: "Context destroyed" } };
    }
    return defaultRespond(msg, ORIGIN);
  };
  const err = await expectCode(transport.evaluate("x"), "TRANSPORT_CDP_PROTOCOL_ERROR");
  assert.match(err.message, /Context destroyed/);
});

test("evaluate times out when the page never answers", async () => {
  const { transport, socket } = make({ timeoutMs: 30 });
  socket.respond = (msg) => {
    if (msg.method === "Runtime.evaluate" && msg.params.expression === "hang") return undefined;
    return defaultRespond(msg, ORIGIN);
  };
  await expectCode(transport.evaluate("hang"), "TRANSPORT_CDP_TIMEOUT");
});

test("per-call timeout override is honored", async () => {
  const { transport, socket } = make({ timeoutMs: 5000 });
  socket.respond = (msg) => {
    if (msg.method === "Runtime.evaluate" && msg.params.expression === "hang") return undefined;
    return defaultRespond(msg, ORIGIN);
  };
  const started = Date.now();
  await expectCode(transport.evaluate("hang", { timeoutMs: 20 }), "TRANSPORT_CDP_TIMEOUT");
  assert.ok(Date.now() - started < 1000);
});

test("close rejects pending calls and is idempotent", async () => {
  const { transport, socket } = make({ timeoutMs: 5000 });
  socket.respond = (msg) => {
    if (msg.method === "Runtime.evaluate" && msg.params.expression === "hang") return undefined;
    return defaultRespond(msg, ORIGIN);
  };
  const pending = transport.evaluate("hang");
  await new Promise((r) => setTimeout(r, 5));
  transport.close();
  transport.close();
  await expectCode(pending, "TRANSPORT_CDP_DISCONNECTED");
  assert.equal(socket.closed, true);
});

test("browser-side close rejects pending calls", async () => {
  const { transport, socket } = make({ timeoutMs: 5000 });
  socket.respond = (msg) => {
    if (msg.method === "Runtime.evaluate" && msg.params.expression === "hang") return undefined;
    return defaultRespond(msg, ORIGIN);
  };
  const pending = transport.evaluate("hang");
  await new Promise((r) => setTimeout(r, 5));
  socket.emit("close", undefined);
  const err = await expectCode(pending, "TRANSPORT_CDP_DISCONNECTED");
  assert.match(err.message, /tab closed or Chrome quit/);
});

test("after a browser-side close, connect re-attaches", async () => {
  let created = 0;
  const transport = new BrowserCdpTransport(
    { allowedOrigin: ORIGIN, timeoutMs: 200 },
    { fetchImpl: fakeFetch([discordTab]), socketFactory: () => { created++; return new FakeSocket(""); } },
  );
  await transport.connect();
  // Simulate the browser dropping us: reach the socket through the factory count.
  (transport as unknown as { onClose(): void }).onClose();
  await transport.connect();
  assert.equal(created, 2);
});

test("unsolicited events and non-JSON frames are ignored", async () => {
  const { transport, socket } = make();
  await transport.connect();
  socket.emit("message", { data: JSON.stringify({ method: "Runtime.consoleAPICalled", params: {} }) });
  socket.emit("message", { data: "not json" });
  socket.emit("message", { data: JSON.stringify({ id: 999, result: {} }) });
  assert.equal(await transport.evaluate("ok"), "evaluated:ok");
});
