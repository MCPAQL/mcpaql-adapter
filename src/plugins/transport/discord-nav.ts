/**
 * Discord listing and navigation for the read-only Discord adapter.
 *
 * Three in-page listing functions (`listDms`, `listGuilds`, `listChannels`)
 * read the sidebars of the Discord web client, and one Node-side helper
 * (`openChannel`) drives navigation through a transport's `evaluate`.
 *
 * Same discipline as discord-dom.ts: the in-page functions use only the
 * narrow `DomRoot`/`DomNode` surface, are unit-tested against the fake DOM,
 * and ship to the browser as their own source text. Their one shared helper,
 * `plainText`, is inlined ahead of them by the expression builder. Every
 * selector lives in {@link DISCORD_NAV_SELECTORS}.
 *
 * Navigation is same-origin by construction: `openChannel` only ever
 * assigns a path built from validated snowflake ids, never a caller URL.
 *
 * The only side effect anywhere in this module is the one clicking has:
 * opening a channel marks it read in Discord.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { DomNode, DomRoot } from "./discord-dom.js";

/** Selectors observed on discord.com, verified 2026-09-02. */
export const DISCORD_NAV_SELECTORS = {
  /** Server rail; items are tree items with id `guildsnav___<guildId>`. */
  guildRail: '[data-list-id="guildsnav"]',
  guildItem: '[data-list-item-id^="guildsnav___"][role="treeitem"]',
  /** Visually hidden label carrying the server name, sometimes prefixed with an unread status. */
  guildLabel: "span",
  /** DM sidebar; real conversations link to `/channels/@me/<channelId>`. */
  dmList: '[data-list-id^="private-channels"]',
  dmItem: 'li[role="listitem"]',
  dmLink: 'a[href^="/channels/@me/"]',
  dmName: '[class*="name"]',
  dmUnread: '[class*="numberBadge"], [class*="unread"]',
  /** Channel sidebar entries; channels are links, categories are expandable headers. */
  channelEntry: '[data-list-item-id^="channels___"]',
  channelLink: "a[href]",
  /** Server name shown in the channel sidebar header. */
  guildHeader: "header h1",
  /** The mounted message list, used to detect that a channel has opened. */
  messageList: 'ol[data-list-id="chat-messages"]',
  /** Markers (not selectors). */
  guildIdPrefix: "guildsnav___",
  guildHomeId: "guildsnav___home",
  channelIdPrefix: "channels___",
  dmHrefPrefix: "/channels/@me/",
  /** Unread-status prefixes Discord prepends to the hidden guild label. */
  guildLabelPrefix: /^(?:\d+ )?unread(?: mentions?)?,\s*/i,
} as const;

export type DiscordNavSelectors = typeof DISCORD_NAV_SELECTORS;

export interface DiscordDm {
  id: string;
  name: string;
  /** Text inside the parentheses of the link label, e.g. "direct message" or "group message". */
  kind: string | null;
  /** Presence text after the kind, when Discord shows one, e.g. "Online". */
  status: string | null;
  unread: boolean;
}

export interface DiscordGuild {
  id: string;
  name: string;
  /** The raw hidden label, in case the unread prefix was not recognized. */
  raw_label: string;
}

export interface DiscordChannel {
  id: string;
  name: string;
  /** Text inside the parentheses of the entry label, e.g. "text channel", "voice channel". */
  kind: string | null;
  /** Name of the enclosing category, when any. */
  category: string | null;
  href: string;
}

export interface ListResult<T> {
  items: T[];
  count: number;
  truncated: boolean;
  problem: string | null;
}

export interface ListChannelsResult extends ListResult<DiscordChannel> {
  guild: { id: string | null; name: string | null };
}

/** Options with defaults applied; the only shape the in-page functions accept. */
export interface ResolvedListOptions {
  limit: number;
}

export const DEFAULT_LIST_LIMIT = 200;

export function resolveListOptions(opts: { limit?: number } = {}): ResolvedListOptions {
  return { limit: Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIST_LIMIT)) };
}

/** Discord ids are numeric snowflakes. Anything else never reaches a selector or a URL. */
export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{15,22}$/.test(value);
}

/**
 * Plain text of a node with non-breaking spaces normalized. Shared by the
 * in-page functions; `buildListExpression` inlines its source ahead of them,
 * so it must be self-contained too.
 */
export function plainText(n: DomNode | null): string {
  if (!n) return "";
  const parts: string[] = [];
  const walk = (x: DomNode): void => {
    if (x.nodeType === 3) parts.push(x.nodeValue ?? "");
    else if (x.nodeType === 1) for (let i = 0; i < x.childNodes.length; i++) walk(x.childNodes[i]);
  };
  walk(n);
  return parts.join("").replace(/[\u00a0\u2007\u202f]/g, " ").trim();
}

