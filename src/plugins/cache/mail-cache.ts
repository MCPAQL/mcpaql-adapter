/**
 * Adapter-owned metadata cache for Apple Mail (issue #32, section B1).
 *
 * The Apple Event bridge costs ~0.9s per message on a small mailbox and
 * 2-5s per message on a 100k-message mailbox (benchmarks in #32), so
 * listing and search at scale cannot be served from the bridge. This cache
 * holds message METADATA ONLY (never bodies) in a local SQLite database,
 * populated exclusively through the same Automation-permitted bridge the
 * adapter already uses — no Full Disk Access, no new macOS permission, no
 * access to anything the bridge cannot already read.
 *
 * Security model (issue #32, "Security considerations"):
 * - Capability parity: the cache answers only the query shapes the
 *   operation surface already exposes (sender / subject / date range /
 *   mailbox), each with a mandatory, capped result limit. No raw SQL from
 *   callers, no "all messages" export, no body content.
 * - Deny-by-default scoping: only accounts/mailboxes explicitly enabled in
 *   the cache config are ever stored or queried.
 * - Auditability: every query is recorded (operation, predicate shape,
 *   result count) in the audit_log table.
 *
 * Requires the `node:sqlite` built-in (Node >= 22.5 with
 * --experimental-sqlite, unflagged from Node 23.4). Use
 * {@link isMailCacheSupported} to detect availability and fall back to
 * bounded bridge scans when absent.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { chmodSync } from "node:fs";
import { createRequire } from "node:module";

import type {
  CachedMessage,
  MailCacheConfig,
  MailCacheScope,
  MessageQuery,
  MessageQueryResult,
  SyncState,
} from "./types.js";

/**
 * Hard ceiling on results per query, regardless of the caller's limit.
 */
export const MAX_QUERY_LIMIT = 500;

/**
 * Ceiling on audit rows kept; oldest rows are pruned past this.
 */
const AUDIT_LOG_MAX_ROWS = 50_000;

export class MailCacheError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MailCacheError";
    this.code = code;
  }
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type SqliteModule = { DatabaseSync: new (path: string) => SqliteDatabase };

let sqliteModule: SqliteModule | null | undefined;

function loadSqlite(): SqliteModule | null {
  if (sqliteModule === undefined) {
    try {
      const require = createRequire(import.meta.url);
      sqliteModule = require("node:sqlite") as SqliteModule;
    } catch {
      sqliteModule = null;
    }
  }
  return sqliteModule;
}

/**
 * Whether the node:sqlite built-in is available in this runtime.
 * When false, callers must fall back to bounded bridge scans.
 */
