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
  /** The message article; `aria-labelledby` names the group's username element. */
  article: '[role="article"]',
  /**
   * Author header, present only on the first message of a group. Scoped by
   * its `aria-labelledby` so an `h3` rendered from markdown inside message
   * content is never mistaken for it.
   */
  header: 'h3[aria-labelledby*="message-username-"]',
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
  /** One reaction pill. Its class list carries `reactionMe` when the current user reacted (locale-independent). */
  reaction: '[class*="reaction_"]',
  reactionInner: '[class*="reactionInner"]',
  reactionCount: '[class*="reactionCount"]',
  emojiImage: 'img[data-type="emoji"], img[class*="emoji"]',
  attachmentLink: 'a[href*="cdn.discordapp.com/attachments/"], a[href*="media.discordapp.net/attachments/"]',
  embed: 'article[class*="embed"]',
  embedProvider: '[class*="embedProvider"]',
  embedTitleLink: '[class*="embedTitle"] a[href]',
  embedDescription: '[class*="embedDescription"]',
  edited: '[class*="edited"]',
  contentLink: "a[href]",
  /** Markers (not selectors) used to parse ids, labels, and class stems. */
  usernameIdPrefix: "message-username-",
  contentIdPrefix: "message-content-",
  listLabelPrefix: "Messages in ",
  /** Class stem that marks a reaction pill as the current user's. */
  reactionMeClass: "reactionMe",
  /** Class stem of the "(edited)" decoration inside content; excluded from text. */
  editedClass: "edited",
} as const;

export type DiscordSelectors = typeof DISCORD_SELECTORS;

/** Default caps applied inside the page before anything is returned. */
export const DEFAULT_MAX_MESSAGES = 100;
export const DEFAULT_MAX_BYTES = 1024 * 1024;

export interface ExtractOptions {
  /** Maximum messages returned, newest wins. @default DEFAULT_MAX_MESSAGES */
  maxMessages?: number;
  /** UTF-8 size cap for the whole serialized result, envelope included. @default DEFAULT_MAX_BYTES */
  maxBytes?: number;
  /**
   * Channel the caller expects to read. Required to disambiguate when Discord
   * mounts two message lists (thread or forum split view). When omitted and
   * more than one list is mounted, the result carries a `problem`.
   */
  channelId?: string | null;
}

/** Options with every default applied; the only shape the extractor accepts. */
export interface ResolvedExtractOptions {
  maxMessages: number;
  maxBytes: number;
  channelId: string | null;
}

/** Apply defaults once, for both the browser expression and the Node tests. */
export function resolveExtractOptions(opts: ExtractOptions = {}): ResolvedExtractOptions {
  return {
    maxMessages: Math.max(1, Math.floor(opts.maxMessages ?? DEFAULT_MAX_MESSAGES)),
    maxBytes: Math.max(1024, Math.floor(opts.maxBytes ?? DEFAULT_MAX_BYTES)),
    channelId: opts.channelId ?? null,
  };
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
  /**
   * True when the author was resolved through the group header of an earlier
   * message (Discord's `aria-labelledby` link). False for group-start rows and
   * for rows with no resolvable author, such as system notices; those carry
   * `author: null` rather than a guessed name.
   */
  author_inherited: boolean;
  /**
   * Id of the group-start message whose header names the author, when this
   * row is a grouped continuation. Present even when that header is not
   * mounted (Discord virtualizes the list), so a caller paging through
   * history can resolve `author` from an adjacent page.
   */
  author_ref: string | null;
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
  /** Rows examined, including any dropped by caps or skipped as malformed. */
  scanned: number;
  /** Set when a cap stopped extraction before the visible list was exhausted. */
  truncated: boolean;
  /** Present when the page did not look like a Discord chat view. */
  problem: string | null;
}

/**
 * What the extractor may do with its root: query, nothing else. The page
 * passes `document`, which has no attributes or tag of its own.
 */
