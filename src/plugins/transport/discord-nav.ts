/**
 * Discord listing and navigation for the read-only Discord adapter.
 *
 * Three in-page listing functions (`listDms`, `listGuilds`, `listChannels`)
 * read the sidebars of the Discord web client, and one Node-side helper
 * (`openChannel`) drives navigation through a transport's `evaluate`.
 *
 * Same discipline as discord-dom.ts: the in-page functions use only the
 * narrow `DomRoot`/`DomNode` surface, are unit-tested against the fake DOM,
 * and ship to the browser as their own source text with the shared
 * `renderText` helper inlined ahead of them. Every selector lives in
 * {@link DISCORD_NAV_SELECTORS}.
 *
 * Navigation is a same-document route change (`history.pushState` plus a
 * `popstate` event, which Discord's router handles) to a path built only
 * from validated snowflake ids, never a caller URL. It does not reload the
 * client, so drafts and voice connections survive, exactly as a sidebar
 * click does.
 *
 * The only side effect anywhere in this module is the one clicking has:
 * opening a channel marks it read in Discord.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DISCORD_SELECTORS, buildPageExpression, renderText, type DomNode, type DomRoot } from "./discord-dom.js";

/** Discord ids are numeric snowflakes. One definition, used in Node and in the page. */
export const SNOWFLAKE_PATTERN = "^\\d{15,22}$";

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
  /** The name node itself (`name_<hash>`), not the `nameAndDecorators_<hash>` wrapper that also holds bot tags. */
  dmName: '[class*="name_"]',
  dmUnread: '[class*="numberBadge"], [class*="unread"]',
  /** The sidebar region that holds the open server's channel entries and its header. */
  channelNav: "nav",
  /** Channel sidebar entries; channels are links, categories are expandable headers. */
  channelEntry: '[data-list-item-id^="channels___"]',
  channelLink: "a[href]",
  /** Server name shown in the channel sidebar header. */
  guildHeader: "header h1",
  /** The mounted message list, shared with the extractor. */
  messageList: DISCORD_SELECTORS.messageList,
  /** Markers (not selectors). */
  messageRowPrefix: DISCORD_SELECTORS.messageRowPrefix,
  guildIdPrefix: "guildsnav___",
  guildHomeId: "guildsnav___home",
  channelIdPrefix: "channels___",
  dmHrefPrefix: "/channels/@me/",
  snowflake: SNOWFLAKE_PATTERN,
  /**
   * Unread-status prefixes Discord prepends to the hidden guild label,
   * observed live: "Unread messages, X", "1 mention, X", "23 mentions, X".
   * A pattern source (compiled in the page) so the table stays JSON.
   */
  guildLabelPrefix: "^(?:unread(?: messages?| mentions?)?|\\d+ (?:unread )?(?:mentions?|messages?)),\\s*",
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

/** Anything that is not a snowflake never reaches a selector or a URL. */
export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && new RegExp(SNOWFLAKE_PATTERN).test(value);
}

/**
 * List direct and group message conversations from the sidebar.
 * SELF-CONTAINED: shipped to the browser via `Function.prototype.toString`.
 */
