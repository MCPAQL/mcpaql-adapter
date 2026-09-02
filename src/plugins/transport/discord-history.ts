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
  buildPageExpression,
  type DiscordMessage,
  type DomNode,
  type DomRoot,
  type ExtractResult,
} from "./discord-dom.js";
import { OpenChannelTimeout, defaultSleep, isSnowflake, openChannel, type Evaluate } from "./discord-nav.js";
import { classifyChannelLabel, classifyDiscordMessages, type UntrustedFlag } from "./discord-untrusted.js";
import type { SecuritySeverity } from "../../security/types.js";

/** Selectors observed on discord.com, verified 2026-09-02. */
export const DISCORD_HISTORY_SELECTORS = {
  messageList: DISCORD_SELECTORS.messageList,
  messageItem: DISCORD_SELECTORS.messageItem,
  messageRowPrefix: DISCORD_SELECTORS.messageRowPrefix,
  /** Placeholder rows Discord shows above the oldest mounted message while more history exists. */
  loadingSkeleton: '[class*="blob"]',
  /** Class stem of the scrollable ancestor of the message list. */
  scrollerClass: "scroller",
} as const;

export type DiscordHistorySelectors = typeof DISCORD_HISTORY_SELECTORS;

export interface ScrollStepResult {
  /** Mounted message rows of the pinned channel at the moment of the probe. */
  count: number;
  /** Id of the oldest mounted row; changes when older history mounts even if the count does not. */
  oldestId: string | null;
  /** True when a loading placeholder is shown above the oldest row (a hint, not proof). */
  moreAbove: boolean;
  /** True when no list for the channel or no scroller was found; the caller should stop. */
  problem: string | null;
}

/**
 * The message list for `channelId`, chosen the same way the extractor does
 * (the list holding one of the channel's rows), plus its rows.
 * SELF-CONTAINED helper, inlined by the builders.
 */
export function pinnedList(root: DomRoot, sel: DiscordHistorySelectors, channelId: string): { list: DomNode | null; rows: DomNode[] } {
  const lists = Array.from(root.querySelectorAll(sel.messageList));
  const list = lists.find((l) => l.querySelector(`li[id^="${sel.messageRowPrefix}${channelId}-"]`) !== null) ?? (lists.length === 1 ? lists[0] : null);
  return { list, rows: list ? Array.from(list.querySelectorAll(sel.messageItem)) : [] };
}

/**
 * Probe the pinned list: row count, oldest row id, and whether a loading
 * placeholder sits above the rows. The placeholder is looked for only in the
 * list's non-row children, so message markup can never masquerade as it.
 * SELF-CONTAINED apart from {@link pinnedList}.
 */
export function mountedCount(root: DomRoot, sel: DiscordHistorySelectors, channelId: string): ScrollStepResult {
  const { list, rows } = pinnedList(root, sel, channelId);
  if (!list) return { count: 0, oldestId: null, moreAbove: false, problem: `No message list for channel ${channelId} is mounted.` };
  const firstId = rows.length > 0 ? (rows[0].getAttribute("id") ?? "") : "";
  const oldestId = firstId.startsWith(sel.messageRowPrefix) ? firstId.slice(firstId.lastIndexOf("-") + 1) : null;
  let moreAbove = false;
  const kids = list.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (k.nodeType !== 1 || (k.tagName ?? "").toUpperCase() === "LI") continue;
    if (k.querySelector(sel.loadingSkeleton) !== null) { moreAbove = true; break; }
  }
  return { count: rows.length, oldestId, moreAbove, problem: null };
}

/**
 * Nudge the pinned list's scroller: a real movement, then back to the top,
 * each followed by a synthetic `scroll` event. Synchronous on purpose:
 * Chrome throttles timers in hidden tabs, so in-page waiting can stall past
 * a transport timeout; the wait happens in Node with {@link mountedCount}.
 * Native scroll events are delivered with rendering frames, which a hidden
 * tab never gets, so without the synthetic event Discord never notices the
 * movement (verified live 2026-09-02: 51 rows became 81 in a hidden tab
 * only with the events dispatched).
 * SELF-CONTAINED apart from {@link pinnedList} and {@link mountedCount}.
 */
