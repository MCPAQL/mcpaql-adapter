#!/usr/bin/env node
/**
 * Entry point for the read-only Discord adapter over stdio.
 *
 *   MCPAQL_CDP_PORT=9222 npx tsx src/bin/discord.ts        (development)
 *   node dist/bin/discord.js                                (after `npm run build`)
 *
 * stdout is the MCP channel and carries nothing else; every human-readable
 * line goes to stderr. The DevTools port is probed once after the server
 * is up (so a client's `initialize` never waits on Chrome) and the exact
 * launch commands are printed when it is closed. Nothing here writes to
 * Discord: this is a faster copy-paste of a screen you already have open.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BrowserCdpTransport } from "../plugins/transport/browser-cdp.js";
import {
  DiscordConfigError,
  describeDiscordConfig,
  probeDiscordPort,
  resolveDiscordConfig,
} from "../plugins/transport/discord-config.js";
import { createDiscordServer } from "../servers/discord.js";

const log = (line: string): void => { process.stderr.write(`${line}\n`); };

function adapterVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)("../../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

let config;
try {
  config = resolveDiscordConfig(process.env);
} catch (err) {
  if (err instanceof DiscordConfigError) {
    log(`${err.code}: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
log(describeDiscordConfig(config));

const transport = new BrowserCdpTransport(config);
const server = createDiscordServer({
  deps: { evaluate: (expression, options) => transport.evaluate(expression, options) },
  version: adapterVersion(),
});

await server.connect(new StdioServerTransport());

void probeDiscordPort(config).then((probe) => {
  if (!probe.open) {
    log(`${probe.code}: ${probe.message}`);
    log(probe.hint);
    log("The adapter is serving; every call will return that error until Chrome is up.");
  } else if (probe.problem !== null) {
    log(`DevTools port is open (${probe.discordTabs} Discord tab(s)); ${probe.problem}`);
  } else {
    log(`DevTools port is open; ${probe.discordTabs} Discord tab(s) found. Ready.`);
  }
}, (err: unknown) => {
  log(`Startup probe failed: ${err instanceof Error ? err.message : String(err)}`);
});

const shutdown = (): void => {
  transport.close();
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);
