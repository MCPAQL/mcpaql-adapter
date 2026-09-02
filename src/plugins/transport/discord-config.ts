/**
 * Configuration for the runnable Discord adapter: how the environment
 * reaches `BrowserCdpTransport`, and a startup probe that tells the user
 * exactly what to run when the port is closed.
 *
 * The origin is not configurable. The adapter attaches to `https://discord.com`
 * and nothing else; a different origin is a different adapter.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  CdpTransportError,
  DEFAULT_CDP_HOST,
  DEFAULT_CDP_PORT,
  DEFAULT_CDP_TIMEOUT_MS,
  discoverTargets,
  launchHint,
  originOf,
  type BrowserCdpConfig,
  type FetchLike,
} from "./browser-cdp.js";

/** The origin the transport is pinned to; nothing else is ever attached. */
export const DISCORD_ORIGIN = "https://discord.com";

/** Environment variables the adapter reads. Nothing else in the environment is consulted. */
export const DISCORD_ENV = {
  host: "MCPAQL_CDP_HOST",
  port: "MCPAQL_CDP_PORT",
  timeoutMs: "MCPAQL_CDP_TIMEOUT_MS",
} as const;

/** Only loopback hosts are accepted: a remote DevTools port would expose the user's session to that network. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1"]);
const TIMEOUT_MIN_MS = 1000;
const TIMEOUT_MAX_MS = 600_000;

export type DiscordConfig = Required<Pick<BrowserCdpConfig, "allowedOrigin" | "host" | "port" | "timeoutMs">>;

/** A configuration value the adapter refuses to start with. `variable` names the environment variable. */
export class DiscordConfigError extends Error {
  constructor(readonly variable: string, message: string) {
    super(message);
    this.name = "DiscordConfigError";
  }
}

/**
 * Read the transport settings from an environment. Unset variables take the
 * transport's defaults; a set variable must be valid, since a typo that
 * silently fell back to the default would connect somewhere the user did
 * not intend.
 */
export function resolveDiscordConfig(env: Readonly<Record<string, string | undefined>>): DiscordConfig {
  return {
    allowedOrigin: DISCORD_ORIGIN,
    host: readHost(env[DISCORD_ENV.host]),
    port: readInteger(DISCORD_ENV.port, env[DISCORD_ENV.port], DEFAULT_CDP_PORT, 1, 65_535),
    timeoutMs: readInteger(DISCORD_ENV.timeoutMs, env[DISCORD_ENV.timeoutMs], DEFAULT_CDP_TIMEOUT_MS, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS),
  };
}

function readHost(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CDP_HOST;
  const host = raw.trim();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new DiscordConfigError(
      DISCORD_ENV.host,
      `${DISCORD_ENV.host} must be a loopback host (${[...LOOPBACK_HOSTS].join(", ")}); got ${JSON.stringify(host)}. The adapter attaches only to a Chrome on this machine.`,
    );
  }
  return host;
}

function readInteger(variable: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new DiscordConfigError(variable, `${variable} must be an integer from ${min} to ${max}; got ${JSON.stringify(raw)}.`);
  }
  return value;
}

/** One line for a startup log: where the adapter will look, never a secret. */
export function describeDiscordConfig(config: DiscordConfig): string {
  return `Discord adapter (read-only): DevTools at http://${config.host}:${config.port}, origin ${config.allowedOrigin}, timeout ${config.timeoutMs}ms.`;
}

export type PortProbe =
  | { open: true; discordTabs: number }
  | { open: false; code: CdpTransportError["code"]; message: string; hint: string };

/**
 * Check the DevTools port once, at startup, so the user sees the launch
 * commands immediately rather than on the first call. Never throws: the
 * server starts either way and every later call reports the same named
 * error until Chrome is up.
 */
export async function probeDiscordPort(config: DiscordConfig, fetchImpl?: FetchLike): Promise<PortProbe> {
  const fetcher: FetchLike = fetchImpl ?? ((url) => fetch(url));
  try {
    const targets = await discoverTargets(config.host, config.port, fetcher, config.timeoutMs);
    const discordTabs = targets.filter((t) => t.type === "page" && originOf(t.url) === config.allowedOrigin).length;
    return { open: true, discordTabs };
  } catch (err) {
    const hint = launchHint(config.port);
    if (err instanceof CdpTransportError) return { open: false, code: err.code, message: err.message, hint };
    return { open: false, code: "TRANSPORT_CDP_PROTOCOL_ERROR", message: err instanceof Error ? err.message : String(err), hint };
  }
}
