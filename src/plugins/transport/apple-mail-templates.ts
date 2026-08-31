/**
 * Predefined JXA templates for common Apple Mail operations.
 *
 * These serve as the reference implementation for the native-applescript
 * transport applied to Mail.app. Extracted from native-applescript.ts to
 * decouple the generic transport from Mail-specific knowledge.
 *
 * Bridge rules (issue #32, section A) — every template obeys them:
 * - Never call `mailbox.messages()` or `messages.length`: both force Mail to
 *   enumerate the entire mailbox before returning, which times out on
 *   production-sized mailboxes (100k+ messages, see #26).
 * - Never use `whose` except `{id: {_equals: ...}}` on a single known id.
 * - Scanning operations iterate by index, newest-first, bounded by three
 *   limits: `limit` (results), `scan_cap` (messages examined), and
 *   `time_budget_ms` (wall clock, kept below the osascript timeout).
 * - Property access is one `properties()` Apple Event per message instead of
 *   one event per property.
 * - Scans return a paging envelope instead of a bare array:
 *   `{messages, count, scanned, cursor, complete, truncated, elapsed_ms}`.
 *   `cursor` is the index to resume from (null when the scan is complete);
 *   `truncated` is true when a scan_cap/time-budget stop occurred before
 *   `limit` results were found.
 *
 * Measured bridge cost (2026-08-31, Apple Silicon, Mail.app with a ~100k
 * INBOX): one `properties()` event costs ~0.9s/message on a 1.6k mailbox and
 * 2-5s/message on the 100k mailbox; AppleScript `messages 1 thru N` range
 * fetches are no cheaper per item. The bridge therefore cannot serve fast
 * listings at scale — these templates guarantee bounded, resumable, partial
 * results instead of timeouts. Fast listing/search at scale comes from the
 * adapter-owned metadata cache (#32 section B1), which these scans feed.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { ScriptTemplate } from "./types.js";

/**
 * Shared parameter set for bounded scan operations.
 * `cursor`, `scan_cap`, and `time_budget_ms` default so existing callers
 * that only pass account/mailbox/limit keep working.
 */
const SCAN_PARAMS: ScriptTemplate["params"] = {
  account_name: "text",
  mailbox_name: "text",
  limit: "integer",
  cursor: { type: "integer", default: 0 },
  scan_cap: { type: "integer", default: 200 },
  time_budget_ms: { type: "integer", default: 20_000 },
};

/**
 * Opening lines shared by all bounded scan templates.
 * `msgs` stays a lazy object specifier: indexing it costs one Apple Event
 * per message; calling it or reading `.length` would enumerate the mailbox.
 */
const SCAN_PRELUDE = [
  "ObjC.import('stdlib');",
  "const mail = Application('Mail');",
  "const account = mail.accounts.byName({{account_name}});",
  "const mailbox = account.mailboxes.byName({{mailbox_name}});",
  "const limit = {{limit}};",
  "const cursor = {{cursor}};",
  "const scanCap = {{scan_cap}};",
  "const timeBudgetMs = {{time_budget_ms}};",
  "const startedAt = Date.now();",
  "const msgs = mailbox.messages;",
  "const result = [];",
  "let scanned = 0;",
  "let index = cursor;",
  "let done = false;",
];

/**
 * Build the bounded scan loop. `bodyLines` runs once per fetched message
 * with `p` (the message properties record) and `dateIso` in scope, after
 * the index/scanned counters have advanced — a `continue` skips the
 * message, `done = true; break;` ends the scan as complete.
 */
function scanLoop(bodyLines: string[]): string[] {
  return [
    "while (result.length < limit && scanned < scanCap) {",
    "  if (Date.now() - startedAt >= timeBudgetMs) { break; }",
    "  let p;",
    "  try {",
    "    p = msgs[index].properties();",
    "  } catch (e) {",
    "    done = true;",
    "    break;",
    "  }",
    "  index++;",
    "  scanned++;",
    "  const dr = p.dateReceived;",
    "  const dateIso = (dr && typeof dr.toISOString === 'function') ? dr.toISOString() : null;",
    ...bodyLines.map((line) => `  ${line}`),
    "}",
  ];
}

/**
 * Closing lines shared by all bounded scan templates: the paging envelope.
 */
