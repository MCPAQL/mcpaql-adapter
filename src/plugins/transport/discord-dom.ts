/**
 * Discord DOM extraction for the read-only Discord adapter.
 *
 * Reads messages from the Discord web client's rendered DOM with full
 * fidelity. This is deliberately NOT the accessibility tree (which truncates
 * each message at ~100 characters) and NOT a readability-style text pass
 * (which returns only the first link embed).
 *
 * Design: {@link extractMessages} is a self-contained function that uses a
 * narrow DOM surface (`querySelector`, `getAttribute`, `childNodes`). It is
 * unit-tested in Node against a fake DOM, and shipped to the browser as its
 * own source text via {@link buildExtractMessagesExpression}. One
 * implementation, two runtimes. The function must therefore never close over
 * module scope: everything it needs arrives as a parameter.
 *
 * Selector policy: Discord hashes its class names and rotates them. Every
 * selector lives in {@link DISCORD_SELECTORS} and prefers stable attributes
 * (`data-list-id`, `id` prefixes, `role`, `datetime`). Class-based selectors
 * use substring matches on the un-hashed stem. When Discord changes markup,
 * the fixture tests fail loudly on one table instead of returning empty.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Selectors observed on discord.com, verified 2026-09-02. */
export const DISCORD_SELECTORS = {
  /** The message list; `aria-label` is "Messages in <channel>". */
  messageList: 'ol[data-list-id="chat-messages"]',
  /** Message rows; id is `chat-messages-<channelId>-<messageId>`. Date dividers are excluded by the id prefix. */
  messageItem: 'li[id^="chat-messages-"]',
  /** Author header, present only on the first message of a group. */
  header: "h3",
  /** Author display name; id `message-username-<messageId>`. */
  username: '[id^="message-username-"]',
  /** Absolute timestamp; `datetime` is ISO 8601. */
  time: 'time[id^="message-timestamp-"]',
  /** Reply context; `aria-label` is "<author> replying to <author>". */
  replyContext: '[id^="message-reply-context-"]',
  /** Content inside a reply preview; id `message-content-<referencedMessageId>`. */
  replyContent: '[id^="message-content-"]',
  /** Attachments, embeds, reactions live here; id `message-accessories-<messageId>`. */
  accessories: '[id^="message-accessories-"]',
  reactionsGroup: '[id^="message-reactions-"]',
  reaction: '[class*="reactionInner"]',
  reactionCount: '[class*="reactionCount"]',
  emojiImage: 'img[data-type="emoji"], img[class*="emoji"]',
  attachmentLink: 'a[href*="cdn.discordapp.com/attachments/"], a[href*="media.discordapp.net/attachments/"]',
  embed: 'article[class*="embed"]',
  embedProvider: '[class*="embedProvider"]',
  embedTitleLink: '[class*="embedTitle"] a[href]',
  embedDescription: '[class*="embedDescription"]',
  edited: '[class*="edited"]',
  contentLink: "a[href]",
} as const;

export type DiscordSelectors = typeof DISCORD_SELECTORS;

/** Default caps applied inside the page before anything is returned. */
export const DEFAULT_MAX_MESSAGES = 100;
export const DEFAULT_MAX_BYTES = 1024 * 1024;

export interface ExtractOptions {
  /** Maximum messages returned, newest wins. @default 100 */
  maxMessages?: number;
  /** Approximate serialized size cap for the whole result. @default 1 MiB */
  maxBytes?: number;
}

export interface DiscordReaction {
  emoji: string;
  count: number;
  /** Whether the current user reacted (Discord marks it "press to remove your reaction"). */
  me: boolean;
}

export interface DiscordAttachment {
  url: string;
  filename: string;
}

export interface DiscordEmbed {
  provider: string | null;
  title: string | null;
  url: string | null;
  description: string | null;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  author: string | null;
  /** True when the author was taken from the group header of an earlier message. */
  author_inherited: boolean;
  timestamp: string | null;
  content: string;
  reply_to: string | null;
  reply_label: string | null;
  reactions: DiscordReaction[];
  attachments: DiscordAttachment[];
  embeds: DiscordEmbed[];
  links: string[];
  edited: boolean;
}