export function listDms(root: DomRoot, sel: DiscordNavSelectors, opts: ResolvedListOptions): ListResult<DiscordDm> {
  const snowflake = new RegExp(sel.snowflake);
  const renderTextOf = (value: string | null): string => (value ?? "").replace(/[\u00a0\u2007\u202f]/g, " ");
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
    if (!snowflake.test(id)) continue;
    if (items.length >= opts.limit) {
      truncated = true;
      break;
    }
    // Label shape: "<name> (<kind>)[, <status>]". Only the LAST parenthesized
    // group is the kind, so names like "Alice (she/her)" survive.
    const label = renderTextOf(link.getAttribute("aria-label"));
    const m = /\(([^()]*)\)(?:,\s*([^()]*))?$/.exec(label);
    items.push({
      id,
      name: renderText(row.querySelector(sel.dmName), null).trim() || (m ? label.slice(0, m.index).trim() : label.trim()),
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
  const snowflake = new RegExp(sel.snowflake);
  const prefix = new RegExp(sel.guildLabelPrefix, "i");
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
    if (!snowflake.test(id)) continue; // folders and other non-server rail entries
    if (items.length >= opts.limit) {
      truncated = true;
      break;
    }
    const raw = renderText(node.querySelector(sel.guildLabel), null).trim();
    const name = raw.replace(prefix, "").trim();
    items.push({ id, name: name || raw, raw_label: raw });
  }
  return { items, count: items.length, truncated, problem: null };
}

/**
 * List the text channels of the currently open server, with their category.
 * SELF-CONTAINED: shipped to the browser via `Function.prototype.toString`.
 */
export function listChannels(root: DomRoot, sel: DiscordNavSelectors, opts: ResolvedListOptions): ListChannelsResult {
  const snowflake = new RegExp(sel.snowflake);
  // Scope everything to the one sidebar region that holds channel entries, so
  // a DM view's header or a second mounted list can never bleed in.
  const navs = Array.from(root.querySelectorAll(sel.channelNav)).filter((n) => n.querySelector(sel.channelEntry) !== null);
  if (navs.length !== 1) {
    return {
      guild: { id: null, name: null },
      items: [], count: 0, truncated: false,
      problem: navs.length === 0
        ? "No channel sidebar found. Open a server in Discord and retry."
        : "More than one channel sidebar is mounted; cannot tell which server is open.",
    };
  }
  const nav = navs[0];
  const entries = Array.from(nav.querySelectorAll(sel.channelEntry));
  const guildName = renderText(nav.querySelector(sel.guildHeader), null).trim() || null;
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
    if (!snowflake.test(channelId) || !snowflake.test(gId)) continue;
    guildId = guildId ?? gId;
    if (items.length >= opts.limit) {
      truncated = true;
      break;
    }
    items.push({ id: channelId, name, kind, category, href });
  }
  return { guild: { id: guildId, name: guildName }, items, count: items.length, truncated, problem: null };
}

/** Build the expression the transport evaluates for one of the listing functions. */
export function buildListExpression(
  fn: "listDms" | "listGuilds" | "listChannels",
  opts: { limit?: number } = {},
  selectors: DiscordNavSelectors = DISCORD_NAV_SELECTORS,
): string {
  return buildPageExpression({ listDms, listGuilds, listChannels }[fn], [selectors, resolveListOptions(opts)], [renderText]);
}

// --- Navigation (Node side) ---

/** The one thing `openChannel` needs from a transport. */
export type Evaluate = (expression: string, options?: { timeoutMs?: number }) => Promise<unknown>;

export interface OpenChannelTarget {
  /** Omit or `null` for a direct or group message. */
  guildId?: string | null;
  channelId: string;
  /**
   * Optional message to jump to. Discord renders the history around it, so a
   * caller resuming from a cursor need not scroll from the newest message.
   */
  messageId?: string | null;
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
  let anchor = "";
  if (target.messageId !== undefined && target.messageId !== null) {
    if (!isSnowflake(target.messageId)) throw new Error(`messageId must be a Discord snowflake (got ${JSON.stringify(target.messageId)})`);
    anchor = `/${target.messageId}`;
  }
  if (target.guildId !== undefined && target.guildId !== null) {
    if (!isSnowflake(target.guildId)) throw new Error(`guildId must be a Discord snowflake (got ${JSON.stringify(target.guildId)})`);
    return `/channels/${target.guildId}/${target.channelId}${anchor}`;
  }
  return `/channels/@me/${target.channelId}${anchor}`;
}

/**
 * Expression that reports whether `channelId` is open: its message list is
 * mounted and either holds one of its rows or the location names the
 * channel (an empty channel has a list with no rows).
 */