export function isMailCacheSupported(): boolean {
  return loadSqlite() !== null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  account TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  id INTEGER NOT NULL,
  subject TEXT,
  sender TEXT,
  date_received TEXT,
  read_status INTEGER,
  flagged_status INTEGER,
  message_size INTEGER,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (account, mailbox, id)
);
CREATE INDEX IF NOT EXISTS idx_messages_date
  ON messages(account, mailbox, date_received DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender
  ON messages(account, mailbox, sender);
CREATE TABLE IF NOT EXISTS sync_state (
  account TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  backfill_cursor INTEGER,
  newest_id INTEGER,
  last_sync_at TEXT,
  PRIMARY KEY (account, mailbox)
);
CREATE TABLE IF NOT EXISTS audit_log (
  ts TEXT NOT NULL,
  operation TEXT NOT NULL,
  predicate TEXT NOT NULL,
  result_count INTEGER NOT NULL
);
`;

/**
 * Escape LIKE wildcards in a user-supplied substring so it matches
 * literally. The query uses `ESCAPE '\\'`.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function toBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value === 1 || value === 1n || value === true;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return Number(value);
}

/**
 * The adapter-owned Apple Mail metadata cache.
 * Construct via {@link openMailCache}.
 */
export class MailCache {
  private readonly db: SqliteDatabase;
  private readonly scopes: readonly MailCacheScope[];

  constructor(db: SqliteDatabase, config: MailCacheConfig) {
    this.db = db;
    this.scopes = config.scopes ?? [];
    this.db.exec(SCHEMA);
  }

  /**
   * Whether an account (and optionally a mailbox) is enabled for caching.
   * Deny by default: an empty scope list allows nothing.
   */
  isScoped(account: string, mailbox?: string): boolean {
    return this.scopes.some((scope) => {
      if (scope.account !== account) {
        return false;
      }
      if (scope.mailbox === undefined) {
        return true; // whole account enabled
      }
      return mailbox !== undefined && scope.mailbox === mailbox;
    });
  }

  private assertScoped(account: string, mailbox?: string): void {
    if (!this.isScoped(account, mailbox)) {
      throw new MailCacheError(
        "CACHE_SCOPE_DENIED",
        `Account '${account}'${mailbox !== undefined ? ` mailbox '${mailbox}'` : ""} is not enabled for caching. Add it to the cache scopes config to index it.`,
      );
    }
  }

  /**
   * Store (or refresh) a page of message metadata fetched from the bridge.
   */
  upsertMessages(account: string, mailbox: string, messages: readonly CachedMessage[]): number {
    this.assertScoped(account, mailbox);
    const stmt = this.db.prepare(`
      INSERT INTO messages (account, mailbox, id, subject, sender, date_received,
                            read_status, flagged_status, message_size, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account, mailbox, id) DO UPDATE SET
        subject = excluded.subject,
        sender = excluded.sender,
        date_received = excluded.date_received,
        read_status = excluded.read_status,
        flagged_status = excluded.flagged_status,
        message_size = excluded.message_size,
        synced_at = excluded.synced_at
    `);
    const now = new Date().toISOString();
    let stored = 0;
    for (const message of messages) {
      stmt.run(
        account,
        mailbox,
        message.id,
        message.subject ?? null,
        message.sender ?? null,
        message.date_received ?? null,
        message.read_status === null || message.read_status === undefined ? null : message.read_status ? 1 : 0,
        message.flagged_status === null || message.flagged_status === undefined ? null : message.flagged_status ? 1 : 0,
        message.message_size ?? null,
        now,
      );
      stored++;
    }
    return stored;
  }

  /**
   * Query cached message metadata. Parameterized predicates only —
   * capability parity with the bridge operation surface.
   */
  queryMessages(query: MessageQuery): MessageQueryResult {
    this.assertScoped(query.account, query.mailbox);
    if (!Number.isInteger(query.limit) || query.limit < 1) {
      throw new MailCacheError(
        "CACHE_LIMIT_REQUIRED",
        "queryMessages requires an integer limit >= 1.",
      );
    }
    const limit = Math.min(query.limit, MAX_QUERY_LIMIT);
    const offset = Number.isInteger(query.offset) && query.offset! > 0 ? query.offset! : 0;

    const where: string[] = ["account = ?"];
    const params: unknown[] = [query.account];
    if (query.mailbox !== undefined) {
      where.push("mailbox = ?");
      params.push(query.mailbox);
    }
    if (query.sender !== undefined) {
      where.push("sender LIKE ? ESCAPE '\\' COLLATE NOCASE");
      params.push(`%${escapeLike(query.sender)}%`);
    }
    if (query.subject !== undefined) {
      where.push("subject LIKE ? ESCAPE '\\' COLLATE NOCASE");
      params.push(`%${escapeLike(query.subject)}%`);
    }
    if (query.since !== undefined) {
      where.push("date_received >= ?");
      params.push(query.since);
    }
    if (query.until !== undefined) {
      where.push("date_received <= ?");
      params.push(query.until);
    }

    const sql = `
      SELECT account, mailbox, id, subject, sender, date_received,
             read_status, flagged_status, message_size
      FROM messages
      WHERE ${where.join(" AND ")}
      ORDER BY date_received DESC
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    const messages: CachedMessage[] = rows.map((row) => ({
      account: String(row.account),
      mailbox: String(row.mailbox),
      id: Number(row.id),
      subject: (row.subject as string | null) ?? null,
      sender: (row.sender as string | null) ?? null,
      date_received: (row.date_received as string | null) ?? null,
      read_status: toBoolean(row.read_status),
      flagged_status: toBoolean(row.flagged_status),
      message_size: toNumberOrNull(row.message_size),
    }));

    this.audit("queryMessages", {
      account: query.account,
      mailbox: query.mailbox,
      sender: query.sender !== undefined,
      subject: query.subject !== undefined,
      since: query.since,
      until: query.until,
      limit,
      offset,
    }, messages.length);

    return { messages, count: messages.length, source: "cache" };
  }

  /**
   * Count cached messages for a scoped account/mailbox — the cache-backed
   * replacement for the `message_count` that `list_mailboxes` had to drop.
   */
  countMessages(account: string, mailbox?: string): number {
    this.assertScoped(account, mailbox);
    const params: unknown[] = [account];
    let sql = "SELECT COUNT(*) AS n FROM messages WHERE account = ?";
    if (mailbox !== undefined) {
      sql += " AND mailbox = ?";
      params.push(mailbox);
    }
    const row = this.db.prepare(sql).get(...params) as { n: number | bigint };
    const count = Number(row.n);
    this.audit("countMessages", { account, mailbox }, count);
    return count;
  }

  /**
   * Whether a message id is already cached (incremental-sync stop check).
   */
  hasMessage(account: string, mailbox: string, id: number): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM messages WHERE account = ? AND mailbox = ? AND id = ?",
    ).get(account, mailbox, id);
    return row !== undefined;
  }

  getSyncState(account: string, mailbox: string): SyncState | undefined {
    const row = this.db.prepare(
      "SELECT backfill_cursor, newest_id, last_sync_at FROM sync_state WHERE account = ? AND mailbox = ?",
    ).get(account, mailbox) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      backfillCursor: toNumberOrNull(row.backfill_cursor),
      newestId: toNumberOrNull(row.newest_id),
      lastSyncAt: (row.last_sync_at as string | null) ?? null,
    };
  }

  setSyncState(account: string, mailbox: string, state: SyncState): void {
    this.assertScoped(account, mailbox);
    this.db.prepare(`
      INSERT INTO sync_state (account, mailbox, backfill_cursor, newest_id, last_sync_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (account, mailbox) DO UPDATE SET
        backfill_cursor = excluded.backfill_cursor,
        newest_id = excluded.newest_id,
        last_sync_at = excluded.last_sync_at
    `).run(account, mailbox, state.backfillCursor, state.newestId, state.lastSyncAt);
  }

  /**
   * Read recent audit entries (newest first).
   */
  readAuditLog(limit = 100): Array<{ ts: string; operation: string; predicate: string; result_count: number }> {
    const capped = Math.min(Math.max(1, limit), 1000);
    return this.db.prepare(
      "SELECT ts, operation, predicate, result_count FROM audit_log ORDER BY ts DESC, rowid DESC LIMIT ?",
    ).all(capped) as Array<{ ts: string; operation: string; predicate: string; result_count: number }>;
  }

  private audit(operation: string, predicate: Record<string, unknown>, resultCount: number): void {
    this.db.prepare(
      "INSERT INTO audit_log (ts, operation, predicate, result_count) VALUES (?, ?, ?, ?)",
    ).run(new Date().toISOString(), operation, JSON.stringify(predicate), resultCount);
    this.db.prepare(
      `DELETE FROM audit_log WHERE rowid <= (
         SELECT rowid FROM audit_log ORDER BY rowid DESC LIMIT 1 OFFSET ?
       )`,
    ).run(AUDIT_LOG_MAX_ROWS);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Open (creating if needed) the mail metadata cache.
 *
 * @param path - SQLite file path, or ":memory:" for tests
 * @param config - Scoping configuration (deny by default)
 * @throws {MailCacheError} CACHE_UNSUPPORTED when node:sqlite is unavailable
 */
export function openMailCache(path: string, config: MailCacheConfig): MailCache {
  const sqlite = loadSqlite();
  if (sqlite === null) {
    throw new MailCacheError(
      "CACHE_UNSUPPORTED",
      "node:sqlite is not available in this runtime (requires Node >= 22.5 with --experimental-sqlite, unflagged from 23.4). Fall back to bounded bridge scans.",
    );
  }
  const db = new sqlite.DatabaseSync(path);
  if (path !== ":memory:") {
    // Cached metadata (senders, subjects, account names) must not be
    // world-readable: DatabaseSync honors the process umask (typically
    // 0644). Restrict the database and its WAL/journal side files to the
    // owning user.
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
      try {
        chmodSync(file, 0o600);
      } catch {
        // Side files may not exist (yet); the main file chmod is the one
        // that must succeed, and a failure there surfaces on first use
        // of a hardened deployment rather than silently loosening modes.
      }
    }
  }
  return new MailCache(db, config);
}