export function scrollNudge(root: DomRoot, sel: DiscordHistorySelectors, channelId: string): ScrollStepResult {
  const probe = mountedCount(root, sel, channelId);
  if (probe.problem !== null) return probe;
  const { list } = pinnedList(root, sel, channelId);
  // The scroller is the innermost element whose class list has a token with
  // the exact stem `scroller` (Discord hashes classes as `scroller_<hash>`;
  // wrappers like `scrollerContent_<hash>` share the substring but do not
  // scroll) and that contains the pinned list. Document order puts
  // ancestors first, so the last match is the innermost.
  type Scroller = DomNode & { scrollTop?: number; scrollHeight?: number; dispatchEvent?: (event: unknown) => boolean };
  let scroller: Scroller | null = null;
  for (const c of Array.from(root.querySelectorAll(`[class*="${sel.scrollerClass}"]`)) as Scroller[]) {
    const stems = (c.getAttribute("class") ?? "").split(/\s+/).map((t) => t.split("_")[0]);
    if (stems.includes(sel.scrollerClass) && Array.from(c.querySelectorAll(sel.messageList)).includes(list as DomNode)) scroller = c;
  }
  if (!scroller || typeof scroller.scrollTop !== "number") {
    return { count: probe.count, oldestId: probe.oldestId, moreAbove: false, problem: "No message scroller found." };
  }
  const EventCtor = (globalThis as { Event?: new (type: string, init?: { bubbles?: boolean }) => unknown }).Event;
  const notify = (): void => {
    if (typeof scroller?.dispatchEvent === "function" && typeof EventCtor === "function") {
      scroller.dispatchEvent(new EventCtor("scroll", { bubbles: true }));
    }
  };
  scroller.scrollTop = Math.max(1, Math.min(600, (scroller.scrollHeight ?? 600) / 4));
  notify();
  scroller.scrollTop = 0;
  notify();
  return probe;
}

export function buildScrollNudgeExpression(channelId: string, selectors: DiscordHistorySelectors = DISCORD_HISTORY_SELECTORS): string {
  if (!isSnowflake(channelId)) throw new Error("channelId must be a Discord snowflake");
  return buildPageExpression(scrollNudge, [selectors, channelId], [pinnedList, mountedCount]);
}

export function buildMountedCountExpression(channelId: string, selectors: DiscordHistorySelectors = DISCORD_HISTORY_SELECTORS): string {
  if (!isSnowflake(channelId)) throw new Error("channelId must be a Discord snowflake");
  return buildPageExpression(mountedCount, [selectors, channelId], [pinnedList]);
}

export interface ScrollStepOptions {
  /** How long to wait for Discord to prepend rows after the nudge; also bounds every evaluate. @default 3000 */
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
  /** True when older history mounted: more rows, or a different oldest row (virtualized lists swap rows). */
  grew: boolean;
  moreAbove: boolean;
  problem: string | null;
}

/**
 * One backfill step for `channelId`, driven from Node: nudge, then poll the
 * pinned list with short evaluations until older history mounts or the wait
 * expires. Every evaluate and sleep is bounded by what is left of the wait.
 */
export async function scrollStep(evaluate: Evaluate, channelId: string, options: ScrollStepOptions = {}): Promise<ScrollStepOutcome> {
  const growWaitMs = options.growWaitMs ?? 3000;
  const pollMs = options.pollMs ?? 300;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const started = now();
  const left = (): number => Math.max(1, growWaitMs - (now() - started));
  const nudge = (await evaluate(options.nudgeExpression ?? buildScrollNudgeExpression(channelId), { timeoutMs: left() })) as ScrollStepResult;
  if (nudge.problem !== null) return { before: nudge.count, after: nudge.count, grew: false, moreAbove: false, problem: nudge.problem };
  let latest: ScrollStepResult = nudge;
  const changed = (): boolean => latest.count !== nudge.count || latest.oldestId !== nudge.oldestId;
  while (now() - started < growWaitMs) {
    await sleep(Math.min(pollMs, left()));
    if (now() - started >= growWaitMs) break;
    latest = (await evaluate(options.countExpression ?? buildMountedCountExpression(channelId), { timeoutMs: left() })) as ScrollStepResult;
    if (latest.problem !== null) return { before: nudge.count, after: latest.count, grew: false, moreAbove: false, problem: latest.problem };
    if (changed()) break;
  }
  return { before: nudge.count, after: latest.count, grew: changed(), moreAbove: latest.moreAbove, problem: null };
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
  /**
   * Mask `high`/`critical` untrusted-content findings with `[CONTENT_BLOCKED]`
   * (never with normalized text). Off by default: the flags are always
   * reported; the text is left for the reader to judge.
   */
  redact?: boolean;
}

