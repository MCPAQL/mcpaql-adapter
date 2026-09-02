/**
 * Tests for the Discord DOM extractor against a fixture built from the
 * markup observed on discord.com (2026-09-02).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  DISCORD_SELECTORS,
  buildExtractMessagesExpression,
  extractMessages,
} from "../src/plugins/transport/discord-dom.js";
import { FakeNode, el } from "./helpers/fake-dom.js";

const CH = "1520443442982031486";
const A = "1544685390995132426";
const B = "1544699967019425842";
const C = "1544728164323041340";
const D = "1544806458888028301";

const LONG = "This message is deliberately longer than one hundred characters so that we can prove the extractor does not truncate the way the accessibility tree does. ";

function timeNode(id: string, iso: string): FakeNode {
  return el("span", { class: "timestamp_c19a55" }, el("span", {}, el("time", { id: `message-timestamp-${id}`, datetime: iso }, el("i", { class: "separator_c19a55", "aria-hidden": "true" }, " — "), "8:28 AM")));
}

function article(id: string, labelledBy: string, ...kids: FakeNode[]): FakeNode {
  return el("div", { role: "article", "aria-roledescription": "Message", "data-list-item-id": `chat-messages___chat-messages-${CH}-${id}`, "aria-labelledby": labelledBy }, ...kids);
}

function li(id: string, ...kids: FakeNode[]): FakeNode {
  return el("li", { id: `chat-messages-${CH}-${id}`, class: "messageListItem__5126c" }, ...kids);
}

/** Message A: group start by Alice, long text, emoji image, line break, mention, link. */
function messageA(): FakeNode {
  return li(A, article(A, `message-username-${A} uid_3 message-content-${A} u`,
    el("div", { class: "contents_c19a55" },
      el("img", { "aria-hidden": "true", class: "avatar_c19a55 clickable_c19a55" }),
      el("h3", { class: "header_c19a55", "aria-labelledby": `message-username-${A} message-timestamp-${A}` },
        el("span", { id: `message-username-${A}`, class: "headerText_c19a55" }, el("span", { class: "username_c19a55 clickable_c19a55", role: "button" }, "Alice")),
        timeNode(A, "2026-09-02T12:28:16.148Z"),
      ),
      el("div", { id: `message-content-${A}`, class: "markup__75297 messageContent_c19a55" },
        el("span", {}, LONG),
        el("img", { class: "emoji", "data-type": "emoji", "data-name": ":wink:", alt: "😉", src: "/assets/x.svg" }),
        el("br", {}),
        el("span", { class: "mention_a7e6f7 interactive_a7e6f7", role: "link" }, "@Bob"),
        " see ",
        el("a", { href: "https://example.com/spec", class: "anchor_edefb8", role: "link" }, "https://example.com/spec"),
      ),
    ),
    el("div", { id: `message-accessories-${A}`, class: "container_b7e1cb" }),
  ));
}

/** Message B: continuation of Alice's group (no h3), with an image attachment. */
function messageB(): FakeNode {
  return li(B, article(B, `message-username-${A} uid_3 message-content-${B} m`,
    el("div", { class: "contents_c19a55" },
      el("span", { class: "latin24CompactTimeStamp_c19a55 timestamp_c19a55" }, el("span", {}, el("time", { id: `message-timestamp-${B}`, datetime: "2026-09-02T13:26:11.268Z" }, "9:26 AM"))),
      el("div", { id: `message-content-${B}`, class: "markup__75297 messageContent_c19a55" }, el("span", {}, "lol")),
    ),
    el("div", { id: `message-accessories-${B}`, class: "container_b7e1cb" },
      el("div", { class: "visualMediaItemContainer_c8c8c8" },
        el("a", { "aria-hidden": "true", class: "originalLink_af017a", href: `https://cdn.discordapp.com/attachments/${CH}/${B}/image0.jpg?ex=1&is=2&hm=3` }),
        el("div", { class: "clickableWrapper_af017a", "aria-label": "Image", role: "button" },
          el("img", { class: "lazyImg_af017a", alt: "Image", src: `https://media.discordapp.net/attachments/${CH}/${B}/image0.jpg?width=1&height=1` }),
        ),
      ),
    ),
  ));
}