export interface ExtractResult {
  channel: { id: string | null; label: string | null };
  /** In DOM order: oldest first. Callers wanting newest-first reverse it. */
  messages: DiscordMessage[];
  count: number;
  /** Set when a cap stopped extraction before the visible list was exhausted. */
  truncated: boolean;
  /** Present when the page did not look like a Discord chat view. */
  problem: string | null;
}

/**
 * Narrow DOM surface the extractor needs. Real browsers satisfy it; the
 * test fake implements exactly this and nothing more.
 */
export interface DomNode {
  nodeType: number;
  nodeValue: string | null;
  tagName?: string;
  childNodes: ArrayLike<DomNode>;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
}

/**
 * Extract messages from a Discord chat view.
 *
 * SELF-CONTAINED: no references to module scope. Shipped to the browser via
 * `Function.prototype.toString`. Keep every helper inside.
 */
export function extractMessages(
  root: DomNode,
  sel: DiscordSelectors,
  opts: ExtractOptions,
): ExtractResult {
  const maxMessages = Math.max(1, Math.floor(opts.maxMessages ?? 100));
  const maxBytes = Math.max(1024, Math.floor(opts.maxBytes ?? 1024 * 1024));

  const toArray = <T>(list: ArrayLike<T>): T[] => Array.prototype.slice.call(list);
  const attr = (node: DomNode | null, name: string): string | null => (node ? node.getAttribute(name) : null);

  /** Text with emoji images rendered as their alt text and <br> as newlines. */
  const renderText = (node: DomNode | null): string => {
    if (!node) return "";
    let out = "";
    const walk = (n: DomNode): void => {
      if (n.nodeType === 3) {
        out += n.nodeValue ?? "";
        return;
      }
      if (n.nodeType !== 1) return;
      const tag = (n.tagName ?? "").toUpperCase();
      if (tag === "IMG") {
        const alt = n.getAttribute("alt");
        const name = n.getAttribute("data-name");
        out += alt && alt.trim() !== "" ? alt : (name ?? "");
        return;
      }
      if (tag === "BR") {
        out += "\n";
        return;
      }
      const kids = toArray(n.childNodes);
      for (const k of kids) walk(k);
    };
    walk(node);
    return out;
  };

  const idSuffix = (id: string | null, prefix: string): string | null =>
    id && id.startsWith(prefix) ? id.slice(prefix.length) : null;

  const list = root.querySelector(sel.messageList);
  if (!list) {
    return {
      channel: { id: null, label: null },
      messages: [],
      count: 0,
      truncated: false,
      problem: "No message list found. Open a DM or text channel in Discord and retry.",
    };
  }
  const listLabel = attr(list, "aria-label");
  const channelLabel = listLabel && listLabel.startsWith("Messages in ")
    ? listLabel.slice("Messages in ".length)
    : listLabel;

  const items = toArray(list.querySelectorAll(sel.messageItem));
  const messages: DiscordMessage[] = [];
  let channelId: string | null = null;
  let bytes = 2;
  let truncated = false;

  // Walk newest-to-oldest so caps keep the most recent messages, then restore DOM order.
  for (let i = items.length - 1; i >= 0; i--) {
    const li = items[i];
    const rawId = attr(li, "id") ?? "";
    const parts = rawId.split("-");
    if (parts.length < 4) continue;
    const messageId = parts[parts.length - 1];
    const chanId = parts[parts.length - 2];
    channelId = channelId ?? chanId;

    const header = li.querySelector(sel.header);
    let author: string | null = null;
    let authorInherited = false;
    if (header) {
      author = renderText(header.querySelector(sel.username)).trim() || null;
    } else {
      // Grouped messages carry `aria-labelledby="message-username-<groupStartId> ..."`.
      const article = li.querySelector('[role="article"]');
      const labelledBy = attr(article, "aria-labelledby") ?? "";
      const usernameId = labelledBy.split(/\s+/).find((t) => t.startsWith("message-username-"));
      const usernameNode = usernameId ? root.querySelector(`[id="${usernameId}"]`) : null;
      author = usernameNode ? (renderText(usernameNode).trim() || null) : null;
      authorInherited = true;
    }

    const timeNode = li.querySelector(sel.time);
    const timestamp = attr(timeNode, "datetime");

    const contentNode = li.querySelector(`[id="message-content-${messageId}"]`);
    const content = renderText(contentNode).replace(/ /g, " ").trim();

    const replyCtx = li.querySelector(sel.replyContext);
    const replyPreview = replyCtx ? replyCtx.querySelector(sel.replyContent) : null;
    const replyTo = idSuffix(attr(replyPreview, "id"), "message-content-");
    const replyLabel = attr(replyCtx, "aria-label");

    const accessories = li.querySelector(sel.accessories);

    const reactions: DiscordReaction[] = [];
    const reactionsGroup = accessories ? accessories.querySelector(sel.reactionsGroup) : null;
    if (reactionsGroup) {
      for (const r of toArray(reactionsGroup.querySelectorAll(sel.reaction))) {
        const img = r.querySelector(sel.emojiImage);
        const emoji = (attr(img, "alt") ?? attr(img, "data-name") ?? "").trim();
        const countText = renderText(r.querySelector(sel.reactionCount)).trim();
        const count = Number.parseInt(countText, 10);
        const label = attr(r, "aria-label") ?? "";
        reactions.push({
          emoji: emoji || label.split(",")[0].trim(),
          count: Number.isFinite(count) ? count : 0,
          me: /remove your reaction/i.test(label),
        });
      }
    }

    const attachments: DiscordAttachment[] = [];
    const seenUrls = new Set<string>();
    if (accessories) {
      for (const a of toArray(accessories.querySelectorAll(sel.attachmentLink))) {
        const href = attr(a, "href");
        if (!href || seenUrls.has(href)) continue;
        seenUrls.add(href);
        const path = href.split("?")[0];
        const filename = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
        attachments.push({ url: href, filename });
      }
    }

    const embeds: DiscordEmbed[] = [];
    if (accessories) {
      for (const e of toArray(accessories.querySelectorAll(sel.embed))) {
        const titleLink = e.querySelector(sel.embedTitleLink);
        embeds.push({
          provider: renderText(e.querySelector(sel.embedProvider)).trim() || null,
          title: renderText(titleLink).trim() || null,
          url: attr(titleLink, "href"),
          description: renderText(e.querySelector(sel.embedDescription)).trim() || null,
        });
      }
    }

    const links: string[] = [];
    if (contentNode) {
      for (const a of toArray(contentNode.querySelectorAll(sel.contentLink))) {
        const href = attr(a, "href");
        if (href && !links.includes(href)) links.push(href);
      }
    }

    const edited = contentNode ? contentNode.querySelector(sel.edited) !== null : false;

    const message: DiscordMessage = {
      id: messageId,
      channel_id: chanId,
      author,
      author_inherited: authorInherited,
      timestamp,
      content,
      reply_to: replyTo,
      reply_label: replyLabel,
      reactions,
      attachments,
      embeds,
      links,
      edited,
    };

    const size = JSON.stringify(message).length + 1;
    if (messages.length >= maxMessages || bytes + size > maxBytes) {
      truncated = true;
      break;
    }
    bytes += size;
    messages.push(message);
  }

  messages.reverse();

  // Fallback for grouped messages whose group header was outside the cap window.
  let carry: string | null = null;
  for (const m of messages) {
    if (m.author && !m.author_inherited) carry = m.author;
    else if (!m.author && carry) m.author = carry;
  }
  return {
    channel: { id: channelId, label: channelLabel },
    messages,
    count: messages.length,
    truncated,
    problem: null,
  };
}

/**
 * Build the expression the transport evaluates in the page. The extractor's
 * own source is inlined, so the browser runs exactly what the tests ran.
 */
export function buildExtractMessagesExpression(
  opts: ExtractOptions = {},
  selectors: DiscordSelectors = DISCORD_SELECTORS,
): string {
  const source = extractMessages.toString();
  // Some TypeScript runtimes (esbuild with keepNames, used by tsx) wrap inner
  // functions in a `__name(fn, "name")` helper that does not exist in the
  // page. The compiled `tsc` output has no such helper. Define an identity
  // shim only when the source references it, so both runtimes ship code that
  // runs in a bare browser context.
  const shim = /\b__name\(/.test(source) ? "const __name = (fn) => fn; " : "";
  const args = `document, ${JSON.stringify(selectors)}, ${JSON.stringify({
    maxMessages: opts.maxMessages ?? DEFAULT_MAX_MESSAGES,
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
  })}`;
  return `(() => { ${shim}return (${source})(${args}); })()`;
}