export interface ReadMessagesResult {
  channel: { id: string; label: string | null };
  /** Newest first. */
  messages: DiscordMessage[];
  count: number;
  /** Distinct rows examined across all windows (overlapping windows counted once). */
  scanned: number;
  /**
   * Where to continue: the oldest message id returned, or `before` itself
   * when an incomplete stop returned nothing yet. Null only when complete
   * and nothing was returned.
   */
  cursor: string | null;
  /**
   * True when `limit` was filled, or the beginning of the channel was
   * reached: two consecutive steps with no older history mounting and no
   * loading placeholder above the rows.
   */
  complete: boolean;
  /** True when a cap or the time budget stopped the op before `limit` was filled. */
  truncated: boolean;
  /** Why the op stopped. */
  stop_reason: "filled" | "beginning" | "scan_cap" | "time_budget" | "no_growth" | "problem";
  /** The named problem for a `problem` stop; for a `time_budget` stop, what was still pending when the budget ran out, when anything was. */
  problem: string | null;
  elapsed_ms: number;
  /**
   * Untrusted-content findings from the security validator, per message and
   * per field. Discord content was written by other people; these travel
   * with the result so nothing is silently laundered.
   */
  flags: UntrustedFlag[];
  flagged_ids: string[];
  highest_severity: SecuritySeverity | null;
}

export interface ReadMessagesDeps {
  evaluate: Evaluate;
  /** Injection points for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Override the in-page expressions (tests). */
  extractExpression?: (channelId: string, maxBytes: number) => string;
  mountedCountExpression?: (channelId: string) => string;
  scrollStep?: (evaluate: Evaluate, growWaitMs: number) => Promise<ScrollStepOutcome>;
}

/** Longest a single scroll step may wait for Discord to prepend rows. */
const STEP_GROW_WAIT_MS = 3000;
/**
 * After a navigation in this call, how long to wait for the channel's rows
 * to mount before extracting. The route changes before the rows render
 * (observed live: the location matched, the list existed, the rows arrived
 * a moment later), so an immediate extraction can miss a channel that is in
 * fact opening. The wait polls the small row-count probe, not the extractor,
 * and ends the moment a row is seen.
 */
const OPEN_SETTLE_MS = 3000;
const OPEN_SETTLE_POLL_MS = 250;
/** A step needs at least this much budget to be worth starting. */
const MIN_STEP_MS = 400;

const DEFAULTS = { limit: 50, scan_cap: 2000, time_budget_ms: 20_000, window_max_bytes: 4 * 1024 * 1024 } as const;
/** Below the transport's default result cap, so a window can never be rejected on the wire. */
const WINDOW_MAX_BYTES_CEILING = 8 * 1024 * 1024;
/** Rows the extractor may keep per window; a mounted list larger than this is reported as a problem rather than silently trimmed. */
const WINDOW_MAX_MESSAGES = 5000;

/** Snowflakes are 64-bit; compare as BigInt, never as strings. */
export function olderThan(id: string, cursor: string): boolean {
  return BigInt(id) < BigInt(cursor);
}

