/**
 * Tests for the bridge-driven cache sync (issue #32, B1).
 * Uses fake page fetchers — no osascript needed.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from "node:assert/strict";
import test from "node:test";

import { isMailCacheSupported, openMailCache } from "../src/plugins/cache/mail-cache.js";
import { backfillStep, incrementalSync } from "../src/plugins/cache/mail-sync.js";
import type { BridgePageFetcher, CachedMessage, MailCacheConfig } from "../src/plugins/cache/types.js";

const supported = isMailCacheSupported();
const config: MailCacheConfig = { scopes: [{ account: "Work" }] };

function msg(id: number): CachedMessage {
  return {
    id,
    subject: `Subject ${id}`,
    sender: `s${id}@example.com`,
    date_received: new Date(Date.UTC(2026, 0, 1) + id * 60_000).toISOString(),
    read_status: false,
    flagged_status: false,
    message_size: 100,
  };
}

/**
 * Fake mailbox: ids newest-first. Pages of `pageSize` via cursor indexes,
 * like the bounded list_messages template.
 */
function fakeMailbox(ids: number[], pageSize = 3): { fetcher: BridgePageFetcher; calls: number[] } {
  const calls: number[] = [];
  const fetcher: BridgePageFetcher = async (cursor: number) => {
    calls.push(cursor);
    const slice = ids.slice(cursor, cursor + pageSize);
    const next = cursor + slice.length;
    const complete = next >= ids.length;
    return {
      messages: slice.map(msg),
      cursor: complete ? null : next,
      complete,
    };
  };
  return { fetcher, calls };
}

test("backfillStep: walks to completion and records newest id", { skip: !supported }, async () => {
  const cache = openMailCache(":memory:", config);
  const { fetcher } = fakeMailbox([50, 49, 48, 47, 46, 45, 44]);
  const report = await backfillStep(cache, "Work", "INBOX", fetcher, { maxMessages: 100 });
  assert.equal(report.complete, true);
  assert.equal(report.fetched, 7);
  assert.equal(cache.countMessages("Work", "INBOX"), 7);
  const state = cache.getSyncState("Work", "INBOX")!;
  assert.equal(state.backfillCursor, null, "complete backfill clears the cursor");
  assert.equal(state.newestId, 50);
  cache.close();
});

test("backfillStep: budget stop persists a resumable cursor and resumes from it", { skip: !supported }, async () => {
  const cache = openMailCache(":memory:", config);
  const ids = Array.from({ length: 10 }, (_, i) => 100 - i);
  const { fetcher, calls } = fakeMailbox(ids, 2);

  const first = await backfillStep(cache, "Work", "INBOX", fetcher, { maxMessages: 4 });
  assert.equal(first.complete, false);
  assert.equal(first.cursor, 4);
  assert.equal(cache.getSyncState("Work", "INBOX")!.backfillCursor, 4);

  const second = await backfillStep(cache, "Work", "INBOX", fetcher, { maxMessages: 100 });
  assert.equal(second.complete, true);
  assert.equal(cache.countMessages("Work", "INBOX"), 10);
  assert.equal(calls[2], 4, "second step resumed from the persisted cursor");
  cache.close();
});

test("backfillStep: maxDepth marks a jumbo mailbox complete at the depth limit", { skip: !supported }, async () => {
  const cache = openMailCache(":memory:", config);
  const ids = Array.from({ length: 1000 }, (_, i) => 10_000 - i);
  const { fetcher } = fakeMailbox(ids, 5);
  const report = await backfillStep(cache, "Work", "INBOX", fetcher, { maxMessages: 500, maxDepth: 20 });
  assert.equal(report.complete, true, "depth limit ends the backfill");
  assert.equal(cache.countMessages("Work", "INBOX"), 20);
  assert.equal(cache.getSyncState("Work", "INBOX")!.backfillCursor, null);
  cache.close();
});

test("backfillStep: no-op when backfill already complete", { skip: !supported }, async () => {
  const cache = openMailCache(":memory:", config);
  const { fetcher, calls } = fakeMailbox([3, 2, 1]);
  await backfillStep(cache, "Work", "INBOX", fetcher, { maxMessages: 100 });
  const again = await backfillStep(cache, "Work", "INBOX", fetcher, { maxMessages: 100 });
  assert.equal(again.fetched, 0);
  assert.equal(again.complete, true);
  assert.equal(calls.length, 1, "no bridge traffic after completion");
  cache.close();
});

test("incrementalSync: stops at the first already-cached message", { skip: !supported }, async () => {
  const cache = openMailCache(":memory:", config);
  const initial = [50, 49, 48, 47, 46];
  const first = fakeMailbox(initial);
  await backfillStep(cache, "Work", "INBOX", first.fetcher, { maxMessages: 100 });

  // Three new messages arrive on top.
  const updated = [53, 52, 51, ...initial];
  const second = fakeMailbox(updated, 2);
  const report = await incrementalSync(cache, "Work", "INBOX", second.fetcher, { maxMessages: 100 });
  assert.equal(report.complete, true);
  assert.equal(report.fetched, 3, "only the three new messages are fetched/stored");
  assert.equal(cache.countMessages("Work", "INBOX"), 8);
  assert.equal(cache.getSyncState("Work", "INBOX")!.newestId, 53);
  assert.ok(second.calls.length <= 2, "stops within the page containing a known id");
  cache.close();
});

test("incrementalSync: empty delta is cheap and keeps state", { skip: !supported }, async () => {
  const cache = openMailCache(":memory:", config);
  const ids = [9, 8, 7];
  const first = fakeMailbox(ids);
  await backfillStep(cache, "Work", "INBOX", first.fetcher, { maxMessages: 100 });
  const second = fakeMailbox(ids);
  const report = await incrementalSync(cache, "Work", "INBOX", second.fetcher, { maxMessages: 100 });
  assert.equal(report.fetched, 0);
  assert.equal(report.complete, true);
  assert.equal(second.calls.length, 1, "one page is enough to see a known id");
  assert.equal(cache.getSyncState("Work", "INBOX")!.newestId, 9);
  cache.close();
});

test("incrementalSync: budget stop on a huge delta leaves complete=false", { skip: !supported }, async () => {
  const cache = openMailCache(":memory:", config);
  await backfillStep(cache, "Work", "INBOX", fakeMailbox([5, 4, 3]).fetcher, { maxMessages: 100 });
  const flood = [...Array.from({ length: 50 }, (_, i) => 500 - i), 5, 4, 3];
  const report = await incrementalSync(cache, "Work", "INBOX", fakeMailbox(flood, 10).fetcher, { maxMessages: 20 });
  assert.equal(report.complete, false);
  assert.ok(report.fetched >= 20);
  cache.close();
});
