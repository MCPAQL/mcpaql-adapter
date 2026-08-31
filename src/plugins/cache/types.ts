/**
 * Types for the adapter-owned Apple Mail metadata cache (issue #32, B1).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * One enabled cache scope. Omitting `mailbox` enables every mailbox in
 * the account. Nothing is cached or queryable outside the configured
 * scopes (deny by default).
 */
export interface MailCacheScope {
  account: string;
  mailbox?: string;
}

export interface MailCacheConfig {
  /**
   * Accounts/mailboxes enabled for caching. Empty or absent = nothing
   * may be cached or queried.
   */
  scopes?: MailCacheScope[];
}

/**
 * Cached message METADATA. Bodies are never cached — content retrieval
 * stays a per-message, id-addressed bridge fetch.
 */
export interface CachedMessage {
  account?: string;
  mailbox?: string;
  id: number;
  subject: string | null;
  sender: string | null;
  date_received: string | null;
  read_status: boolean | null;
  flagged_status: boolean | null;
  message_size: number | null;
}

/**
 * Parameterized query — the only query shape the cache answers
 * (capability parity with the bridge operation surface).
 */
export interface MessageQuery {
  account: string;
  mailbox?: string;
  /** Case-insensitive substring match on sender. */
  sender?: string;
  /** Case-insensitive substring match on subject. */
  subject?: string;
  /** ISO-8601 lower bound on date_received. */
  since?: string;
  /** ISO-8601 upper bound on date_received. */
  until?: string;
  /** Required. Capped at MAX_QUERY_LIMIT. */
  limit: number;
  offset?: number;
}

export interface MessageQueryResult {
  messages: CachedMessage[];
  count: number;
  source: "cache";
}

/**
 * Per-mailbox sync bookkeeping.
 */
export interface SyncState {
  /**
   * Next bridge index for backfill to resume from; null once the
   * mailbox is fully backfilled (or backfill hit its depth limit).
   */
  backfillCursor: number | null;
  /** Newest message id seen — incremental sync stops here. */
  newestId: number | null;
  lastSyncAt: string | null;
}

/**
 * One page of scan results from the bridge (the paging envelope of the
 * bounded scan templates).
 */
export interface BridgeScanPage {
  messages: CachedMessage[];
  cursor: number | null;
  complete: boolean;
}

/**
 * Fetch one page of newest-first message metadata starting at `cursor`.
 * Implementations wrap the bounded list_messages template; tests supply
 * fakes.
 */
export type BridgePageFetcher = (cursor: number) => Promise<BridgeScanPage>;
