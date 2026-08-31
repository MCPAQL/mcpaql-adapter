/**
 * Bridge-driven sync for the Apple Mail metadata cache (issue #32, B1).
 *
 * Populates the cache exclusively through the Automation-permitted Apple
 * Event bridge — the bounded list_messages scan template — so the cache
 * never sees anything the bridge could not already read.
 *
 * Two motions:
 * - {@link backfillStep}: walk the mailbox newest-first from the persisted
 *   backfill cursor, one budgeted step at a time. Resumable across runs;
 *   at the measured ~0.9s/message bridge cost a 1.6k mailbox backfills in
 *   ~25 minutes of cumulative budget, while a 100k mailbox should get a
 *   depth limit (maxDepth) rather than a full walk.
 * - {@link incrementalSync}: walk newest-first until a message already in
 *   the cache (or the recorded newest id) is seen. Cheap for daily deltas.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MailCache } from "./mail-cache.js";
import type { BridgePageFetcher, BridgeScanPage, CachedMessage } from "./types.js";
import type { NativeAppleScriptConfig } from "../transport/types.js";
import { executeOperation } from "../transport/native-applescript.js";
import { APPLE_MAIL_TEMPLATES } from "../transport/apple-mail-templates.js";

export interface SyncBudget {
  /** Stop after this many messages fetched in this step. */
  maxMessages?: number;
  /** Stop fetching new pages after this wall-clock deadline (ms epoch). */
  deadlineMs?: number;
  /**
   * backfillStep only: do not walk deeper than this bridge index. Use for
   * jumbo mailboxes where a full walk is impractical; the mailbox is then
   * marked backfill-complete at the depth limit.
   */
  maxDepth?: number;
}

export interface SyncReport {
  fetched: number;
  stored: number;
  pages: number;
  /** True when the motion reached its natural end (not a budget stop). */
  complete: boolean;
  cursor: number | null;
}

const DEFAULT_MAX_MESSAGES = 200;

/**
 * Build a page fetcher over the real bridge for one account/mailbox.
 * `pageSize` messages per osascript invocation keeps each call well under
 * the transport timeout at the measured per-message cost.
 */
export function makeBridgePageFetcher(
  config: NativeAppleScriptConfig,
  account: string,
  mailbox: string,
  pageSize = 15,
): BridgePageFetcher {
  return async (cursor: number): Promise<BridgeScanPage> => {
    const result = await executeOperation(config, APPLE_MAIL_TEMPLATES.list_messages, {
      account_name: account,
      mailbox_name: mailbox,
      limit: pageSize,
      cursor,
      scan_cap: pageSize,
    });
    if (!result.success) {
      throw new Error(
        `bridge page fetch failed at cursor ${cursor}: ${result.error?.message ?? "unknown error"}`,
      );
    }
    const data = result.data as {
      messages: CachedMessage[];
      cursor: number | null;
      complete: boolean;
    };
    return { messages: data.messages, cursor: data.cursor, complete: data.complete };
  };
}

function budgetExhausted(budget: SyncBudget, fetched: number): boolean {
  if (budget.maxMessages !== undefined && fetched >= budget.maxMessages) {
    return true;
  }
  if (budget.deadlineMs !== undefined && Date.now() >= budget.deadlineMs) {
    return true;
  }
  return false;
}

/**
 * Run one budgeted backfill step for a mailbox, resuming from the
 * persisted cursor. Call repeatedly (across sessions) until the returned
 * report says complete.
 */
export async function backfillStep(
  cache: MailCache,
  account: string,
  mailbox: string,
  fetchPage: BridgePageFetcher,
  budget: SyncBudget = {},
): Promise<SyncReport> {
  const state = cache.getSyncState(account, mailbox);
  if (state !== undefined && state.backfillCursor === null) {
    return { fetched: 0, stored: 0, pages: 0, complete: true, cursor: null };
  }
  let cursor = state?.backfillCursor ?? 0;
  let newestId = state?.newestId ?? null;
  const maxMessages = budget.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const effectiveBudget = { ...budget, maxMessages };

  let fetched = 0;
  let stored = 0;
  let pages = 0;
  let complete = false;

  while (!budgetExhausted(effectiveBudget, fetched)) {
    if (budget.maxDepth !== undefined && cursor >= budget.maxDepth) {
      complete = true; // depth limit reached — treat as done for this mailbox
      break;
    }
    const page = await fetchPage(cursor);
    pages++;
    fetched += page.messages.length;
    stored += cache.upsertMessages(account, mailbox, page.messages);
    if (newestId === null && page.messages.length > 0 && cursor === 0) {
      newestId = page.messages[0].id;
    }
    if (page.complete || page.cursor === null) {
      complete = true;
      cursor = page.cursor ?? cursor;
      break;
    }
    cursor = page.cursor;
    if (page.messages.length === 0) {
      break; // defensive: no progress, avoid a hot loop
    }
  }

  cache.setSyncState(account, mailbox, {
    backfillCursor: complete ? null : cursor,
    newestId,
    lastSyncAt: new Date().toISOString(),
  });
  return { fetched, stored, pages, complete, cursor: complete ? null : cursor };
}

/**
 * Pull new messages since the last sync: walk newest-first until a message
 * already cached (or the recorded newest id) appears, then stop.
 */
export async function incrementalSync(
  cache: MailCache,
  account: string,
  mailbox: string,
  fetchPage: BridgePageFetcher,
  budget: SyncBudget = {},
): Promise<SyncReport> {
  const state = cache.getSyncState(account, mailbox);
  const knownNewestId = state?.newestId ?? null;
  const maxMessages = budget.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const effectiveBudget = { ...budget, maxMessages };

  let cursor = 0;
  let fetched = 0;
  let stored = 0;
  let pages = 0;
  let complete = false;
  let newestId = knownNewestId;

  outer: while (!budgetExhausted(effectiveBudget, fetched)) {
    const page = await fetchPage(cursor);
    pages++;
    const fresh: CachedMessage[] = [];
    for (const message of page.messages) {
      const known = message.id === knownNewestId
        || cache.hasMessage(account, mailbox, message.id);
      if (known) {
        stored += cache.upsertMessages(account, mailbox, fresh);
        fetched += fresh.length;
        if (fresh.length > 0 && cursor === 0 && newestId !== fresh[0].id) {
          newestId = fresh[0].id;
        }
        complete = true;
        break outer;
      }
      fresh.push(message);
    }
    stored += cache.upsertMessages(account, mailbox, fresh);
    fetched += fresh.length;
    if (cursor === 0 && fresh.length > 0) {
      newestId = fresh[0].id;
    }
    if (page.complete || page.cursor === null) {
      complete = true;
      break;
    }
    if (page.messages.length === 0) {
      break;
    }
    cursor = page.cursor;
  }

  cache.setSyncState(account, mailbox, {
    backfillCursor: state?.backfillCursor ?? null,
    newestId,
    lastSyncAt: new Date().toISOString(),
  });
  return { fetched, stored, pages, complete, cursor: null };
}
