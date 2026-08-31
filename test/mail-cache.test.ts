/**
 * Tests for the Apple Mail metadata cache (issue #32, B1).
 *
 * Uses in-memory SQLite via node:sqlite; the whole file self-skips on
 * runtimes without node:sqlite (Node < 22.5, or 22.x without
 * --experimental-sqlite).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MailCache,
  MailCacheError,
  MAX_QUERY_LIMIT,
  isMailCacheSupported,
  openMailCache,
} from "../src/plugins/cache/mail-cache.js";
import type { CachedMessage, MailCacheConfig } from "../src/plugins/cache/types.js";

const supported = isMailCacheSupported();
const scoped: MailCacheConfig = { scopes: [{ account: "Work" }, { account: "Home", mailbox: "INBOX" }] };

function msg(id: number, overrides: Partial<CachedMessage> = {}): CachedMessage {
  return {
    id,
    subject: `Subject ${id}`,
    sender: `Sender ${id} <s${id}@example.com>`,
    date_received: new Date(Date.UTC(2026, 0, 1) + id * 60_000).toISOString(),
    read_status: false,
    flagged_status: null,
    message_size: 1000 + id,
    ...overrides,
  };
}

function openTestCache(config: MailCacheConfig = scoped): MailCache {
  return openMailCache(":memory:", config);
}

test("openMailCache: throws CACHE_UNSUPPORTED when node:sqlite is unavailable", { skip: supported }, () => {
  assert.throws(
    () => openMailCache(":memory:", scoped),
    (error: unknown) => error instanceof MailCacheError && error.code === "CACHE_UNSUPPORTED",
  );
});

test("scoping: unscoped account is refused for every entry point", { skip: !supported }, () => {
  const cache = openTestCache();
  const denied = (fn: () => unknown) =>
    assert.throws(fn, (e: unknown) => e instanceof MailCacheError && e.code === "CACHE_SCOPE_DENIED");
  denied(() => cache.upsertMessages("Personal", "INBOX", [msg(1)]));
  denied(() => cache.queryMessages({ account: "Personal", limit: 10 }));
  denied(() => cache.countMessages("Personal"));
  denied(() => cache.setSyncState("Personal", "INBOX", { backfillCursor: 0, newestId: null, lastSyncAt: null }));
  cache.close();
});

test("scoping: mailbox-level scope only admits that mailbox", { skip: !supported }, () => {
  const cache = openTestCache();
  cache.upsertMessages("Home", "INBOX", [msg(1)]);
  assert.throws(
    () => cache.upsertMessages("Home", "Archive", [msg(2)]),
    (e: unknown) => e instanceof MailCacheError && e.code === "CACHE_SCOPE_DENIED",
  );
  cache.close();
});

test("scoping: empty scope list denies everything (deny by default)", { skip: !supported }, () => {
  const cache = openTestCache({});
  assert.throws(
    () => cache.queryMessages({ account: "Work", limit: 1 }),
    (e: unknown) => e instanceof MailCacheError && e.code === "CACHE_SCOPE_DENIED",
  );
  cache.close();
});

test("queryMessages: requires an integer limit >= 1", { skip: !supported }, () => {
  const cache = openTestCache();
  for (const limit of [0, -5, 1.5, Number.NaN]) {
    assert.throws(
      () => cache.queryMessages({ account: "Work", limit }),
      (e: unknown) => e instanceof MailCacheError && e.code === "CACHE_LIMIT_REQUIRED",
      `limit ${limit} must be refused`,
    );
  }
  cache.close();
});

test("queryMessages: limit is capped at MAX_QUERY_LIMIT", { skip: !supported }, () => {
  const cache = openTestCache();
  const rows = Array.from({ length: MAX_QUERY_LIMIT + 50 }, (_, i) => msg(i));
  cache.upsertMessages("Work", "INBOX", rows);
  const result = cache.queryMessages({ account: "Work", limit: 10_000 });
  assert.equal(result.count, MAX_QUERY_LIMIT);
  cache.close();
});

test("queryMessages: sender and subject match case-insensitive substrings", { skip: !supported }, () => {
  const cache = openTestCache();
  cache.upsertMessages("Work", "INBOX", [
    msg(1, { sender: "Tricia Young <tyoung@tleconsultinggroup.com>" }),
    msg(2, { sender: "GitHub <notifications@github.com>" }),
    msg(3, { subject: "Invoice INV-42 overdue" }),
  ]);
  const bySender = cache.queryMessages({ account: "Work", sender: "TLECONSULTING", limit: 10 });
  assert.deepEqual(bySender.messages.map((m) => m.id), [1]);
  const bySubject = cache.queryMessages({ account: "Work", subject: "inv-42", limit: 10 });
  assert.deepEqual(bySubject.messages.map((m) => m.id), [3]);
  cache.close();
});

test("queryMessages: LIKE wildcards in user input match literally", { skip: !supported }, () => {
  const cache = openTestCache();
  cache.upsertMessages("Work", "INBOX", [
    msg(1, { subject: "100% complete" }),
    msg(2, { subject: "100 units complete" }),
    msg(3, { subject: "under_score" }),
    msg(4, { subject: "underscore" }),
  ]);
  const percent = cache.queryMessages({ account: "Work", subject: "100%", limit: 10 });
  assert.deepEqual(percent.messages.map((m) => m.id), [1], "% must not act as a wildcard");
  const underscore = cache.queryMessages({ account: "Work", subject: "under_s", limit: 10 });
  assert.deepEqual(underscore.messages.map((m) => m.id), [3], "_ must not act as a wildcard");
  cache.close();
});

test("queryMessages: date range bounds and newest-first ordering", { skip: !supported }, () => {
  const cache = openTestCache();
  cache.upsertMessages("Work", "INBOX", [msg(1), msg(2), msg(3), msg(4)]);
  const all = cache.queryMessages({ account: "Work", limit: 10 });
  assert.deepEqual(all.messages.map((m) => m.id), [4, 3, 2, 1], "newest first");
  const windowed = cache.queryMessages({
    account: "Work",
    since: msg(2).date_received!,
    until: msg(3).date_received!,
    limit: 10,
  });
  assert.deepEqual(windowed.messages.map((m) => m.id), [3, 2]);
  cache.close();
});

test("upsertMessages: idempotent refresh keeps one row per id", { skip: !supported }, () => {
  const cache = openTestCache();
  cache.upsertMessages("Work", "INBOX", [msg(1, { read_status: false })]);
  cache.upsertMessages("Work", "INBOX", [msg(1, { read_status: true })]);
  assert.equal(cache.countMessages("Work", "INBOX"), 1);
  const result = cache.queryMessages({ account: "Work", limit: 10 });
  assert.equal(result.messages[0].read_status, true, "refresh wins");
  cache.close();
});

test("sync state: round-trips and distinguishes absent from complete", { skip: !supported }, () => {
  const cache = openTestCache();
  assert.equal(cache.getSyncState("Work", "INBOX"), undefined);
  cache.setSyncState("Work", "INBOX", { backfillCursor: 120, newestId: 42, lastSyncAt: "2026-08-31T00:00:00Z" });
  assert.deepEqual(cache.getSyncState("Work", "INBOX"), {
    backfillCursor: 120,
    newestId: 42,
    lastSyncAt: "2026-08-31T00:00:00Z",
  });
  cache.setSyncState("Work", "INBOX", { backfillCursor: null, newestId: 42, lastSyncAt: "2026-08-31T01:00:00Z" });
  assert.equal(cache.getSyncState("Work", "INBOX")!.backfillCursor, null);
  cache.close();
});

test("audit: every query and count is recorded with predicate shape", { skip: !supported }, () => {
  const cache = openTestCache();
  cache.upsertMessages("Work", "INBOX", [msg(1)]);
  cache.queryMessages({ account: "Work", sender: "example", limit: 5 });
  cache.countMessages("Work");
  const log = cache.readAuditLog(10);
  assert.equal(log.length, 2);
  const ops = log.map((entry) => entry.operation).sort();
  assert.deepEqual(ops, ["countMessages", "queryMessages"]);
  const queryEntry = log.find((entry) => entry.operation === "queryMessages")!;
  const predicate = JSON.parse(queryEntry.predicate);
  assert.equal(predicate.sender, true, "audit records predicate shape, not values-only booleans for match fields");
  assert.equal(queryEntry.result_count, 1);
  cache.close();
});

test("bodies are structurally impossible: schema has no content column", { skip: !supported }, () => {
  const cache = openTestCache();
  cache.upsertMessages("Work", "INBOX", [
    { ...msg(1), content: "should never be stored" } as unknown as CachedMessage,
  ]);
  const result = cache.queryMessages({ account: "Work", limit: 1 });
  assert.ok(!("content" in result.messages[0]), "no content field in results");
  cache.close();
});

test("openMailCache: on-disk database is restricted to the owning user (0600)", { skip: !supported }, async () => {
  const { mkdtempSync, statSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mail-cache-test-"));
  const path = join(dir, "cache.db");
  const cache = openMailCache(path, scoped);
  try {
    cache.upsertMessages("Work", "INBOX", [msg(1)]);
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600, `cache db mode must be 0600, got 0${mode.toString(8)}`);
  } finally {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
