/**
 * Tests for Discord read_messages: scroll-and-collect backfill with the
 * bounded-scan envelope.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import type { DiscordMessage, ExtractResult } from "../src/plugins/transport/discord-dom.js";
import {
  DISCORD_HISTORY_SELECTORS,
  buildScrollStepExpression,
  olderThan,
  readMessages,
  scrollStep,
  type ScrollStepResult,
} from "../src/plugins/transport/discord-history.js";
import { channelPath, navigateExpression } from "../src/plugins/transport/discord-nav.js";
import { FakeNode, el } from "./helpers/fake-dom.js";

const CH = "1520443442982031486";
const G = "1210290974601773056";

function msg(n: number, extra: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: String(1_544_000_000_000_000_000n + BigInt(n)),
    channel_id: CH,
    author: "Alice",
    author_inherited: false,
    author_ref: null,
    timestamp: null,
    content: `m${n}`,
    reply_to: null,
    reply_label: null,
    reactions: [],
    attachments: [],
    embeds: [],
    links: [],
    edited: false,
    ...extra,
  };
}

function windowOf(msgs: DiscordMessage[], problem: string | null = null): ExtractResult {
  return { channel: { id: CH, label: "Test Friend" }, messages: msgs, count: msgs.length, scanned: msgs.length, truncated: false, problem };
}

/**
 * A fake page: `history` is oldest→newest; `mounted` rows grow by `perScroll`
 * on each scroll step, newest end first (like Discord).
 */
function fakePage(history: DiscordMessage[], initial: number, perScroll: number) {
  let mounted = Math.min(initial, history.length);
  const calls: string[] = [];
  const evaluate = async (expr: string): Promise<unknown> => {
    calls.push(expr);
    if (expr.startsWith("EXTRACT")) return windowOf(history.slice(history.length - mounted));
    if (expr.startsWith("SCROLL")) {
      const before = mounted;
      mounted = Math.min(history.length, mounted + perScroll);
      const r: ScrollStepResult = { before, after: mounted, moreAbove: mounted < history.length, problem: null };
      return r;
    }
    if (expr.includes("location.assign")) return true;
    if (expr.includes("chat-messages-")) return true; // mounted probe
    throw new Error(`unexpected expression ${expr.slice(0, 40)}`);
  };
  return { calls, evaluate, get mounted() { return mounted; } };
}

const deps = (page: ReturnType<typeof fakePage>) => ({
  evaluate: page.evaluate,
  sleep: async () => {},
  extractExpression: () => "EXTRACT",
  scrollExpression: () => "SCROLL",
});

const history = Array.from({ length: 120 }, (_, i) => msg(i));

// --- olderThan ---

test("olderThan compares snowflakes numerically, not lexically", () => {
  assert.equal(olderThan("999", "1000"), true);
  assert.equal(olderThan("1000", "999"), false);
  assert.equal(olderThan("1544000000000000010", "1544000000000000009"), false);
});

// --- readMessages ---

test("fills limit from the mounted window without scrolling when possible", async () => {
  const page = fakePage(history, 50, 30);
  const r = await readMessages(deps(page), { channel_id: CH, limit: 20 });
  assert.equal(r.stop_reason, "filled");
  assert.equal(r.complete, true);
  assert.equal(r.truncated, false);
  assert.equal(r.count, 20);
  assert.equal(r.messages[0].content, "m119", "newest first");
  assert.equal(r.messages[19].content, "m100");
  assert.equal(r.cursor, msg(100).id);
  assert.equal(page.calls.filter((c) => c === "SCROLL").length, 0);
  assert.deepEqual(r.channel, { id: CH, label: "Test Friend" });
});

test("scrolls to backfill until limit is filled, deduplicating overlapping windows", async () => {
  const page = fakePage(history, 20, 30);
  const r = await readMessages(deps(page), { channel_id: CH, limit: 70 });
  assert.equal(r.stop_reason, "filled");
  assert.equal(r.count, 70);
  assert.equal(new Set(r.messages.map((m) => m.id)).size, 70, "no duplicates");
  assert.equal(r.messages[69].content, "m50");
  assert.equal(page.calls.filter((c) => c === "SCROLL").length, 2);
});

