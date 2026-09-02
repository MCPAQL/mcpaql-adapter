/**
 * Tests for the Discord adapter configuration: environment to transport
 * settings, and the startup port probe.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CDP_HOST, DEFAULT_CDP_PORT, DEFAULT_CDP_TIMEOUT_MS, launchHint, type CdpTarget, type FetchLike } from "../src/plugins/transport/browser-cdp.js";
import {
  DISCORD_ENV,
  DISCORD_ORIGIN,
  DiscordConfigError,
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
  assert.equal(DISCORD_ORIGIN, "https://discord.com");
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

test("the environment variable names are the documented ones", () => {
  assert.deepEqual(DISCORD_ENV, { host: "MCPAQL_CDP_HOST", port: "MCPAQL_CDP_PORT", timeoutMs: "MCPAQL_CDP_TIMEOUT_MS" });
});

test("describeDiscordConfig names where the adapter will look", () => {
  const line = describeDiscordConfig(resolveDiscordConfig({ [DISCORD_ENV.port]: "9333" }));
  assert.match(line, /read-only/);
  assert.match(line, /http:\/\/127\.0\.0\.1:9333/);
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
  ]));
  assert.deepEqual(probe, { open: true, discordTabs: 2 });
  assert.deepEqual(await probeDiscordPort(resolveDiscordConfig({}), fetchWith([])), { open: true, discordTabs: 0 });
});

test("probeDiscordPort reports a closed port with both launch commands and never throws", async () => {
  const config = resolveDiscordConfig({ [DISCORD_ENV.port]: "9333" });
  const probe = await probeDiscordPort(config, async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:9333"); });
  assert.equal(probe.open, false);
  if (probe.open) return;
  assert.equal(probe.code, "TRANSPORT_CDP_PORT_CLOSED");
  assert.match(probe.message, /ECONNREFUSED/);
  assert.equal(probe.hint, launchHint(9333));
  assert.match(probe.hint, /--remote-debugging-port=9333 --user-data-dir=/);
  assert.match(probe.hint, /macOS:/);
  assert.match(probe.hint, /Linux:/);
});

test("probeDiscordPort names a non-DevTools answer as a protocol error", async () => {
  const probe = await probeDiscordPort(resolveDiscordConfig({}), async () => ({ ok: false, status: 404, json: async () => null }));
  assert.equal(probe.open, false);
  if (probe.open) return;
  assert.equal(probe.code, "TRANSPORT_CDP_PROTOCOL_ERROR");
  assert.match(probe.message, /HTTP 404/);
});
