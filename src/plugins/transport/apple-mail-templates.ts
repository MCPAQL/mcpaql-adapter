/**
 * Predefined JXA templates for common Apple Mail operations.
 *
 * These serve as the reference implementation for the native-applescript
 * transport applied to Mail.app. Extracted from native-applescript.ts to
 * decouple the generic transport from Mail-specific knowledge.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { ScriptTemplate } from "./types.js";

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
      "  unread_count: m.unreadCount(),",
      "  message_count: m.messages.length",
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
      "ObjC.import('stdlib');",
      "const mail = Application('Mail');",
      "const account = mail.accounts.byName({{account_name}});",
      "const mailbox = account.mailboxes.byName({{mailbox_name}});",
      "const limit = {{limit}};",
      "const msgs = mailbox.messages();",
      "const count = Math.min(msgs.length, limit);",
      "const result = [];",
      "for (let i = 0; i < count; i++) {",
      "  const m = msgs[i];",
      "  result.push({",
      "    id: m.id(),",
      "    subject: m.subject(),",
      "    sender: m.sender(),",
      "    date_received: m.dateReceived().toISOString(),",
      "    read_status: m.readStatus(),",
      "    flagged_status: m.flaggedStatus(),",
      "    message_size: m.messageSize()",
      "  });",
      "}",
      "JSON.stringify(result);",
    ].join("\n"),
    params: {
      account_name: "text",
      mailbox_name: "text",
      limit: { type: "integer", optional: true },
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

  search_messages: {
    language: "JavaScript",
    template: [
      "ObjC.import('stdlib');",
      "const mail = Application('Mail');",
      "const account = mail.accounts.byName({{account_name}});",
      "const mailbox = account.mailboxes.byName({{mailbox_name}});",
      "const query = {{query}};",
      "const limit = {{limit}};",
      "const msgs = mailbox.messages.whose({subject: {_contains: query}});",
      "const count = Math.min(msgs.length, limit);",
      "const result = [];",
      "for (let i = 0; i < count; i++) {",
      "  const m = msgs[i];",
      "  result.push({",
      "    id: m.id(),",
      "    subject: m.subject(),",
      "    sender: m.sender(),",
      "    date_received: m.dateReceived().toISOString(),",
      "    read_status: m.readStatus()",
      "  });",
      "}",
      "JSON.stringify(result);",
    ].join("\n"),
    params: {
      account_name: "text",
      mailbox_name: "text",
      query: "text",
      limit: { type: "integer", optional: true },
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
