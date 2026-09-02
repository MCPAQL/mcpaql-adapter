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
  defaultFetch,
  devtoolsAuthority,
  discoverTargets,
  isLoopbackHost,
  launchHint,
  matchingPages,
  selectTarget,
  type FetchLike,
} from "./browser-cdp.js";

/** The origin the transport is pinned to; nothing else is ever attached. */
export const DISCORD_ORIGIN = "https://discord.com";

/**
 * Environment variables the adapter reads. Nothing else in the environment
 * is consulted. The names are the transport's, not Discord's: each adapter
 * runs as its own process with its own environment from the client config.
 */
export const DISCORD_ENV = {
  host: "MCPAQL_CDP_HOST",
  port: "MCPAQL_CDP_PORT",
  timeoutMs: "MCPAQL_CDP_TIMEOUT_MS",
} as const;

const TIMEOUT_MIN_MS = 1000;
const TIMEOUT_MAX_MS = 600_000;
/** The startup probe is bounded on its own: a client waits on `initialize`, and a black-holed port must not stall it. */
export const PROBE_TIMEOUT_MS = 3000;

/** The resolved transport settings. Assignable to `BrowserCdpConfig`. */
export interface DiscordConfig {
  allowedOrigin: string;
  host: string;
  port: number;
  timeoutMs: number;
}

/** A configuration value the adapter refuses to start with. `variable` names the environment variable. */
export class DiscordConfigError extends Error {
  readonly code = "CONFIG_INVALID_VALUE";
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
    host: readHost(readEnv(env, DISCORD_ENV.host)),
    port: readInteger(DISCORD_ENV.port, readEnv(env, DISCORD_ENV.port), DEFAULT_CDP_PORT, 1, 65_535),
    timeoutMs: readInteger(DISCORD_ENV.timeoutMs, readEnv(env, DISCORD_ENV.timeoutMs), DEFAULT_CDP_TIMEOUT_MS, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS),
  };
}

/** A trimmed value, or `undefined` when the variable is unset or blank. */
function readEnv(env: Readonly<Record<string, string | undefined>>, variable: string): string | undefined {
  const value = env[variable]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function readHost(value: string | undefined): string {
  if (value === undefined) return DEFAULT_CDP_HOST;
  if (!isLoopbackHost(value)) {
    throw new DiscordConfigError(
      DISCORD_ENV.host,
      `${DISCORD_ENV.host} must be a loopback host (127.0.0.1, localhost, or ::1); got ${JSON.stringify(value)}. The adapter attaches only to a Chrome on this machine.`,
    );
  }
  return value;
}

function readInteger(variable: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  // Decimal digits only: what the message promises, so "1e3" and "0x10" are refused like any other typo.
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new DiscordConfigError(variable, `${variable} must be an integer from ${min} to ${max}; got ${JSON.stringify(value)}.`);
  }
  return n;
}

/** One line for a startup log: where the adapter will look, never a secret. */
export function describeDiscordConfig(config: DiscordConfig): string {
  return `Discord adapter (read-only): DevTools at http://${devtoolsAuthority(config.host, config.port)}, origin ${config.allowedOrigin}, timeout ${config.timeoutMs}ms.`;
}

export type PortProbe =
  /**
   * The port answered. `discordTabs` counts page targets at the origin;
   * `problem` is null when the transport could attach to one of them right
   * now, otherwise the transport's own message (no Discord tab, or every
   * Discord tab already has a DevTools client attached).
   */
  | { open: true; discordTabs: number; problem: string | null }
  /** The port did not answer. `message` is the transport's text without the launch commands; `hint` is the commands. */
  | { open: false; code: CdpTransportError["code"]; message: string; hint: string };

/**
 * Check the DevTools port once, at startup, so the user sees the launch
 * commands immediately rather than on the first call. Bounded by
 * {@link PROBE_TIMEOUT_MS}. Never throws for a transport failure: the server
 * starts either way and every later call reports the same named error until
 * Chrome is up. The attach decision is the transport's own `selectTarget`,
 * so the probe cannot say "ready" for a tab `connect()` would refuse.
 */
export async function probeDiscordPort(config: DiscordConfig, fetchImpl: FetchLike = defaultFetch): Promise<PortProbe> {
  let targets;
  try {
    targets = await discoverTargets(config.host, config.port, fetchImpl, Math.min(config.timeoutMs, PROBE_TIMEOUT_MS));
  } catch (err) {
    if (!(err instanceof CdpTransportError)) throw err;
    const hint = launchHint(config.port);
    return { open: false, code: err.code, message: err.message.replace(hint, "").trim(), hint };
  }
  const discordTabs = matchingPages(targets, config.allowedOrigin).length;
  try {
    selectTarget(targets, config.allowedOrigin);
    return { open: true, discordTabs, problem: null };
  } catch (err) {
    if (!(err instanceof CdpTransportError)) throw err;
    return { open: true, discordTabs, problem: err.message };
  }
}