/** Message C: Bob replies to A, two reactions (one by me), edited. */
function messageC(): FakeNode {
  return li(C, article(C, `message-reply-context-${C} uid_3 message-content-${C} u`,
    el("div", { id: `message-reply-context-${C}`, class: "repliedMessage_c19a55", "aria-label": "Bob replying to Alice" },
      el("div", { class: "repliedMessageClickableSpine_c19a55", "aria-label": "Jump To Reply", role: "button" }),
      el("span", { class: "username_c19a55 clickable_c19a55", role: "button" }, "Alice"),
      el("div", { class: "repliedTextPreview_c19a55 clickable_c19a55", role: "button" },
        el("div", { id: `message-content-${A}`, class: "repliedTextContent_c19a55 markup__75297 messageContent_c19a55" }, el("span", {}, "This message is deliberately longer…")),
      ),
    ),
    el("div", { class: "contents_c19a55" },
      el("img", { "aria-hidden": "true", class: "avatar_c19a55" }),
      el("h3", { class: "header_c19a55", "aria-labelledby": `message-username-${C} message-timestamp-${C}` },
        el("span", { id: `message-username-${C}`, class: "headerText_c19a55" }, el("span", { class: "username_c19a55", role: "button" }, "Bob")),
        timeNode(C, "2026-09-02T13:41:56.499Z"),
      ),
      el("div", { id: `message-content-${C}`, class: "markup__75297 messageContent_c19a55" },
        el("span", {}, "oops.. you're right - my bad."),
        el("span", { class: "edited_c19a55" }, " (edited)"),
      ),
    ),
    el("div", { id: `message-accessories-${C}`, class: "container_b7e1cb" },
      el("div", { class: "reactions_ec6b19", role: "group", id: `message-reactions-${C}` },
        el("div", {}),
        el("div", {},
          el("div", { class: "reaction_ec6b19 reactionMe_ec6b19" },
            el("div", { class: "reactionInner_ec6b19", "aria-label": "laughing, 1 reaction, press to remove your reaction", role: "button" },
              el("div", {}, el("img", { class: "emoji", "data-type": "emoji", alt: "😆" })),
              el("div", { class: "reactionCount_ec6b19" }, "1"),
            ),
          ),
          el("div", { class: "reaction_ec6b19" },
            el("div", { class: "reactionInner_ec6b19", "aria-label": "thumbsup, 3 reactions, press to react", role: "button" },
              el("div", {}, el("img", { class: "emoji", "data-type": "emoji", alt: "👍" })),
              el("div", { class: "reactionCount_ec6b19" }, "3"),
            ),
          ),
        ),
      ),
    ),
  ));
}

/** Message D: Alice again (new group), link embed. */
function messageD(): FakeNode {
  return li(D, article(D, `message-username-${D} uid_3 message-content-${D} u`,
    el("div", { class: "contents_c19a55" },
      el("h3", { class: "header_c19a55" },
        el("span", { id: `message-username-${D}`, class: "headerText_c19a55" }, el("span", { class: "username_c19a55", role: "button" }, "Alice")),
        timeNode(D, "2026-09-02T20:29:20.915Z"),
      ),
      el("div", { id: `message-content-${D}`, class: "markup__75297 messageContent_c19a55" }, el("a", { href: "https://pdpp.dev/", role: "link" }, "https://pdpp.dev/")),
    ),
    el("div", { id: `message-accessories-${D}`, class: "container_b7e1cb" },
      el("article", { class: "embedFull_b0068a embed_b0068a markup__75297", "aria-hidden": "false" },
        el("div", { class: "gridContainer_b0068a" }, el("div", { class: "grid_b0068a" },
          el("div", { class: "embedProvider_b0068a" }, el("span", {}, "GitHub")),
          el("div", { class: "embedTitle_b0068a" }, el("a", { class: "embedTitleLink_b0068a", href: "https://pdpp.dev/", role: "link" }, "PDPP: Personal Data Portability Protocol")),
          el("div", { class: "embedDescription_b0068a" }, "An authorization and disclosure protocol for personal data."),
        )),
      ),
    ),
  ));
}

function divider(label: string): FakeNode {
  return el("li", { class: "divider_c2654d", role: "separator", "aria-label": label, "data-list-item-id": `chat-messages___divider-${label}` }, el("span", {}, label));
}

function fixture(): FakeNode {
  const list = el("ol", { class: "scrollerInner__36d07", "aria-label": "Messages in Test Friend", role: "list", "data-list-id": "chat-messages" },
    divider("September 2, 2026"), messageA(), messageB(), messageC(), messageD());
  return el("html", {}, el("body", {}, el("main", {}, list)));
}

// --- Fidelity ---

test("extracts every message and skips date dividers, oldest first", () => {
  const r = extractMessages(fixture(), DISCORD_SELECTORS, {});
  assert.equal(r.problem, null);
  assert.equal(r.count, 4);
  assert.deepEqual(r.messages.map((m) => m.id), [A, B, C, D]);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.channel, { id: CH, label: "Test Friend" });
});

test("content is complete: long text intact, emoji as alt, <br> as newline, mention and link text", () => {
  const [a] = extractMessages(fixture(), DISCORD_SELECTORS, {}).messages;
  assert.ok(a.content.startsWith(LONG.trim()), "long text must not be truncated");
  assert.ok(a.content.length > 150);
  assert.ok(a.content.includes("😉"));
  assert.ok(a.content.includes("\n@Bob see https://example.com/spec"));
  assert.deepEqual(a.links, ["https://example.com/spec"]);
  assert.equal(a.author, "Alice");
  assert.equal(a.author_inherited, false);
  assert.equal(a.timestamp, "2026-09-02T12:28:16.148Z");
  assert.equal(a.edited, false);
});

