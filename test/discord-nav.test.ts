/**
 * Tests for Discord listing and navigation against fixtures built from the
 * sidebar markup observed on discord.com (2026-09-02).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  DISCORD_NAV_SELECTORS,
  buildListExpression,
  channelPath,
  isSnowflake,
  listChannels,
  listDms,
  listGuilds,
  mountedExpression,
  navigateExpression,
  openChannel,
  resolveListOptions,
} from "../src/plugins/transport/discord-nav.js";
import type { DomRoot } from "../src/plugins/transport/discord-dom.js";
import { FakeNode, el } from "./helpers/fake-dom.js";

const G = "1210290974601773056";
const C1 = "1210290975000000001";
const C2 = "1210290975000000002";
const V1 = "1210290975000000003";
const DM1 = "1520443442982031486";
const DM2 = "1520443442982031487";
const DM3 = "1520443442982031488";
const SEL = DISCORD_NAV_SELECTORS;
const OPTS = resolveListOptions({});

function documentShaped(root: FakeNode): DomRoot {
  return { querySelector: (q: string) => root.querySelector(q), querySelectorAll: (q: string) => root.querySelectorAll(q) };
}

// --- Fixtures ---

function dmRow(href: string | null, label: string, name: string, unread = false, itemId = "x"): FakeNode {
  const inner = href
    ? el("a", { class: "link_c8ddc0", href, "data-list-item-id": `private-channels-uid_11___${itemId}`, "aria-label": label },
        el("div", { class: "layout_c8ddc0" }, el("div", { class: "content_c8ddc0" },
          el("div", { class: "nameAndDecorators_c8ddc0" }, el("div", { class: "name_c8ddc0 text-md/medium" }, name)),
          ...(unread ? [el("div", { class: "numberBadge_c8ddc0" }, "2")] : []),
        )))
    : el("div", { class: "interactive_c8ddc0 linkButton_c8ddc0" }, el("div", { class: "name_c8ddc0" }, name));
  return el("li", { class: "channel_c8ddc0 dm_c8ddc0 container_c8ddc0", role: "listitem" }, el("div", { class: "interactive_c8ddc0" }, inner));
}

function dmSidebar(): FakeNode {
  return el("div", { "data-list-id": "private-channels-uid_11" },
    dmRow(null, "", "Friends"),
    dmRow(null, "", "Nitro"),
    dmRow(`/channels/@me/${DM1}`, "Nate Aune (direct message), Online", "Nate Aune", false, DM1),
    dmRow(`/channels/@me/${DM2}`, "Alice, Bob (group message)", "Alice, Bob", true, DM2),
    dmRow(`/channels/@me/${DM3}`, "Carl-bot (direct message)", "Carl-bot", false, DM3),
    dmRow("/channels/@me/not-a-snowflake", "Broken (direct message)", "Broken", false, "z"),
  );
}

function guildItem(itemId: string, hidden: string): FakeNode {
  return el("div", { class: "wrapper_e1a5e5", role: "treeitem", "data-list-item-id": itemId },
    el("span", { class: "hiddenVisually_e1a5e5" }, hidden),
    el("img", { class: "icon_e1a5e5", alt: " ", "aria-hidden": "true" }));
}

function guildRail(): FakeNode {
  return el("div", { "data-list-id": "guildsnav", role: "tree" },
    guildItem("guildsnav___home", "Direct Messages"),
    guildItem(`guildsnav___${G}`, "Unread messages, Sundai"),
    guildItem("guildsnav___1210290974601773057", "Dollhouse MCP"),
    guildItem("guildsnav___folder-abc", "Folder"),
    guildItem("guildsnav___1210290974601773058", "23 mentions, Postman"),
    guildItem("guildsnav___1210290974601773059", "1 mention, LM Studio"),
  );
}

function channelEntry(id: string, name: string, kind: string, guild = G): FakeNode {
  return el("li", { class: "containerDefault_f37cb1", "data-dnd-name": name },
    el("div", { class: "iconVisibility_f37cb1 wrapper_f37cb1" }, el("div", {},
      el("a", { href: `/channels/${guild}/${id}`, role: "link", class: "link_f37cb1", "data-list-item-id": `channels___${id}`, "aria-label": `${name} (${kind})` },
        el("div", { class: "linkTop_f37cb1" }, el("div", { class: "name_f37cb1 overflow_f37cb1" }, el("span", {}, name)))))));
}

function categoryEntry(id: string, name: string): FakeNode {
  return el("li", { class: "containerDefault_f37cb1", "data-dnd-name": name },
    el("div", { class: "iconVisibility_f37cb1 wrapper_f37cb1" },
      el("div", { class: "mainContent_f37cb1", "data-list-item-id": `channels___${id}`, "aria-label": `${name} (category)`, "aria-expanded": "true", role: "button" },
        el("h3", { class: "name_f37cb1" }, el("div", { class: "overflow_f37cb1" }, name)))));
}

function channelSidebar(): FakeNode {
  return el("nav", { "aria-label": "Sundai (server)" },
    el("header", {}, el("h1", { class: "name_a1b2c3" }, "Sundai")),
    el("ul", { "aria-label": "Channels" },
      channelEntry(C1, "announcements", "announcements channel"),
      categoryEntry("1210290975000000010", "Voice Chat"),
      channelEntry(V1, "General", "voice channel"),
      categoryEntry("1210290975000000011", "Projects"),
      channelEntry(C2, "event-concierge", "text channel"),
    ));
}

function page(...parts: FakeNode[]): FakeNode {
  return el("html", {}, el("body", {}, ...parts));
}

// --- listDms ---

test("listDms returns only real conversations with ids, names, kind, status, unread", () => {
  const r = listDms(page(dmSidebar()), SEL, OPTS);
  assert.equal(r.problem, null);
  assert.equal(r.count, 3);
  assert.deepEqual(r.items[0], { id: DM1, name: "Nate Aune", kind: "direct message", status: "Online", unread: false });
  assert.deepEqual(r.items[1], { id: DM2, name: "Alice, Bob", kind: "group message", status: null, unread: true });
  assert.equal(r.items[2].id, DM3);
  assert.equal(r.truncated, false);
});

test("listDms honors limit and flags truncation", () => {
  const r = listDms(page(dmSidebar()), SEL, resolveListOptions({ limit: 2 }));
  assert.equal(r.count, 2);
  assert.equal(r.truncated, true);
});

test("listDms without the sidebar is a problem, not empty success", () => {
  assert.match(listDms(page(), SEL, OPTS).problem ?? "", /No DM sidebar/);
});

// --- listGuilds ---

test("listGuilds skips home and folders, strips unread prefixes, keeps the raw label", () => {
  const r = listGuilds(page(guildRail()), SEL, OPTS);
  assert.equal(r.problem, null);
  assert.deepEqual(r.items.map((g) => [g.id, g.name]), [
    [G, "Sundai"],
    ["1210290974601773057", "Dollhouse MCP"],
    ["1210290974601773058", "Postman"],
    ["1210290974601773059", "LM Studio"],
  ]);
  assert.equal(r.items[0].raw_label, "Unread messages, Sundai");
});

test("listGuilds without the rail is a problem", () => {
  assert.match(listGuilds(page(), SEL, OPTS).problem ?? "", /No server rail/);
});

// --- listChannels ---

test("listChannels returns channels with kind and enclosing category, plus the guild", () => {
  const r = listChannels(page(guildRail(), channelSidebar()), SEL, OPTS);
  assert.equal(r.problem, null);
  assert.deepEqual(r.guild, { id: G, name: "Sundai" });
  assert.deepEqual(r.items.map((c) => [c.id, c.name, c.kind, c.category]), [
    [C1, "announcements", "announcements channel", null],
    [V1, "General", "voice channel", "Voice Chat"],
    [C2, "event-concierge", "text channel", "Projects"],
  ]);
  assert.equal(r.items[2].href, `/channels/${G}/${C2}`);
});

test("listChannels without a sidebar is a problem", () => {
  const r = listChannels(page(guildRail()), SEL, OPTS);
  assert.match(r.problem ?? "", /No channel sidebar/);
});

// --- Expression builders: self-contained, run bare, regex selector survives ---

test("each listing expression runs verbatim in a bare context and equals the direct call", () => {
  const root = page(guildRail(), dmSidebar(), channelSidebar());
  const direct = {
    listDms: listDms(root, SEL, OPTS),
    listGuilds: listGuilds(root, SEL, OPTS),
    listChannels: listChannels(root, SEL, OPTS),
  };
  for (const fn of ["listDms", "listGuilds", "listChannels"] as const) {
    const expr = buildListExpression(fn);
    assert.ok(!/\brequire\(|\bimport\b/.test(expr));
    const helpers = new Set(expr.match(/__[a-zA-Z]+\(/g) ?? []);
    helpers.delete("__name(");
    assert.deepEqual([...helpers], []);
    const viaPage = vm.runInNewContext(expr, { document: documentShaped(root) });
    assert.deepEqual(JSON.parse(JSON.stringify(viaPage)), JSON.parse(JSON.stringify(direct[fn])), fn);
  }
});

test("every selector-valued table entry parses in the fake DOM grammar", () => {
  const probe = el("div", {});
  for (const [key, value] of Object.entries(SEL)) {
    if (typeof value !== "string" || /Prefix$|Id$/.test(key)) continue;
    assert.doesNotThrow(() => probe.querySelectorAll(value), `selector ${key} = ${value}`);
  }
});

// --- Navigation ---

test("isSnowflake accepts only numeric ids of plausible length", () => {
  assert.equal(isSnowflake(G), true);
  assert.equal(isSnowflake("123"), false);
  assert.equal(isSnowflake('1"]'), false);
  assert.equal(isSnowflake(123), false);
});

test("channelPath builds only same-origin paths from validated ids", () => {
  assert.equal(channelPath({ channelId: DM1 }), `/channels/@me/${DM1}`);
  assert.equal(channelPath({ guildId: G, channelId: C1 }), `/channels/${G}/${C1}`);
  assert.throws(() => channelPath({ channelId: "https://evil.example" }), /snowflake/);
  assert.throws(() => channelPath({ guildId: "../x", channelId: C1 }), /snowflake/);
});

test("navigateExpression refuses anything that did not come from channelPath", () => {
  assert.throws(() => navigateExpression("https://evil.example/"), /channelPath/);
  assert.throws(() => navigateExpression("/channels/@me/1/../../x"), /channelPath/);
  assert.match(navigateExpression(`/channels/@me/${DM1}`), /location\.assign\("\/channels\/@me\/\d+"\)/);
});

test("mountedExpression is true for a row of the channel or an empty list at the channel's location", () => {
  const expr = mountedExpression(C1);
  assert.match(expr, new RegExp(`chat-messages-${C1}-`));
  assert.throws(() => mountedExpression("nope"), /snowflake/);
  const run = (rows: string[], pathname: string): boolean => {
    const list = el("ol", { "data-list-id": "chat-messages" }, ...rows.map((id) => el("li", { id: `chat-messages-${C1}-${id}` })));
    const root = el("html", {}, list);
    return vm.runInNewContext(expr, { document: { querySelector: (q: string) => root.querySelector(q) }, location: { pathname } }) as boolean;
  };
  assert.equal(run([DM1], "/channels/@me/other"), true, "a row of the channel is enough");
  assert.equal(run([], `/channels/${G}/${C1}`), true, "an empty channel at its own location is mounted");
  assert.equal(run([], `/channels/${G}/${C1}/${DM1}`), true, "with an anchor message too");
  assert.equal(run([], `/channels/${G}/${C2}`), false, "another channel's empty list is not");
  assert.equal(run([], `/channels/${G}/${C1}0`), false, "prefix of another id is not");
});

test("openChannel bounds every evaluate by the remaining budget", async () => {
  const budgets: number[] = [];
  const evaluate = async (_e: string, o?: { timeoutMs?: number }): Promise<unknown> => { budgets.push(o?.timeoutMs ?? -1); return false; };
  await assert.rejects(openChannel(evaluate, { channelId: DM1 }, { sleep: noSleep, timeoutMs: 50, pollMs: 0 }), /did not open/);
  assert.ok(budgets.length >= 2);
  assert.ok(budgets.every((b) => b >= 200 && b <= 50 + 200), `budgets ${budgets.join(",")}`);
});

function fakeEvaluate(script: (calls: string[]) => (expr: string) => unknown) {
  const calls: string[] = [];
  const handler = script(calls);
  const evaluate = async (expr: string): Promise<unknown> => {
    calls.push(expr);
    const r = handler(expr);
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, evaluate };
}

const noSleep = async (): Promise<void> => {};

test("openChannel short-circuits when the channel is already mounted", async () => {
  const { calls, evaluate } = fakeEvaluate(() => (expr) => expr.includes("chat-messages-") ? true : false);
  const r = await openChannel(evaluate, { channelId: DM1 }, { sleep: noSleep });
  assert.equal(r.alreadyOpen, true);
  assert.equal(calls.length, 1);
  assert.ok(!calls.some((c) => c.includes("location.assign")));
});

test("openChannel navigates, tolerates the context being destroyed, and polls until mounted", async () => {
  let polls = 0;
  const { calls, evaluate } = fakeEvaluate(() => (expr) => {
    if (expr.includes("location.assign")) return new Error("Execution context was destroyed");
    polls++;
    return polls >= 3; // first probe false, then two failed polls, then mounted
  });
  const r = await openChannel(evaluate, { guildId: G, channelId: C2 }, { sleep: noSleep, timeoutMs: 5000 });
  assert.equal(r.alreadyOpen, false);
  assert.equal(r.path, `/channels/${G}/${C2}`);
  assert.equal(calls.filter((c) => c.includes("location.assign")).length, 1);
});

test("openChannel fails with a named error when the channel never mounts", async () => {
  const { evaluate } = fakeEvaluate(() => () => false);
  await assert.rejects(
    openChannel(evaluate, { channelId: DM1 }, { sleep: noSleep, timeoutMs: 1, pollMs: 0 }),
    /did not open within 1ms/,
  );
});

test("openChannel never evaluates an unvalidated id", async () => {
  const { calls, evaluate } = fakeEvaluate(() => () => true);
  await assert.rejects(openChannel(evaluate, { channelId: "evil" }), /snowflake/);
  assert.equal(calls.length, 0);
});