const SCAN_EPILOGUE = [
  "JSON.stringify({",
  "  messages: result,",
  "  count: result.length,",
  "  scanned: scanned,",
  "  cursor: done ? null : index,",
  "  complete: done,",
  "  truncated: !done && result.length < limit,",
  "  elapsed_ms: Date.now() - startedAt",
  "});",
];

/**
 * Standard listing fields pushed for a matched message.
 */
const PUSH_SUMMARY = [
  "result.push({",
  "  id: p.id,",
  "  subject: (typeof p.subject === 'string') ? p.subject : null,",
  "  sender: (typeof p.sender === 'string') ? p.sender : null,",
  "  date_received: dateIso,",
  "  read_status: (typeof p.readStatus === 'boolean') ? p.readStatus : null,",
  "  flagged_status: (typeof p.flaggedStatus === 'boolean') ? p.flaggedStatus : null,",
  "  message_size: (typeof p.messageSize === 'number') ? p.messageSize : null",
  "});",
];

export const APPLE_MAIL_TEMPLATES: Record<string, ScriptTemplate> = {
  list_accounts: {
    language: "JavaScript",
    template: [
      "ObjC.import('stdlib');",
      "const mail = Application('Mail');",
      "const accounts = mail.accounts();",
      "const result = accounts.map(a => ({",
      "  name: a.name(),",
      "  id: a.id(),",
      "  user_name: a.userName(),",
      "  server_name: a.serverName(),",
      "  enabled: a.enabled(),",
      "  account_type: a.accountType()",
      "}));",
      "JSON.stringify(result);",
    ].join("\n"),
    params: {},
  },

  list_mailboxes: {
    language: "JavaScript",
    template: [
      "ObjC.import('stdlib');",
      "const mail = Application('Mail');",
      "const account = mail.accounts.byName({{account_name}});",
      "const mailboxes = account.mailboxes();",
      "const result = mailboxes.map(m => ({",
      "  name: m.name(),",
      "  unread_count: m.unreadCount()",
      "}));",
      "JSON.stringify(result);",
    ].join("\n"),
    params: {
      account_name: "text",
    },
  },

  list_messages: {
    language: "JavaScript",
    template: [
      ...SCAN_PRELUDE,
      ...scanLoop(PUSH_SUMMARY),
      ...SCAN_EPILOGUE,
    ].join("\n"),
    params: { ...SCAN_PARAMS },
  },

  recent_messages: {
    language: "JavaScript",
    template: [
      ...SCAN_PRELUDE,
      "const days = {{days}};",
      "const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);",
      ...scanLoop([
        "if (dr && typeof dr.getTime === 'function' && dr < cutoff) { done = true; break; }",
        ...PUSH_SUMMARY,
      ]),
      ...SCAN_EPILOGUE,
    ].join("\n"),
    params: {
      ...SCAN_PARAMS,
      days: "integer",
    },
  },

  search_messages: {
    language: "JavaScript",
    template: [
      ...SCAN_PRELUDE,
      "const query = {{query}};",
      "const field = {{field}};",
      "if (field !== 'subject' && field !== 'sender' && field !== 'any') {",
      "  throw new Error(\"field must be 'subject', 'sender', or 'any'\");",
      "}",
      "const q = query.toLowerCase();",
      ...scanLoop([
        "const subj = (typeof p.subject === 'string') ? p.subject.toLowerCase() : '';",
        "const sndr = (typeof p.sender === 'string') ? p.sender.toLowerCase() : '';",
        "let match = false;",
        "if (field === 'subject' || field === 'any') { match = subj.indexOf(q) !== -1; }",
        "if (!match && (field === 'sender' || field === 'any')) { match = sndr.indexOf(q) !== -1; }",
        "if (!match) { continue; }",
        ...PUSH_SUMMARY,
      ]),
      ...SCAN_EPILOGUE,
    ].join("\n"),
    params: {
      ...SCAN_PARAMS,
      query: "text",
      field: { type: "text", default: "subject" },
    },
  },

  get_message: {
    language: "JavaScript",
    template: [
      "ObjC.import('stdlib');",
      "const mail = Application('Mail');",
      "const account = mail.accounts.byName({{account_name}});",
      "const mailbox = account.mailboxes.byName({{mailbox_name}});",
      "const msgs = mailbox.messages.whose({id: {_equals: {{message_id}}}});",
      "if (msgs.length === 0) { JSON.stringify({error: 'Message not found'}); }",
      "else {",
      "  const m = msgs[0];",
      "  JSON.stringify({",
      "    id: m.id(),",
      "    subject: m.subject(),",
      "    sender: m.sender(),",
      "    date_received: m.dateReceived().toISOString(),",
      "    date_sent: m.dateSent() ? m.dateSent().toISOString() : null,",
      "    read_status: m.readStatus(),",
      "    flagged_status: m.flaggedStatus(),",
      "    junk_mail_status: m.junkMailStatus(),",
      "    deleted_status: m.deletedStatus(),",
      "    message_size: m.messageSize(),",
      "    content: m.content(),",
      "    to_recipients: m.toRecipients().map(r => ({name: r.name(), address: r.address()})),",
      "    cc_recipients: m.ccRecipients().map(r => ({name: r.name(), address: r.address()})),",
      "  });",
      "}",
    ].join("\n"),
    params: {
      account_name: "text",
      mailbox_name: "text",
      message_id: "integer",
    },
  },

  mark_read: {
    language: "JavaScript",
    template: [
      "ObjC.import('stdlib');",
      "const mail = Application('Mail');",
      "const account = mail.accounts.byName({{account_name}});",
      "const mailbox = account.mailboxes.byName({{mailbox_name}});",
      "const msgs = mailbox.messages.whose({id: {_equals: {{message_id}}}});",
      "if (msgs.length === 0) { JSON.stringify({error: 'Message not found'}); }",
      "else {",
      "  msgs[0].readStatus = {{read_status}};",
      "  JSON.stringify({success: true, message_id: {{message_id}}, read_status: {{read_status}}});",
      "}",
    ].join("\n"),
    params: {
      account_name: "text",
      mailbox_name: "text",
      message_id: "integer",
      read_status: "boolean",
    },
  },

  mark_flagged: {
    language: "JavaScript",
    template: [
      "ObjC.import('stdlib');",
      "const mail = Application('Mail');",
      "const account = mail.accounts.byName({{account_name}});",
      "const mailbox = account.mailboxes.byName({{mailbox_name}});",
      "const msgs = mailbox.messages.whose({id: {_equals: {{message_id}}}});",
      "if (msgs.length === 0) { JSON.stringify({error: 'Message not found'}); }",
      "else {",
      "  msgs[0].flaggedStatus = {{flagged_status}};",
      "  JSON.stringify({success: true, message_id: {{message_id}}, flagged_status: {{flagged_status}}});",
      "}",
    ].join("\n"),
    params: {
      account_name: "text",
      mailbox_name: "text",
      message_id: "integer",
      flagged_status: "boolean",
    },
  },

  delete_message: {
    language: "JavaScript",
    template: [
      "ObjC.import('stdlib');",
      "const mail = Application('Mail');",
      "const account = mail.accounts.byName({{account_name}});",
      "const mailbox = account.mailboxes.byName({{mailbox_name}});",
      "const msgs = mailbox.messages.whose({id: {_equals: {{message_id}}}});",
      "if (msgs.length === 0) { JSON.stringify({error: 'Message not found'}); }",
      "else {",
      "  mail.delete(msgs[0]);",
      "  JSON.stringify({success: true, message_id: {{message_id}}});",
      "}",
    ].join("\n"),
    params: {
      account_name: "text",
      mailbox_name: "text",
      message_id: "integer",
    },
  },

  move_message: {
    language: "JavaScript",
    template: [
      "ObjC.import('stdlib');",
      "const mail = Application('Mail');",
      "const account = mail.accounts.byName({{account_name}});",
      "const srcMailbox = account.mailboxes.byName({{source_mailbox}});",
      "const destMailbox = account.mailboxes.byName({{destination_mailbox}});",
      "const msgs = srcMailbox.messages.whose({id: {_equals: {{message_id}}}});",
      "if (msgs.length === 0) { JSON.stringify({error: 'Message not found'}); }",
      "else {",
      "  mail.move(msgs[0], {to: destMailbox});",
      "  JSON.stringify({success: true, message_id: {{message_id}}, destination: {{destination_mailbox}}});",
      "}",
    ].join("\n"),
    params: {
      account_name: "text",
      source_mailbox: "text",
      destination_mailbox: "text",
      message_id: "integer",
    },
  },
};