export type DomRoot = Pick<DomNode, "querySelector" | "querySelectorAll">;

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
  root: DomRoot,
  sel: DiscordSelectors,
  opts: ResolvedExtractOptions,
): ExtractResult {
  const maxMessages = opts.maxMessages;
  const maxBytes = opts.maxBytes;

  const attr = (node: DomNode | null, name: string): string | null => (node ? node.getAttribute(name) : null);
  const qsa = (node: DomRoot | null, selector: string): DomNode[] => (node ? Array.from(node.querySelectorAll(selector)) : []);
  /** Ids are interpolated into selectors; only accept the character set Discord uses. */
  const safeToken = (value: string | null): value is string => value !== null && /^[\w-]+$/.test(value);
  /** UTF-8 byte length of a JS string, so caps mean bytes on the wire, not code units. */
  const utf8Length = (text: string): number => {
    let n = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  };

  /** Text with emoji images rendered as their alt text and <br> as newlines. */
  const renderText = (node: DomNode | null): string => {
    if (!node) return "";
    const parts: string[] = [];
    const walk = (n: DomNode): void => {
      if (n.nodeType === 3) {
        parts.push(n.nodeValue ?? "");
        return;
      }
      if (n.nodeType !== 1) return;
      if ((n.getAttribute("class") ?? "").includes(sel.editedClass)) return;
      const tag = (n.tagName ?? "").toUpperCase();
      if (tag === "IMG") {
        const alt = n.getAttribute("alt");
        const name = n.getAttribute("data-name");
        parts.push(alt && alt.trim() !== "" ? alt : (name ?? ""));
        return;
      }
      if (tag === "BR") {
        parts.push("\n");
        return;
      }
      const kids = n.childNodes;
      for (let i = 0; i < kids.length; i++) walk(kids[i]);
    };
    walk(node);
    // Discord pads with non-breaking spaces; normalize every rendered string once.
    return parts.join("").replace(/[\u00a0\u2007\u202f]/g, " ");
  };

  const idSuffix = (id: string | null, prefix: string): string | null =>
    id && id.startsWith(prefix) ? id.slice(prefix.length) : null;

  const fail = (problem: string): ExtractResult => ({
    channel: { id: null, label: null },
    messages: [],
    count: 0,
    scanned: 0,
    truncated: false,
    problem,
  });

  const lists = qsa(root, sel.messageList);
  if (lists.length === 0) {
    return fail("No message list found. Open a DM or text channel in Discord and retry.");
  }
  let list: DomNode | null = null;
  if (opts.channelId !== null) {
    if (!safeToken(opts.channelId)) return fail("channelId must be a Discord snowflake.");
    list = lists.find((l) => l.querySelector(`li[id^="chat-messages-${opts.channelId}-"]`) !== null) ?? null;
    if (!list) {
      return fail(`Channel ${opts.channelId} is not in view. Open it in Discord and retry.`);
    }
  } else if (lists.length > 1) {
    return fail("More than one message list is mounted (thread or forum split view). Pass channelId to choose one.");
  } else {
    list = lists[0];
  }
  const listLabel = attr(list, "aria-label");
  const channelLabel = idSuffix(listLabel, sel.listLabelPrefix) ?? listLabel;

  const items = qsa(list, sel.messageItem);
  const messages: DiscordMessage[] = [];
  let channelId: string | null = null;
  // Envelope overhead counts toward the cap so the whole result respects it.
  // Seeded with the final result shape at its largest: a 20-digit channel id,
  // count at the cap, scanned at the row count, and `truncated` true.
  const envelopeAtMax: ExtractResult = {
    channel: { id: "0".repeat(20), label: channelLabel },
    messages: [],
    count: maxMessages,
    scanned: items.length,
    truncated: true,
    problem: null,
  };
  let bytes = utf8Length(JSON.stringify(envelopeAtMax));
  let truncated = false;

  // Walk newest-to-oldest so caps keep the most recent messages, then restore DOM order.
  for (let i = items.length - 1; i >= 0; i--) {
    const li = items[i];
    const rawId = attr(li, "id") ?? "";
    const parts = rawId.split("-");
    if (parts.length < 4) continue;
    const messageId = parts[parts.length - 1];
    const chanId = parts[parts.length - 2];
    if (!safeToken(messageId) || !safeToken(chanId)) continue;

    const header = li.querySelector(sel.header);
    let author: string | null = null;
    let authorInherited = false;
    let authorRef: string | null = null;
    if (header) {
      author = renderText(header.querySelector(sel.username)).trim() || null;
    } else {
      // Grouped messages carry `aria-labelledby="message-username-<groupStartId> ..."`.
      // System rows have no such token and keep author null; nothing is guessed.
      // The header may be unmounted (virtualized list); author_ref lets a caller
      // resolve it from an adjacent page.
      const labelledBy = attr(li.querySelector(sel.article), "aria-labelledby") ?? "";
      const usernameId = labelledBy.split(/\s+/).find((t) => t.startsWith(sel.usernameIdPrefix)) ?? null;
      if (safeToken(usernameId)) {
        authorRef = usernameId.slice(sel.usernameIdPrefix.length);
        const usernameNode = root.querySelector(`#${usernameId}`);
        author = usernameNode ? (renderText(usernameNode).trim() || null) : null;
        authorInherited = author !== null;
      }
    }

    const timestamp = attr(li.querySelector(sel.time), "datetime");

    // Reply previews reuse the referenced message's `message-content-<refId>`, so own
    // content is matched by exact id within this row, never by prefix.
    const contentNode = li.querySelector(`[id="${sel.contentIdPrefix}${messageId}"]`);
    // Not trimmed: leading indentation and trailing newlines inside code blocks are content.
    const content = renderText(contentNode);

    const replyCtx = li.querySelector(sel.replyContext);
    const replyPreview = replyCtx ? replyCtx.querySelector(sel.replyContent) : null;
    const replyTo = idSuffix(attr(replyPreview, "id"), sel.contentIdPrefix);
    const replyLabel = attr(replyCtx, "aria-label");

    const accessories = li.querySelector(sel.accessories);
    const reactions: DiscordReaction[] = [];
    const attachments: DiscordAttachment[] = [];
    const embeds: DiscordEmbed[] = [];
    if (accessories) {
      for (const r of qsa(accessories.querySelector(sel.reactionsGroup), sel.reaction)) {
        const inner = r.querySelector(sel.reactionInner) ?? r;
        const emoji = renderText(inner.querySelector(sel.emojiImage)).trim();
        const count = Number.parseInt(renderText(inner.querySelector(sel.reactionCount)).trim(), 10);
        const label = attr(inner, "aria-label") ?? "";
        reactions.push({
          emoji: emoji || label.split(",")[0].trim(),
          count: Number.isFinite(count) ? count : 0,
          me: (attr(r, "class") ?? "").includes(sel.reactionMeClass),
        });
      }
      const seenUrls = new Set<string>();
      for (const a of qsa(accessories, sel.attachmentLink)) {
        const href = attr(a, "href");
        if (!href || seenUrls.has(href)) continue;
        seenUrls.add(href);
        const path = href.split("#")[0].split("?")[0];
        const rawName = path.slice(path.lastIndexOf("/") + 1);
        let filename = rawName;
        try {
          filename = decodeURIComponent(rawName);
        } catch {
          // Malformed percent-encoding: keep the raw name rather than lose the row.
        }
        attachments.push({ url: href, filename });
      }
      for (const e of qsa(accessories, sel.embed)) {
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
    for (const a of qsa(contentNode, sel.contentLink)) {
      const href = attr(a, "href");
      if (href && !links.includes(href)) links.push(href);
    }

    const edited = contentNode ? contentNode.querySelector(sel.edited) !== null : false;

    const message: DiscordMessage = {
      id: messageId,
      channel_id: chanId,
      author,
      author_inherited: authorInherited,
      author_ref: authorRef,
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

    const size = utf8Length(JSON.stringify(message)) + 1;
    if (messages.length >= maxMessages || bytes + size > maxBytes) {
      truncated = true;
      break;
    }
    bytes += size;
    messages.push(message);
    channelId = chanId;
  }

  messages.reverse();

  return {
    channel: { id: channelId, label: channelLabel },
    messages,
    count: messages.length,
    scanned: items.length,
    truncated,
    problem: truncated && messages.length === 0
      ? `The newest message alone exceeds maxBytes (${maxBytes}). Raise the cap.`
      : null,
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
  const args = `document, ${JSON.stringify(selectors)}, ${JSON.stringify(resolveExtractOptions(opts))}`;
  return `(() => { ${shim}return (${source})(${args}); })()`;
}