test("reaching the beginning of the channel is complete with fewer messages than limit", async () => {
  const page = fakePage(history.slice(0, 35), 20, 30);
  const r = await readMessages(deps(page), { channel_id: CH, limit: 100 });
  assert.equal(r.stop_reason, "beginning");
  assert.equal(r.complete, true);
  assert.equal(r.truncated, false);
  assert.equal(r.count, 35);
});

test("before returns only older messages and jumps to the cursor when opening", async () => {
  const page = fakePage(history, 120, 30);
  const before = msg(60).id;
  const r = await readMessages(deps(page), { channel_id: CH, guild_id: G, before, limit: 10 });
  assert.equal(r.messages[0].content, "m59");
  assert.equal(r.messages[9].content, "m50");
  assert.ok(r.messages.every((m) => olderThan(m.id, before)));
  const nav = page.calls.find((c) => c.includes("location.assign"));
  assert.ok(nav?.includes(`/channels/${G}/${CH}/${before}`), "navigation jumps to the cursor message");
});

test("resuming with the cursor continues without gaps or duplicates", async () => {
  const page = fakePage(history, 120, 30);
  const first = await readMessages(deps(page), { channel_id: CH, limit: 25 });
  const second = await readMessages(deps(page), { channel_id: CH, limit: 25, before: first.cursor });
  const ids = [...first.messages, ...second.messages].map((m) => m.content);
  assert.deepEqual(ids, Array.from({ length: 50 }, (_, i) => `m${119 - i}`));
});

test("scan_cap stops the op as truncated with a cursor", async () => {
  const page = fakePage(history, 20, 30);
  const r = await readMessages(deps(page), { channel_id: CH, limit: 100, scan_cap: 60 });
  assert.equal(r.stop_reason, "scan_cap");
  assert.equal(r.complete, false);
  assert.equal(r.truncated, true);
  assert.ok(r.count > 0 && r.count < 100);
  assert.equal(r.cursor, r.messages[r.messages.length - 1].id);
});

test("time budget stops the op as truncated", async () => {
  const page = fakePage(history, 20, 30);
  let t = 0;
  const r = await readMessages({ ...deps(page), now: () => (t += 700) }, { channel_id: CH, limit: 100, time_budget_ms: 1000 });
  assert.equal(r.stop_reason, "time_budget");
  assert.equal(r.truncated, true);
});

test("no growth despite a loading placeholder stops after three tries, never spins", async () => {
  const page = fakePage(history, 20, 0);
  const r = await readMessages(deps(page), { channel_id: CH, limit: 100 });
  assert.equal(r.stop_reason, "no_growth");
  assert.equal(r.truncated, true);
  assert.equal(page.calls.filter((c) => c === "SCROLL").length, 3);
});

test("an extractor problem with no messages surfaces as a problem", async () => {
  const evaluate = async (expr: string): Promise<unknown> => {
    if (expr === "EXTRACT") return windowOf([], "More than one message list is mounted");
    return true;
  };
  const r = await readMessages({ evaluate, sleep: async () => {}, extractExpression: () => "EXTRACT", scrollExpression: () => "SCROLL" }, { channel_id: CH });
  assert.equal(r.stop_reason, "problem");
  assert.match(r.problem ?? "", /More than one/);
  assert.equal(r.count, 0);
  assert.equal(r.cursor, null);
});

test("grouped authors are resolved across windows from author_ref", async () => {
  const head = msg(10, { author: "Bob" });
  const tail = msg(11, { author: null, author_inherited: false, author_ref: head.id });
  const page = fakePage([...history.slice(0, 10), head, tail, ...history.slice(12)], 120, 30);
  const r = await readMessages(deps(page), { channel_id: CH, limit: 120 });
  const resolved = r.messages.find((m) => m.id === tail.id);
  assert.equal(resolved?.author, "Bob");
  assert.equal(resolved?.author_inherited, true);
});