function resolveParams(p: ReadMessagesParams): Required<Omit<ReadMessagesParams, "guild_id" | "before" | "redact">> & { guild_id: string | null; before: string | null; redact: boolean } {
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
    window_max_bytes: Math.min(WINDOW_MAX_BYTES_CEILING, Math.max(64 * 1024, Math.floor(p.window_max_bytes ?? DEFAULTS.window_max_bytes))),
    redact: p.redact === true,
  };
}

/**
 * Read messages from a channel, newest first, backfilling by scrolling.
 */
export async function readMessages(deps: ReadMessagesDeps, params: ReadMessagesParams): Promise<ReadMessagesResult> {
  const p = resolveParams(params);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const started = now();
  const budgetLeft = (): number => p.time_budget_ms - (now() - started);
  const extractExpr = deps.extractExpression
    ?? ((channelId: string, maxBytes: number) => buildExtractMessagesExpression({ channelId, maxBytes, maxMessages: WINDOW_MAX_MESSAGES }, DISCORD_SELECTORS));
  const step = deps.scrollStep ?? ((ev: Evaluate, growWaitMs: number) => scrollStep(ev, p.channel_id, { sleep: deps.sleep, now: deps.now, growWaitMs }));
  const countExpr = deps.mountedCountExpression ?? ((channelId: string) => buildMountedCountExpression(channelId));

  const seen = new Map<string, DiscordMessage>();
  let label: string | null = null;
  // `scanned` is distinct rows examined: overlapping windows are not double counted.
  const examined = new Set<string>();
  let stop: ReadMessagesResult["stop_reason"] | null = null;
  let problem: string | null = null;

  const wanted = (): DiscordMessage[] => {
    const all = [...seen.values()].filter((m) => p.before === null || olderThan(m.id, p.before));
    all.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
    return all;
  };

  const openBudget = (): number => Math.max(1000, Math.min(15_000, budgetLeft()));
  // Whether this call changed the route. A channel that was already open is
  // fully rendered; one we navigated to (including through the cursor
  // fallback below, whose second probe passes on the pathname alone) may
  // still be rendering its rows.
  let navigated: boolean;
  try {
    navigated = !(await openChannel(deps.evaluate, { guildId: p.guild_id, channelId: p.channel_id, messageId: p.before }, {
      timeoutMs: openBudget(),
      sleep: deps.sleep,
    })).alreadyOpen;
  } catch (err) {
    // A cursor whose message was deleted never mounts as a row, but Discord
    // still navigates to the surrounding history. Fall back to the channel
    // being open at all and let the loop and the `before` filter do the rest.
    if (!(err instanceof OpenChannelTimeout) || p.before === null) throw err;
    await openChannel(deps.evaluate, { guildId: p.guild_id, channelId: p.channel_id }, { timeoutMs: openBudget(), sleep: deps.sleep });
    navigated = true;
  }
  let settleUntil = navigated ? now() + OPEN_SETTLE_MS : 0;

  let noProgressStreak = 0;
  let lastStepGrew = true;
  // The beginning is declared only after two consecutive observations of no
  // growth and no placeholder: a throttled hidden tab can briefly show
  // neither while an older-row fetch is still pending.
  let atBeginningStreak = 0;
  try {
    while (stop === null) {
      if (budgetLeft() <= 0) { stop = "time_budget"; break; }
      if (now() < settleUntil) {
        // Rows not yet seen after our navigation: ask the small probe, not the extractor.
        const probe = (await deps.evaluate(countExpr(p.channel_id), { timeoutMs: Math.max(1, budgetLeft()) })) as ScrollStepResult;
        if (probe.problem === null && probe.count > 0) {
          settleUntil = 0; // rendered; never wait again in this call
        } else if (budgetLeft() <= OPEN_SETTLE_POLL_MS + MIN_STEP_MS) {
          // Not enough budget for another poll and an extraction: a budget stop, not proof of a problem.
          stop = "time_budget";
          problem = `Channel ${p.channel_id} was still rendering when the time budget ran out; raise time_budget_ms and retry.`;
          break;
        } else {
          await sleep(OPEN_SETTLE_POLL_MS);
          continue;
        }
      }
      const window = (await deps.evaluate(
        extractExpr(p.channel_id, p.window_max_bytes),
        { timeoutMs: Math.max(1, budgetLeft()) },
      )) as ExtractResult;
      if (window.problem !== null && window.count === 0) {
        stop = "problem";
        problem = window.problem;
        break;
      }
      if (window.truncated) {
        // The extractor keeps the newest rows; a backfill needs the oldest.
        // A window that exceeds the caps would drop exactly what the scroll
        // just loaded, so stop and say so rather than spin.
        stop = "problem";
        problem = `The mounted window exceeds the extraction caps (window_max_bytes ${p.window_max_bytes}); raise window_max_bytes or lower limit.`;
        break;
      }
      label = label ?? window.channel.label;

      // Merge newest-first, admitting distinct rows only up to the scan
      // allowance. Rows beyond it are neither examined nor returned, so a
      // single large window cannot exceed `scan_cap` and report success.
      let added = 0;
      let capped = false;
      for (let i = window.messages.length - 1; i >= 0; i--) {
        const m = window.messages[i];
        if (!isSnowflake(m.id) || examined.has(m.id)) continue; // pending/optimistic rows have no snowflake yet
        if (examined.size >= p.scan_cap) { capped = true; break; }
        examined.add(m.id);
        seen.set(m.id, m);
        added++;
      }

      if (wanted().length >= p.limit) { stop = "filled"; break; }
      if (capped || examined.size >= p.scan_cap) { stop = "scan_cap"; break; }

      // Progress is either older history mounting after the last step or new
      // ids in this window. Three steps without either means Discord is not loading.
      if (!lastStepGrew && added === 0) {
        if (++noProgressStreak >= 3) { stop = "no_growth"; break; }
      } else {
        noProgressStreak = 0;
      }

      // A step that cannot fit in the remaining budget is not started.
      const stepBudget = Math.min(STEP_GROW_WAIT_MS, budgetLeft() - MIN_STEP_MS);
      if (stepBudget < MIN_STEP_MS) { stop = "time_budget"; break; }
      const moved = await step(deps.evaluate, stepBudget);
      if (moved.problem !== null) { stop = "problem"; problem = moved.problem; break; }
      lastStepGrew = moved.grew;
      if (!moved.grew && !moved.moreAbove) {
        if (++atBeginningStreak >= 2) { stop = "beginning"; break; }
      } else {
        atBeginningStreak = 0;
      }
    }
  } catch (err) {
    // A transport failure mid-loop must not discard what was collected: the
    // partial envelope goes back with a cursor, and the cause is named.
    const message = err instanceof Error ? err.message : String(err);
    stop = /timed out/i.test(message) ? "time_budget" : "problem";
    problem = message;
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

  // Classification runs after the loop and inside `elapsed_ms`; its cost is
  // bounded per field by the classifier's default (Discord's message ceiling)
  // and per read by `limit`.
  const classified = classifyDiscordMessages(wanted().slice(0, p.limit), { redact: p.redact });
  const messages = classified.messages;
  const labelCheck = classifyChannelLabel(label, { redact: p.redact });
  label = labelCheck.label;
  const flags = labelCheck.flag ? [labelCheck.flag, ...classified.flags] : classified.flags;
  const highest = [labelCheck.flag?.severity ?? null, classified.highest_severity]
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => ({ low: 1, medium: 2, high: 3, critical: 4 }[b] - { low: 1, medium: 2, high: 3, critical: 4 }[a]))[0] ?? null;
  const complete = stop === "filled" || stop === "beginning";
  // Every incomplete stop is resumable: when nothing older than `before` was
  // collected yet, the cursor is `before` itself so a caller continues from
  // the same place instead of restarting at the newest message.
  const cursor = messages.length > 0 ? messages[messages.length - 1].id : (complete ? null : p.before);
  return {
    channel: { id: p.channel_id, label },
    messages,
    count: messages.length,
    scanned: examined.size,
    cursor,
    complete,
    truncated: !complete,
    stop_reason: stop ?? "problem",
    problem,
    elapsed_ms: now() - started,
    flags,
    flagged_ids: classified.flagged_ids,
    highest_severity: highest,
  };
}