export function mountedExpression(channelId: string, anchorMessageId: string | null = null, selectors: DiscordNavSelectors = DISCORD_NAV_SELECTORS): string {
  if (!isSnowflake(channelId)) throw new Error("channelId must be a Discord snowflake");
  if (anchorMessageId !== null) {
    // Resuming at an anchor: the channel's stale rows do not count. Only the anchored row itself does.
    if (!isSnowflake(anchorMessageId)) throw new Error("anchorMessageId must be a Discord snowflake");
    return `(() => { const l = document.querySelector(${JSON.stringify(selectors.messageList)}); if (l === null) return false; ` +
      `return l.querySelector('li[id="${selectors.messageRowPrefix}${channelId}-${anchorMessageId}"]') !== null; })()`;
  }
  return `(() => { const l = document.querySelector(${JSON.stringify(selectors.messageList)}); if (l === null) return false; ` +
    `if (l.querySelector('li[id^="${selectors.messageRowPrefix}${channelId}-"]') !== null) return true; ` +
    `return /^\\/channels\\/(?:@me|\\d+)\\/${channelId}(?:\\/|$)/.test(location.pathname); })()`;
}

/**
 * Expression that changes the client's route to a same-origin path without
 * reloading it: a history push followed by the `popstate` event Discord's
 * router listens for (verified live 2026-09-02). Only `channelPath` output
 * is ever passed; the shape is re-checked here as defense in depth.
 */
export function navigateExpression(path: string): string {
  const id = SNOWFLAKE_PATTERN.slice(1, -1);
  if (!new RegExp(`^/channels/(?:@me|${id})/${id}(?:/${id})?$`).test(path)) throw new Error("navigation path must come from channelPath()");
  return `(() => { history.pushState({}, "", ${JSON.stringify(path)}); ` +
    `dispatchEvent(new PopStateEvent("popstate", { state: {} })); return true; })()`;
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
  const mounted = mountedExpression(target.channelId, target.messageId ?? null);

  // Every evaluate and every sleep is bounded by what actually remains of the
  // total budget, so a hung page cannot stretch the op past `timeoutMs`, and
  // nothing (including the mark-as-read navigation) starts once it is spent.
  const remaining = (): number => timeoutMs - (Date.now() - started);
  const budgeted = <T>(run: (timeoutMs: number) => Promise<T>): Promise<T> => {
    const left = remaining();
    if (left <= 0) throw new OpenChannelTimeout(target.channelId, timeoutMs, path);
    return run(left);
  };
  // With an anchor, the probe requires the anchored row itself, so a channel
  // that is open on a stale window still navigates.
  if ((await budgeted((t) => evaluate(mounted, { timeoutMs: t }))) === true) {
    return { channelId: target.channelId, path, alreadyOpen: true, elapsedMs: Date.now() - started };
  }
  try {
    await budgeted((t) => evaluate(navigateExpression(path), { timeoutMs: t }));
  } catch (err) {
    // A route change does not normally replace the execution context, but a
    // client that does reload would; only that is expected. Anything else (disconnected,
    // origin refused, protocol error, timeout) is the transport's named
    // failure and must reach the caller.
    if (!isContextReplaced(err)) throw err;
  }
  while (remaining() > 0) {
    await sleep(Math.min(pollMs, Math.max(0, remaining())));
    if (remaining() <= 0) break;
    let ok = false;
    try {
      ok = (await budgeted((t) => evaluate(mounted, { timeoutMs: t }))) === true;
    } catch (err) {
      if (!isContextReplaced(err)) throw err;
      ok = false; // context still being replaced; keep polling
    }
    if (ok) return { channelId: target.channelId, path, alreadyOpen: false, elapsedMs: Date.now() - started };
  }
  throw new OpenChannelTimeout(target.channelId, timeoutMs, path);
}

/** The channel did not mount within the budget. */
export class OpenChannelTimeout extends Error {
  constructor(readonly channelId: string, readonly timeoutMs: number, readonly path: string) {
    super(`Channel ${channelId} did not open within ${timeoutMs}ms (path ${path}). Check that the user can see it.`);
    this.name = "OpenChannelTimeout";
  }
}

/**
 * True for the one failure navigation is expected to cause: the page's
 * execution context being torn down and replaced. Matched on the DevTools
 * wording, which the transport passes through in its message.
 */
export function isContextReplaced(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /execution context (was )?destroyed|cannot find context|context.*(navigat|replaced)|inspected target navigated/i.test(message);
}