test("parameters are validated before anything is evaluated", async () => {
  const calls: string[] = [];
  const evaluate = async (e: string): Promise<unknown> => { calls.push(e); return true; };
  await assert.rejects(readMessages({ evaluate }, { channel_id: "nope" }), /snowflake/);
  await assert.rejects(readMessages({ evaluate }, { channel_id: CH, before: "x" }), /message id/);
  await assert.rejects(readMessages({ evaluate }, { channel_id: CH, guild_id: "1" }), /snowflake/);
  assert.equal(calls.length, 0);
});

// --- scrollStep in the fake DOM ---

function scrollerPage(rows: number, moreAbove: boolean) {
  const list = el("ol", { "data-list-id": "chat-messages" },
    ...(moreAbove ? [el("div", { class: "wrapper_x" }, el("div", { class: "blob_x" }))] : []),
    ...Array.from({ length: rows }, (_, i) => el("li", { id: `chat-messages-${CH}-${1000 + i}` })));
  const scroller = el("div", { class: "scroller_abc customTheme_abc" }, list) as FakeNode & { scrollTop: number; scrollHeight: number };
  scroller.scrollTop = 0;
  scroller.scrollHeight = 4000;
  return { root: el("html", {}, el("body", {}, scroller)), scroller, list };
}

test("scrollStep moves the scroller, returns to the top, and reports growth and moreAbove", async () => {
  const { root, scroller, list } = scrollerPage(5, true);
  const moves: number[] = [];
  Object.defineProperty(scroller, "scrollTop", { get: () => moves[moves.length - 1] ?? 0, set: (v: number) => { moves.push(v); if (v === 0) list.append(el("li", { id: `chat-messages-${CH}-999` })); } });
  const r = await scrollStep(root, DISCORD_HISTORY_SELECTORS, { growWaitMs: 500, pollMs: 10 });
  assert.deepEqual(r, { before: 5, after: 6, moreAbove: true, problem: null });
  assert.ok(moves[0] > 0 && moves[moves.length - 1] === 0, "a real movement, then back to the top");
});

test("scrollStep reports no growth and no more history at the beginning", async () => {
  const { root } = scrollerPage(3, false);
  const r = await scrollStep(root, DISCORD_HISTORY_SELECTORS, { growWaitMs: 30, pollMs: 10 });
  assert.deepEqual(r, { before: 3, after: 3, moreAbove: false, problem: null });
});

test("scrollStep without a list or scroller is a problem", async () => {
  const r = await scrollStep(el("html", {}), DISCORD_HISTORY_SELECTORS, { growWaitMs: 10, pollMs: 5 });
  assert.match(r.problem ?? "", /No message list/);
});

test("scrollStep expression runs verbatim in a bare context with a document-shaped root", async () => {
  const { root } = scrollerPage(2, false);
  const expr = buildScrollStepExpression({ growWaitMs: 20, pollMs: 5 });
  assert.ok(!/\brequire\(|\bimport\b/.test(expr));
  const ctx = { document: { querySelector: (q: string) => root.querySelector(q), querySelectorAll: (q: string) => root.querySelectorAll(q) }, setTimeout, Promise, Math };
  const r = await vm.runInNewContext(expr, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { before: 2, after: 2, moreAbove: false, problem: null });
});

// --- navigation anchor ---

test("channelPath accepts an anchor message and navigateExpression allows it", () => {
  const p = channelPath({ guildId: G, channelId: CH, messageId: msg(5).id });
  assert.equal(p, `/channels/${G}/${CH}/${msg(5).id}`);
  assert.doesNotThrow(() => navigateExpression(p));
  assert.throws(() => channelPath({ channelId: CH, messageId: "x" }), /snowflake/);
});