test("grouped message inherits its author from the group header and keeps its own timestamp", () => {
  const b = extractMessages(fixture(), DISCORD_SELECTORS, {}).messages[1];
  assert.equal(b.author, "Alice");
  assert.equal(b.author_inherited, true);
  assert.equal(b.timestamp, "2026-09-02T13:26:11.268Z");
  assert.equal(b.content, "lol");
});

test("attachments are URLs plus filenames, deduped, never downloaded", () => {
  const b = extractMessages(fixture(), DISCORD_SELECTORS, {}).messages[1];
  assert.equal(b.attachments.length, 1);
  assert.equal(b.attachments[0].filename, "image0.jpg");
  assert.match(b.attachments[0].url, /^https:\/\/cdn\.discordapp\.com\/attachments\//);
});

test("reply linkage points at the referenced message, not the reply preview text", () => {
  const c = extractMessages(fixture(), DISCORD_SELECTORS, {}).messages[2];
  assert.equal(c.reply_to, A);
  assert.equal(c.reply_label, "Bob replying to Alice");
  assert.equal(c.content, "oops.. you're right - my bad. (edited)");
  assert.equal(c.author, "Bob");
  assert.equal(c.edited, true);
});

test("reactions carry emoji, count, and whether the current user reacted", () => {
  const c = extractMessages(fixture(), DISCORD_SELECTORS, {}).messages[2];
  assert.deepEqual(c.reactions, [
    { emoji: "😆", count: 1, me: true },
    { emoji: "👍", count: 3, me: false },
  ]);
});

test("embeds carry provider, title, url, description", () => {
  const d = extractMessages(fixture(), DISCORD_SELECTORS, {}).messages[3];
  assert.deepEqual(d.embeds, [{
    provider: "GitHub",
    title: "PDPP: Personal Data Portability Protocol",
    url: "https://pdpp.dev/",
    description: "An authorization and disclosure protocol for personal data.",
  }]);
  assert.deepEqual(d.links, ["https://pdpp.dev/"]);
});

// --- Caps ---

test("maxMessages keeps the newest messages and flags truncation", () => {
  const r = extractMessages(fixture(), DISCORD_SELECTORS, { maxMessages: 2 });
  assert.deepEqual(r.messages.map((m) => m.id), [C, D]);
  assert.equal(r.truncated, true);
});

test("maxBytes stops extraction and flags truncation", () => {
  const r = extractMessages(fixture(), DISCORD_SELECTORS, { maxBytes: 1024 });
  assert.ok(r.count < 4);
  assert.equal(r.truncated, true);
});

test("a grouped message outside the cap window still resolves its author via the page", () => {
  // Only B (index 1) and later fit; B's header lives on A, which is outside the window.
  const r = extractMessages(fixture(), DISCORD_SELECTORS, { maxMessages: 3 });
  assert.deepEqual(r.messages.map((m) => m.id), [B, C, D]);
  assert.equal(r.messages[0].author, "Alice");
  assert.equal(r.messages[0].author_inherited, true);
});

// --- Failure shape ---

test("no message list yields a problem string, not an exception or empty success", () => {
  const r = extractMessages(el("html", {}, el("body", {}, "nothing")), DISCORD_SELECTORS, {});
  assert.equal(r.count, 0);
  assert.match(r.problem ?? "", /No message list/);
});

// --- Self-containment: the same source runs in the browser ---

test("extractor source is self-contained and runs verbatim in a bare context", () => {
  const expr = buildExtractMessagesExpression({ maxMessages: 10 });
  assert.ok(!/\brequire\(|\bimport\b/.test(expr), "no module references allowed");
  const helpers = new Set(expr.match(/__[a-zA-Z]+\(/g) ?? []);
  helpers.delete("__name(");
  assert.deepEqual([...helpers], [], "only the shimmed __name helper may appear");
  const direct = extractMessages(fixture(), DISCORD_SELECTORS, { maxMessages: 10 });
  const viaPage = vm.runInNewContext(expr, { document: fixture() });
  // The sandbox realm has its own Object prototype; compare by value.
  assert.deepEqual(JSON.parse(JSON.stringify(viaPage)), JSON.parse(JSON.stringify(direct)));
});

test("every selector in the table is used by the extractor", () => {
  const source = extractMessages.toString();
  for (const key of Object.keys(DISCORD_SELECTORS)) {
    assert.ok(source.includes(`sel.${key}`), `selector ${key} is declared but unused`);
  }
});
