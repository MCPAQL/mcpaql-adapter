/**
 * Discord `read_messages`: history backfill for the read-only Discord adapter.
 *
 * Discord lazy-loads older messages when the list is scrolled upward, and
 * keeps the scroll position when they arrive. There is no fetch-all. So the
 * op is a loop, driven from Node with short in-page steps:
 *
 *   open channel (jumping to the cursor message when resuming)
 *   → extract the mounted window → merge by id
 *   → scroll step (a real movement, then wait briefly for growth)
 *   → repeat until: `limit` filled below `before`, the beginning of the
 *     channel is reached, `scan_cap` rows examined, or `time_budget_ms` spent
 *
 * Every stop condition other than "filled" or "beginning" is reported as
 * `complete: false` with a resumable `cursor`. Never silent truncation.
 *
 * The result uses the repository's bounded-scan envelope (#35):
 * `{messages, count, scanned, cursor, complete, truncated, elapsed_ms}`.
 *
 * In-page steps are self-contained, synchronous functions shipped as their
 * own source. All waiting happens in Node: Chrome throttles timers in hidden
 * tabs, so an in-page wait can stall past a transport timeout.
 *
 * Read-only: the scroll step touches `scrollTop` of the message scroller
 * only. It never focuses, types, or clicks.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  DISCORD_SELECTORS,
  buildExtractMessagesExpression,
  type DiscordMessage,
  type DomNode,
  type DomRoot,
  type ExtractResult,
} from "./discord-dom.js";
import { isSnowflake, openChannel, type Evaluate } from "./discord-nav.js";

/** Selectors observed on discord.com, verified 2026-09-02. */
export const DISCORD_HISTORY_SELECTORS = {
  messageList: 'ol[data-list-id="chat-messages"]',
  messageItem: 'li[id^="chat-messages-"]',
  /** Placeholder rows Discord shows above the oldest mounted message while more history exists. */
  loadingSkeleton: '[class*="blob"]',
  /** Class stem of the scrollable ancestor of the message list. */
  scrollerClass: "scroller",
} as const;

export type DiscordHistorySelectors = typeof DISCORD_HISTORY_SELECTORS;

export interface ScrollStepResult {
  /** Mounted message rows at the moment of the nudge. */
  count: number;
  /** True when a loading placeholder is shown above the oldest row. */
  moreAbove: boolean;
  /** True when no scroller was found; the caller should stop. */
  problem: string | null;
}

/**
 * Nudge the message scroller: a real movement, then back to the top. This
 * is what makes Discord fetch older rows. Synchronous on purpose: Chrome
 * throttles timers in hidden tabs (to once per minute after a few minutes),
 * so any in-page waiting can stall for longer than a transport timeout.
 * The wait for growth happens on the Node side with {@link mountedCount}.
 * SELF-CONTAINED: shipped to the browser via `Function.prototype.toString`.
 */
export function scrollNudge(root: DomRoot, sel: DiscordHistorySelectors): ScrollStepResult {
  const list = root.querySelector(sel.messageList);
  if (!list) return { count: 0, moreAbove: false, problem: "No message list found." };
  // The scroller is the innermost scrollable ancestor of the list. DomNode has
  // no parent pointer, so pick the last scroller (document order puts
  // ancestors first) that contains the list.
  const candidates = Array.from(root.querySelectorAll(`[class*="${sel.scrollerClass}"]`)) as
    Array<DomNode & { scrollTop?: number; scrollHeight?: number }>;
  let scroller: (DomNode & { scrollTop?: number; scrollHeight?: number }) | null = null;
  for (const c of candidates) if (c.querySelector(sel.messageList) !== null) scroller = c;
  if (!scroller || typeof scroller.scrollTop !== "number") {
    return { count: 0, moreAbove: false, problem: "No message scroller found." };
  }
  const count = list.querySelectorAll(sel.messageItem).length;
  const moreAbove = list.querySelector(sel.loadingSkeleton) !== null;
  // Setting scrollTop to its current value fires nothing; move first, then return to the top.
  scroller.scrollTop = Math.max(1, Math.min(600, (scroller.scrollHeight ?? 600) / 4));
  scroller.scrollTop = 0;
  return { count, moreAbove, problem: null };
}

/**
 * Current mounted-row count and whether more history is indicated.
 * SELF-CONTAINED: shipped to the browser via `Function.prototype.toString`.
 */
