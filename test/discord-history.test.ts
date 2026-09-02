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
  buildMountedCountExpression,
  buildScrollNudgeExpression,
  mountedCount,
  olderThan,
  readMessages,
  scrollNudge,
  scrollStep,
  type ScrollStepOutcome,
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
      const r: ScrollStepOutcome = { before, after: mounted, moreAbove: mounted < history.length, problem: null };
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
  scrollStep: (ev: (e: string) => Promise<unknown>) => ev("SCROLL") as Promise<ScrollStepOutcome>,
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
  const r = await readMessages({ evaluate, sleep: async () => {}, extractExpression: () => "EXTRACT", scrollStep: async () => ({ before: 0, after: 0, moreAbove: false, problem: null }) }, { channel_id: CH });
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

// --- scrollNudge / mountedCount in the fake DOM; scrollStep with a fake evaluate ---

function scrollerPage(rows: number, moreAbove: boolean) {
  const list = el("ol", { "data-list-id": "chat-messages" },
    ...(moreAbove ? [el("div", { class: "wrapper_x" }, el("div", { class: "blob_x" }))] : []),
    ...Array.from({ length: rows }, (_, i) => el("li", { id: `chat-messages-${CH}-${1000 + i}` })));
  const sidebarScroller = el("div", { class: "scroller_abc" }, el("ul", {}, el("li", {}, "dm"))) as FakeNode & { scrollTop: number };
  sidebarScroller.scrollTop = 0;
  const scroller = el("div", { class: "scroller_abc customTheme_abc" }, list) as FakeNode & { scrollTop: number; scrollHeight: number };
  scroller.scrollTop = 0;
  scroller.scrollHeight = 4000;
  const outer = el("div", { class: "scrollerBase_abc" }, sidebarScroller, scroller) as FakeNode & { scrollTop: number };
  outer.scrollTop = 0;
  return { root: el("html", {}, el("body", {}, outer)), scroller, sidebarScroller, outer, list };
}

test("scrollNudge moves the innermost scroller containing the list, then returns to the top", () => {
  const { root, scroller, sidebarScroller, outer } = scrollerPage(5, true);
  const moves: number[] = [];
  Object.defineProperty(scroller, "scrollTop", { get: () => moves[moves.length - 1] ?? 0, set: (v: number) => { moves.push(v); } });
  const r = scrollNudge(root, DISCORD_HISTORY_SELECTORS);
  assert.deepEqual(r, { count: 5, moreAbove: true, problem: null });
  assert.deepEqual(moves.map((m) => m > 0), [true, false], "a real movement, then back to the top");
  assert.equal(sidebarScroller.scrollTop, 0, "the DM sidebar scroller is never touched");
  assert.equal(outer.scrollTop, 0, "the outer container is never touched");
});

test("mountedCount reports rows and whether more history is indicated", () => {
  const { root } = scrollerPage(3, false);
  assert.deepEqual(mountedCount(root, DISCORD_HISTORY_SELECTORS), { count: 3, moreAbove: false, problem: null });
});

test("nudge and count without a list are problems", () => {
  assert.match(scrollNudge(el("html", {}), DISCORD_HISTORY_SELECTORS).problem ?? "", /No message list/);
  assert.match(mountedCount(el("html", {}), DISCORD_HISTORY_SELECTORS).problem ?? "", /No message list/);
});

test("nudge and count expressions run verbatim in a bare context and are synchronous", () => {
  const { root } = scrollerPage(2, false);
  const ctx = { document: { querySelector: (q: string) => root.querySelector(q), querySelectorAll: (q: string) => root.querySelectorAll(q) } };
  for (const expr of [buildScrollNudgeExpression(), buildMountedCountExpression()]) {
    assert.ok(!/\brequire\(|\bimport\b|setTimeout|Promise/.test(expr), "no module references and no in-page waiting");
    const r = vm.runInNewContext(expr, ctx);
    assert.deepEqual(JSON.parse(JSON.stringify(r)), { count: 2, moreAbove: false, problem: null });
  }
});

test("scrollStep waits on the Node side and stops as soon as the count grows", async () => {
  let count = 10;
  let polls = 0;
  const evaluate = async (expr: string): Promise<unknown> => {
    if (expr === "NUDGE") return { count, moreAbove: true, problem: null };
    polls++;
    if (polls === 2) count = 40;
    return { count, moreAbove: true, problem: null };
  };
  let t = 0;
  const r = await scrollStep(evaluate, { nudgeExpression: "NUDGE", countExpression: "COUNT", sleep: async () => { t += 300; }, now: () => t, growWaitMs: 3000, pollMs: 300 });
  assert.deepEqual(r, { before: 10, after: 40, moreAbove: true, problem: null });
  assert.equal(polls, 2);
});

test("scrollStep gives up after growWaitMs and reports moreAbove from the last count", async () => {
  const evaluate = async (expr: string): Promise<unknown> => ({ count: 10, moreAbove: expr !== "NUDGE" ? false : true, problem: null });
  let t = 0;
  const r = await scrollStep(evaluate, { nudgeExpression: "NUDGE", countExpression: "COUNT", sleep: async () => { t += 1000; }, now: () => t, growWaitMs: 3000, pollMs: 1000 });
  assert.deepEqual(r, { before: 10, after: 10, moreAbove: false, problem: null });
});

test("scrollStep surfaces a nudge problem without polling", async () => {
  let polls = 0;
  const evaluate = async (expr: string): Promise<unknown> => { if (expr !== "NUDGE") polls++; return { count: 0, moreAbove: false, problem: "No message scroller found." }; };
  const r = await scrollStep(evaluate, { nudgeExpression: "NUDGE", countExpression: "COUNT", sleep: async () => {} });
  assert.match(r.problem ?? "", /scroller/);
  assert.equal(polls, 0);
});

// --- navigation anchor ---

test("channelPath accepts an anchor message and navigateExpression allows it", () => {
  const p = channelPath({ guildId: G, channelId: CH, messageId: msg(5).id });
  assert.equal(p, `/channels/${G}/${CH}/${msg(5).id}`);
  assert.doesNotThrow(() => navigateExpression(p));
  assert.throws(() => channelPath({ channelId: CH, messageId: "x" }), /snowflake/);
});