/**
 * List direct and group message conversations from the sidebar.
 * SELF-CONTAINED: shipped to the browser via `Function.prototype.toString`.
 */
export function listDms(root: DomRoot, sel: DiscordNavSelectors, opts: ResolvedListOptions): ListResult<DiscordDm> {
  const list = root.querySelector(sel.dmList);
  if (!list) {
    return { items: [], count: 0, truncated: false, problem: "No DM sidebar found. Open Discord's Direct Messages view and retry." };
  }
  const items: DiscordDm[] = [];
  let truncated = false;
  const rows = Array.from(list.querySelectorAll(sel.dmItem));
  for (const row of rows) {
    const link = row.querySelector(sel.dmLink);
    if (!link) continue; // Friends, Nitro, Shop, message requests: not conversations.
    const href = link.getAttribute("href") ?? "";
    const id = href.slice(sel.dmHrefPrefix.length).split(/[/?#]/)[0];
    if (!/^\d{15,22}$/.test(id)) continue;
    if (items.length >= opts.limit) {
      truncated = true;
      break;
    }
    const label = link.getAttribute("aria-label") ?? "";
    const m = /\(([^)]*)\)\s*(?:,\s*(.*))?$/.exec(label);
    items.push({
      id,
      name: plainText(row.querySelector(sel.dmName)) || label.replace(/\s*\(.*$/, "").trim(),
      kind: m ? m[1].trim() : null,
      status: m && m[2] ? m[2].trim() : null,
      unread: row.querySelector(sel.dmUnread) !== null,
    });
  }
  return { items, count: items.length, truncated, problem: null };
}

/**
 * List the servers the user belongs to, from the server rail.
 * SELF-CONTAINED: shipped to the browser via `Function.prototype.toString`.
 */
export function listGuilds(root: DomRoot, sel: DiscordNavSelectors, opts: ResolvedListOptions): ListResult<DiscordGuild> {
  const rail = root.querySelector(sel.guildRail);
  if (!rail) {
    return { items: [], count: 0, truncated: false, problem: "No server rail found. Is Discord fully loaded?" };
  }
  const items: DiscordGuild[] = [];
  let truncated = false;
  for (const node of Array.from(rail.querySelectorAll(sel.guildItem))) {
    const itemId = node.getAttribute("data-list-item-id") ?? "";
    if (itemId === sel.guildHomeId) continue;
    const id = itemId.slice(sel.guildIdPrefix.length);
    if (!/^\d{15,22}$/.test(id)) continue; // folders and other non-server rail entries
    if (items.length >= opts.limit) {
      truncated = true;
      break;
    }
    const raw = plainText(node.querySelector(sel.guildLabel));
    const name = raw.replace(sel.guildLabelPrefix, "").trim();
    items.push({ id, name: name || raw, raw_label: raw });
  }
  return { items, count: items.length, truncated, problem: null };
}

/**
 * List the text channels of the currently open server, with their category.
 * SELF-CONTAINED: shipped to the browser via `Function.prototype.toString`.
 */
export function listChannels(root: DomRoot, sel: DiscordNavSelectors, opts: ResolvedListOptions): ListChannelsResult {
  const entries = Array.from(root.querySelectorAll(sel.channelEntry));
  const guildName = plainText(root.querySelector(sel.guildHeader)) || null;
  if (entries.length === 0) {
    return {
      guild: { id: null, name: guildName },
      items: [], count: 0, truncated: false,
      problem: "No channel sidebar found. Open a server in Discord and retry.",
    };
  }
  const items: DiscordChannel[] = [];
  let guildId: string | null = null;
  let category: string | null = null;
  let truncated = false;
  for (const entry of entries) {
    const label = entry.getAttribute("aria-label") ?? "";
    const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(label);
    const name = m ? m[1].trim() : label.trim();
    const kind = m ? m[2].trim().toLowerCase() : null;
    const tag = (entry.tagName ?? "").toUpperCase();
    const href = tag === "A" ? entry.getAttribute("href") : (entry.querySelector(sel.channelLink)?.getAttribute("href") ?? null);
    if (!href) {
      // A category header (expandable, no link). Its name scopes the entries that follow.
      if (kind === "category" || entry.getAttribute("aria-expanded") !== null) category = name || null;
      continue;
    }
    const segments = href.split(/[?#]/)[0].split("/");
    const channelId = segments[segments.length - 1];
    const gId = segments[segments.length - 2];
    if (!/^\d{15,22}$/.test(channelId) || !/^\d{15,22}$/.test(gId)) continue;
    guildId = guildId ?? gId;
    if (items.length >= opts.limit) {
      truncated = true;
      break;
    }
    items.push({ id: channelId, name, kind, category, href });
  }
  return { guild: { id: guildId, name: guildName }, items, count: items.length, truncated, problem: null };
}

/**
 * Build the expression the transport evaluates for one of the listing
 * functions. Same `__name` shim rule as discord-dom.ts.
 */
export function buildListExpression(
  fn: "listDms" | "listGuilds" | "listChannels",
  opts: { limit?: number } = {},
  selectors: DiscordNavSelectors = DISCORD_NAV_SELECTORS,
): string {
  const helper = plainText.toString();
  const source = { listDms, listGuilds, listChannels }[fn].toString();
  const shim = /\b__name\(/.test(source + helper) ? "const __name = (fn) => fn; " : "";
  // RegExp values do not survive JSON.stringify; serialize them as source.
  const sel = Object.entries(selectors)
    .map(([k, v]) => `${JSON.stringify(k)}: ${v instanceof RegExp ? v.toString() : JSON.stringify(v)}`)
    .join(", ");
  return `(() => { ${shim}const plainText = ${helper}; return (${source})(document, { ${sel} }, ${JSON.stringify(resolveListOptions(opts))}); })()`;
}

// --- Navigation (Node side) ---

/** The one thing `openChannel` needs from a transport. */
export type Evaluate = (expression: string, options?: { timeoutMs?: number }) => Promise<unknown>;

export interface OpenChannelTarget {
  /** Omit or `null` for a direct or group message. */
  guildId?: string | null;
  channelId: string;
}

export interface OpenChannelOptions {
  /** Total time allowed for navigation and mount. @default 15000 */
  timeoutMs?: number;
  /** Poll interval while waiting for the message list. @default 250 */
  pollMs?: number;
  /** Injection point for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface OpenChannelResult {
  channelId: string;
  path: string;
  /** True when the channel was already open and no navigation happened. */
  alreadyOpen: boolean;
  elapsedMs: number;
}

/** Same-origin path for a channel. Only validated snowflakes reach it. */
export function channelPath(target: OpenChannelTarget): string {
  if (!isSnowflake(target.channelId)) throw new Error(`channelId must be a Discord snowflake (got ${JSON.stringify(target.channelId)})`);
  if (target.guildId !== undefined && target.guildId !== null) {
    if (!isSnowflake(target.guildId)) throw new Error(`guildId must be a Discord snowflake (got ${JSON.stringify(target.guildId)})`);
    return `/channels/${target.guildId}/${target.channelId}`;
  }
  return `/channels/@me/${target.channelId}`;
}

/** Expression that reports whether the message list for `channelId` is mounted. */
export function mountedExpression(channelId: string, selectors: DiscordNavSelectors = DISCORD_NAV_SELECTORS): string {
  if (!isSnowflake(channelId)) throw new Error("channelId must be a Discord snowflake");
  return `(() => { const l = document.querySelector(${JSON.stringify(selectors.messageList)}); ` +
    `return l !== null && l.querySelector('li[id^="chat-messages-${channelId}-"]') !== null; })()`;
}

/** Expression that navigates to a same-origin path. Only `channelPath` output is ever passed. */
export function navigateExpression(path: string): string {
  if (!/^\/channels\/(?:@me|\d{15,22})\/\d{15,22}$/.test(path)) throw new Error("navigation path must come from channelPath()");
  return `(() => { location.assign(${JSON.stringify(path)}); return true; })()`;
}

/**
 * Open a channel in the attached tab and wait for its messages to mount.
 * Navigation is a same-origin `location.assign` of a validated path; the
 * transport's origin guard applies to every poll. Side effect: Discord
 * marks the channel read, exactly as clicking it does.
 */
export async function openChannel(
  evaluate: Evaluate,
  target: OpenChannelTarget,
  options: OpenChannelOptions = {},
): Promise<OpenChannelResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const path = channelPath(target);
  const started = Date.now();
  const mounted = mountedExpression(target.channelId);

  if ((await evaluate(mounted)) === true) {
    return { channelId: target.channelId, path, alreadyOpen: true, elapsedMs: Date.now() - started };
  }
  try {
    await evaluate(navigateExpression(path));
  } catch {
    // Same-document navigation can destroy the execution context before the
    // evaluate returns; the mount poll below decides whether it worked.
  }
  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    let ok = false;
    try {
      ok = (await evaluate(mounted)) === true;
    } catch {
      ok = false; // context still being replaced; keep polling
    }
    if (ok) return { channelId: target.channelId, path, alreadyOpen: false, elapsedMs: Date.now() - started };
  }
  throw new Error(`Channel ${target.channelId} did not open within ${timeoutMs}ms (path ${path}). Check that the user can see it.`);
}