export function mountedCount(root: DomRoot, sel: DiscordHistorySelectors): ScrollStepResult {
  const list = root.querySelector(sel.messageList);
  if (!list) return { count: 0, moreAbove: false, problem: "No message list found." };
  return {
    count: list.querySelectorAll(sel.messageItem).length,
    moreAbove: list.querySelector(sel.loadingSkeleton) !== null,
    problem: null,
  };
}

function buildSyncExpression(fn: (root: DomRoot, sel: DiscordHistorySelectors) => ScrollStepResult, selectors: DiscordHistorySelectors): string {
  const source = fn.toString();
  const shim = /\b__name\(/.test(source) ? "const __name = (fn) => fn; " : "";
  return `(() => { ${shim}return (${source})(document, ${JSON.stringify(selectors)}); })()`;
}

export function buildScrollNudgeExpression(selectors: DiscordHistorySelectors = DISCORD_HISTORY_SELECTORS): string {
  return buildSyncExpression(scrollNudge, selectors);
}

export function buildMountedCountExpression(selectors: DiscordHistorySelectors = DISCORD_HISTORY_SELECTORS): string {
  return buildSyncExpression(mountedCount, selectors);
}

export interface ScrollStepOptions {
  /** How long to wait for Discord to prepend rows after the nudge. @default 3000 */
  growWaitMs?: number;
  /** Poll interval while waiting. @default 300 */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Overrides for tests. */
  nudgeExpression?: string;
  countExpression?: string;
}

export interface ScrollStepOutcome {
  before: number;
  after: number;
  moreAbove: boolean;
  problem: string | null;
}

/**
 * One backfill step, driven from Node: nudge, then poll the mounted count
 * with short evaluations until it grows or the wait expires.
 */
export async function scrollStep(evaluate: Evaluate, options: ScrollStepOptions = {}): Promise<ScrollStepOutcome> {
  const growWaitMs = options.growWaitMs ?? 3000;
  const pollMs = options.pollMs ?? 300;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const nudge = (await evaluate(options.nudgeExpression ?? buildScrollNudgeExpression())) as ScrollStepResult;
  if (nudge.problem !== null) return { before: nudge.count, after: nudge.count, moreAbove: false, problem: nudge.problem };
  const started = now();
  let latest: ScrollStepResult = nudge;
  while (now() - started < growWaitMs) {
    await sleep(pollMs);
    latest = (await evaluate(options.countExpression ?? buildMountedCountExpression())) as ScrollStepResult;
    if (latest.problem !== null) return { before: nudge.count, after: latest.count, moreAbove: false, problem: latest.problem };
    if (latest.count !== nudge.count) break;
  }
  return { before: nudge.count, after: latest.count, moreAbove: latest.moreAbove, problem: null };
}

// --- Node side: the read_messages op ---

export interface ReadMessagesParams {
  channel_id: string;
  guild_id?: string | null;
  /** Return only messages older than this message id (exclusive). Resume cursor. */
  before?: string | null;
  /** Messages wanted. @default 50 */
  limit?: number;
  /** Maximum rows examined across all windows. @default 2000 */
  scan_cap?: number;
  /** Wall-clock budget for the whole op. @default 20000 */
  time_budget_ms?: number;
  /** Bytes allowed per in-page extraction. @default 4 MiB */
  window_max_bytes?: number;
}

export interface ReadMessagesResult {
  channel: { id: string; label: string | null };
  /** Newest first. */
  messages: DiscordMessage[];
  count: number;
  /** Distinct rows examined across all windows. */
  scanned: number;
  /** Oldest message id returned; pass as `before` to continue. Null when nothing was returned. */
  cursor: string | null;
  /** True when the beginning of the channel was reached, or `limit` was filled. */
  complete: boolean;
  /** True when a cap or the time budget stopped the op before `limit` was filled. */
  truncated: boolean;
  /** Why the op stopped. */
  stop_reason: "filled" | "beginning" | "scan_cap" | "time_budget" | "no_growth" | "problem";
  problem: string | null;
  elapsed_ms: number;
}

export interface ReadMessagesDeps {
  evaluate: Evaluate;
  /** Injection points for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Override the in-page expressions (tests). */
  extractExpression?: (channelId: string, maxBytes: number) => string;
  scrollStep?: (evaluate: Evaluate) => Promise<ScrollStepOutcome>;
}

const DEFAULTS = { limit: 50, scan_cap: 2000, time_budget_ms: 20_000, window_max_bytes: 4 * 1024 * 1024 } as const;

/** Snowflakes are 64-bit; compare as BigInt, never as strings. */
export function olderThan(id: string, cursor: string): boolean {
  return BigInt(id) < BigInt(cursor);
}

function resolveParams(p: ReadMessagesParams): Required<Omit<ReadMessagesParams, "guild_id" | "before">> & { guild_id: string | null; before: string | null } {
  if (!isSnowflake(p.channel_id)) throw new Error("channel_id must be a Discord snowflake");
  if (p.guild_id !== undefined && p.guild_id !== null && !isSnowflake(p.guild_id)) throw new Error("guild_id must be a Discord snowflake");
  if (p.before !== undefined && p.before !== null && !isSnowflake(p.before)) throw new Error("before must be a Discord message id");
  return {
    channel_id: p.channel_id,
    guild_id: p.guild_id ?? null,
    before: p.before ?? null,
    limit: Math.max(1, Math.min(500, Math.floor(p.limit ?? DEFAULTS.limit))),
    scan_cap: Math.max(1, Math.floor(p.scan_cap ?? DEFAULTS.scan_cap)),
    time_budget_ms: Math.max(1000, Math.floor(p.time_budget_ms ?? DEFAULTS.time_budget_ms)),
    window_max_bytes: Math.max(64 * 1024, Math.floor(p.window_max_bytes ?? DEFAULTS.window_max_bytes)),
  };
}

/**
 * Read messages from a channel, newest first, backfilling by scrolling.
 */
export async function readMessages(deps: ReadMessagesDeps, params: ReadMessagesParams): Promise<ReadMessagesResult> {
  const p = resolveParams(params);
  const now = deps.now ?? Date.now;
  const started = now();
  const budgetLeft = (): number => p.time_budget_ms - (now() - started);
  const extractExpr = deps.extractExpression
    ?? ((channelId: string, maxBytes: number) => buildExtractMessagesExpression({ channelId, maxBytes, maxMessages: 1000 }, DISCORD_SELECTORS));
  const step = deps.scrollStep ?? ((ev: Evaluate) => scrollStep(ev, { sleep: deps.sleep, now: deps.now }));

  const seen = new Map<string, DiscordMessage>();
  let label: string | null = null;
  let scanned = 0;
  let stop: ReadMessagesResult["stop_reason"] | null = null;
  let problem: string | null = null;

  const wanted = (): DiscordMessage[] => {
    const all = [...seen.values()].filter((m) => p.before === null || olderThan(m.id, p.before));
    all.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
    return all;
  };

  await openChannel(deps.evaluate, { guildId: p.guild_id, channelId: p.channel_id, messageId: p.before }, {
    timeoutMs: Math.max(1000, Math.min(15_000, budgetLeft())),
    sleep: deps.sleep,
  });

  let noGrowthStreak = 0;
  while (stop === null) {
    const window = (await deps.evaluate(extractExpr(p.channel_id, p.window_max_bytes))) as ExtractResult;
    if (window.problem !== null && window.count === 0) {
      stop = "problem";
      problem = window.problem;
      break;
    }
    label = label ?? window.channel.label;
    scanned += window.scanned;
    for (const m of window.messages) if (!seen.has(m.id)) seen.set(m.id, m);

    if (wanted().length >= p.limit) { stop = "filled"; break; }
    if (scanned >= p.scan_cap) { stop = "scan_cap"; break; }
    if (budgetLeft() < 500) { stop = "time_budget"; break; }

    const moved = await step(deps.evaluate);
    if (moved.problem !== null) { stop = "problem"; problem = moved.problem; break; }
    if (moved.after === moved.before) {
      if (!moved.moreAbove) { stop = "beginning"; break; }
      noGrowthStreak++;
      if (noGrowthStreak >= 3) { stop = "no_growth"; break; }
    } else {
      noGrowthStreak = 0;
    }
  }

  // Resolve grouped authors across windows from author_ref.
  for (const m of seen.values()) {
    if (m.author === null && m.author_ref !== null) {
      const head = seen.get(m.author_ref);
      if (head?.author) {
        m.author = head.author;
        m.author_inherited = true;
      }
    }
  }

  const messages = wanted().slice(0, p.limit);
  const complete = stop === "filled" || stop === "beginning";
  return {
    channel: { id: p.channel_id, label },
    messages,
    count: messages.length,
    scanned,
    cursor: messages.length > 0 ? messages[messages.length - 1].id : null,
    complete,
    truncated: !complete,
    stop_reason: stop ?? "problem",
    problem,
    elapsed_ms: now() - started,
  };
}
