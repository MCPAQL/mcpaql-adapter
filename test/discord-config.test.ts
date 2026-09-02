/**
 * Tests for the Discord adapter configuration: environment to transport
 * settings, and the startup port probe.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import { DEFAULT_CDP_HOST, DEFAULT_CDP_PORT, DEFAULT_CDP_TIMEOUT_MS, DEFAULT_CHROME_PROFILE_DIR, launchHint, type CdpTarget, type FetchLike } from "../src/plugins/transport/browser-cdp.js";
import {
  DISCORD_ENV,
  DISCORD_ORIGIN,
  DiscordConfigError,
  PROBE_TIMEOUT_MS,
  describeDiscordConfig,
  probeDiscordPort,
  resolveDiscordConfig,
} from "../src/plugins/transport/discord-config.js";

function refused(env: Record<string, string | undefined>): DiscordConfigError {
  try {
    resolveDiscordConfig(env);
  } catch (err) {
    assert.ok(err instanceof DiscordConfigError, `expected DiscordConfigError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected the configuration to be refused");
}

test("an empty environment yields the transport defaults pinned to discord.com", () => {
  assert.deepEqual(resolveDiscordConfig({}), {
    allowedOrigin: DISCORD_ORIGIN,
    host: DEFAULT_CDP_HOST,
    port: DEFAULT_CDP_PORT,
    timeoutMs: DEFAULT_CDP_TIMEOUT_MS,
  });
});

test("blank values count as unset; set values are read and trimmed", () => {
  assert.equal(resolveDiscordConfig({ [DISCORD_ENV.port]: "  " }).port, DEFAULT_CDP_PORT);
  const c = resolveDiscordConfig({ [DISCORD_ENV.port]: " 9333 ", [DISCORD_ENV.host]: "localhost ", [DISCORD_ENV.timeoutMs]: "2500" });
  assert.equal(c.port, 9333);
  assert.equal(c.host, "localhost");
  assert.equal(c.timeoutMs, 2500);
});

test("a set but invalid value is refused by name rather than falling back", () => {
  for (const [env, variable] of [
    [{ [DISCORD_ENV.port]: "nine" }, DISCORD_ENV.port],
    [{ [DISCORD_ENV.port]: "0" }, DISCORD_ENV.port],
    [{ [DISCORD_ENV.port]: "70000" }, DISCORD_ENV.port],
    [{ [DISCORD_ENV.port]: "92.22" }, DISCORD_ENV.port],
    [{ [DISCORD_ENV.port]: "1e3" }, DISCORD_ENV.port],
    [{ [DISCORD_ENV.port]: "0x2400" }, DISCORD_ENV.port],
    [{ [DISCORD_ENV.port]: "+9222" }, DISCORD_ENV.port],
    [{ [DISCORD_ENV.timeoutMs]: "10" }, DISCORD_ENV.timeoutMs],
    [{ [DISCORD_ENV.timeoutMs]: "-1" }, DISCORD_ENV.timeoutMs],
  ] as const) {
    const err = refused(env);
    assert.equal(err.variable, variable);
    assert.ok(err.message.startsWith(variable), err.message);
  }
});

test("only loopback hosts are accepted: a remote DevTools port would expose the session", () => {
  for (const host of ["127.0.0.1", "localhost", "::1"]) assert.equal(resolveDiscordConfig({ [DISCORD_ENV.host]: host }).host, host);
  for (const host of ["0.0.0.0", "10.0.0.5", "chrome.example.com", "127.0.0.1:9222"]) {
    const err = refused({ [DISCORD_ENV.host]: host });
    assert.equal(err.variable, DISCORD_ENV.host);
    assert.match(err.message, /loopback/);
  }
});

test("a refused value carries a code and the variable name", () => {
  const err = refused({ [DISCORD_ENV.port]: "x" });
  assert.equal(err.code, "CONFIG_INVALID_VALUE");
  assert.equal(err.name, "DiscordConfigError");
});

test("the guide's launch commands are the ones the launch hint prints", () => {
  const guide = readFileSync(new URL("../docs/guides/discord-adapter.md", import.meta.url), "utf8");
  const hint = launchHint();
  for (const command of [`open -n -a "Google Chrome" --args --remote-debugging-port=${DEFAULT_CDP_PORT} --user-data-dir="${DEFAULT_CHROME_PROFILE_DIR}"`, `google-chrome --remote-debugging-port=${DEFAULT_CDP_PORT} --user-data-dir="${DEFAULT_CHROME_PROFILE_DIR}"`]) {
    assert.ok(guide.includes(command), `guide has: ${command}`);
    assert.ok(hint.includes(command), `hint has: ${command}`);
  }
});

test("describeDiscordConfig names where the adapter will look", () => {
  const line = describeDiscordConfig(resolveDiscordConfig({ [DISCORD_ENV.port]: "9333" }));
  assert.match(line, /read-only/);
  assert.match(line, /http:\/\/127\.0\.0\.1:9333/);
  assert.match(describeDiscordConfig(resolveDiscordConfig({ [DISCORD_ENV.host]: "::1" })), /http:\/\/\[::1\]:9222/);
  assert.match(line, /https:\/\/discord\.com/);
});

const tab = (url: string, type = "page"): CdpTarget => ({ id: url, type, url, webSocketDebuggerUrl: `ws://x/${url}` });
const fetchWith = (targets: unknown): FetchLike => async () => ({ ok: true, status: 200, json: async () => targets });

test("probeDiscordPort counts Discord tabs when the port is open", async () => {
  const probe = await probeDiscordPort(resolveDiscordConfig({}), fetchWith([
    tab("https://discord.com/channels/@me"),
    tab("https://discord.com/channels/1/2"),
    tab("https://discord.com.evil.example/"),
    tab("https://example.com/"),
    tab("https://discord.com/worker", "service_worker"),
    { ...tab("https://discord.com/channels/3/4"), webSocketDebuggerUrl: undefined }, // DevTools already attached
  ]));
  assert.deepEqual(probe, { open: true, discordTabs: 3, problem: null });
});

test("probeDiscordPort reports the transport's own reason when the port is open but nothing is attachable", async () => {
  const none = await probeDiscordPort(resolveDiscordConfig({}), fetchWith([tab("https://example.com/")]));
  assert.equal(none.open, true);
  if (!none.open) return;
  assert.equal(none.discordTabs, 0);
  assert.match(none.problem ?? "", /No tab at https:\/\/discord\.com/);
  const busy = await probeDiscordPort(resolveDiscordConfig({}), fetchWith([{ ...tab("https://discord.com/channels/@me"), webSocketDebuggerUrl: "" }]));
  assert.equal(busy.open, true);
  if (!busy.open) return;
  assert.equal(busy.discordTabs, 1);
  assert.match(busy.problem ?? "", /another DevTools client is attached/);
  assert.deepEqual(await probeDiscordPort(resolveDiscordConfig({}), fetchWith([])), { open: true, discordTabs: 0, problem: "No open tabs found. Open https://discord.com in the debug-enabled Chrome and retry." });
});

test("probeDiscordPort reports a closed port with both launch commands and never throws", async () => {
  const config = resolveDiscordConfig({ [DISCORD_ENV.port]: "9333" });
  const probe = await probeDiscordPort(config, async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:9333"); });
  assert.equal(probe.open, false);
  if (probe.open) return;
  assert.equal(probe.code, "TRANSPORT_CDP_PORT_CLOSED");
  assert.match(probe.message, /ECONNREFUSED/);
  assert.equal(probe.hint, launchHint(9333));
  assert.ok(!probe.message.includes("--remote-debugging-port"), "the commands appear once, in hint, not again in message");
  assert.match(probe.hint, /--remote-debugging-port=9333 --user-data-dir=/);
  assert.match(probe.hint, /macOS:/);
  assert.match(probe.hint, /Linux:/);
});

test("an IPv6 loopback host is bracketed in the discovery URL, so it can actually be reached", async () => {
  const urls: string[] = [];
  const probe = await probeDiscordPort(resolveDiscordConfig({ [DISCORD_ENV.host]: "::1", [DISCORD_ENV.port]: "9333" }), async (url) => {
    urls.push(url);
    new URL(url); // must parse
    return { ok: true, status: 200, json: async () => [] };
  });
  assert.deepEqual(urls, ["http://[::1]:9333/json/list"]);
  assert.equal(probe.open, true);
});

test("the probe is bounded by its own short timeout, never the full transport timeout", async () => {
  const config = resolveDiscordConfig({ [DISCORD_ENV.timeoutMs]: "600000" });
  const started = Date.now();
  const probe = await probeDiscordPort(config, () => new Promise(() => {})); // black hole
  assert.equal(probe.open, false);
  if (probe.open) return;
  assert.equal(probe.code, "TRANSPORT_CDP_TIMEOUT");
  assert.ok(Date.now() - started < PROBE_TIMEOUT_MS + 1000);
});

test("probeDiscordPort names a non-DevTools answer as a protocol error", async () => {
  const probe = await probeDiscordPort(resolveDiscordConfig({}), async () => ({ ok: false, status: 404, json: async () => null }));
  assert.equal(probe.open, false);
  if (probe.open) return;
  assert.equal(probe.code, "TRANSPORT_CDP_PROTOCOL_ERROR");
  assert.match(probe.message, /HTTP 404/);
});
