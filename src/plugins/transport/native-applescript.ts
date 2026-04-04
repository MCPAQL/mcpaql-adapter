/**
 * Native AppleScript Transport Plugin for MCP-AQL.
 *
 * Executes operations against macOS applications via osascript (AppleScript/JXA).
 * This transport replaces the HTTP transport for local macOS application automation.
 *
 * The transport:
 * 1. Parses `maps_to` directives that reference AppleScript commands
 * 2. Sanitizes all parameters to prevent injection (see sanitizer.ts)
 * 3. Builds parameterized scripts from templates
 * 4. Executes via `osascript` subprocess
 * 5. Parses output into JSON-compatible results
 *
 * Security model:
 * - ALL parameter values are sanitized before interpolation (no raw user input in scripts)
 * - Script templates are static and defined in the adapter schema (not user-provided)
 * - osascript runs with the current user's permissions (no privilege escalation)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  AppleScriptParamType,
  NativeAppleScriptConfig,
  ScriptResult,
  ScriptTemplate,
  ScriptingLanguage,
} from "./types.js";
import { interpolateTemplate, sanitizeParam } from "./sanitizer.js";
import { parseScriptOutput, wrapJxaForJsonOutput } from "./serializer.js";

const execFileAsync = promisify(execFile);

/**
 * Default timeout for osascript execution (30 seconds).
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Maximum output size from osascript (10 MB).
 */
const MAX_OUTPUT_SIZE = 10 * 1024 * 1024;

export interface TransportSendOptions {
  timeout?: number;
}

export interface NativeTransportResult {
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    stderr?: string;
  };
}

/**
 * Execute a raw osascript command and return the result.
 * This is the lowest-level execution primitive.
 *
 * @param script - The complete script text to execute
 * @param language - The scripting language
 * @param timeoutMs - Execution timeout in milliseconds
 * @returns The script execution result
 */
export async function executeOsascript(
  script: string,
  language: ScriptingLanguage = "JavaScript",
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ScriptResult> {
  const args = language === "JavaScript"
    ? ["-l", "JavaScript", "-e", script]
    : ["-e", script];

  try {
    const { stdout, stderr } = await execFileAsync("/usr/bin/osascript", args, {
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_SIZE,
      env: { ...process.env },
    });

    const parsed = parseScriptOutput(stdout, language);

    return {
      ok: true,
      stdout,
      stderr,
      exitCode: 0,
      parsed,
    };
  } catch (error: unknown) {
    const execError = error as {
      code?: string;
      killed?: boolean;
      signal?: string;
      stdout?: string;
      stderr?: string;
      status?: number;
    };

    if (execError.killed || execError.signal === "SIGTERM") {
      return {
        ok: false,
        stdout: execError.stdout ?? "",
        stderr: `Script execution timed out after ${timeoutMs}ms.`,
        exitCode: -1,
      };
    }

    return {
      ok: false,
      stdout: execError.stdout ?? "",
      stderr: execError.stderr ?? (error instanceof Error ? error.message : String(error)),
      exitCode: execError.status ?? 1,
    };
  }
}

/**
 * Build a complete script from a template and parameters.
 * Sanitizes all parameters before interpolation.
 *
 * @param template - The script template
 * @param params - Raw parameter values from the MCP-AQL request
 * @returns The complete, safe-to-execute script text
 */
export function buildScript(
  template: ScriptTemplate,
  params: Record<string, unknown>,
): string {
  const sanitized: Record<string, string> = {};

  for (const [name, expectedType] of Object.entries(template.params)) {
    const value = params[name];
    if (value === undefined) {
      continue; // Optional params may be absent; template must handle this
    }
    sanitized[name] = sanitizeParam(name, value, expectedType, template.language);
  }

  return interpolateTemplate(template.template, sanitized);
}

/**
 * Execute an operation against a macOS application.
 *
 * @param config - Transport configuration
 * @param template - The parameterized script template
 * @param params - Raw parameter values
 * @param options - Execution options
 * @returns The operation result
 */
export async function executeOperation(
  config: NativeAppleScriptConfig,
  template: ScriptTemplate,
  params: Record<string, unknown>,
  options?: TransportSendOptions,
): Promise<NativeTransportResult> {
  const timeoutMs = options?.timeout ?? config.timeout ?? DEFAULT_TIMEOUT_MS;
  const script = buildScript(template, params);
  const result = await executeOsascript(script, template.language, timeoutMs);

  if (!result.ok) {
    return {
      success: false,
      error: {
        code: "TRANSPORT_NATIVE_EXECUTION_ERROR",
        message: `AppleScript execution failed: ${result.stderr}`,
        stderr: result.stderr,
      },
    };
  }

  return {
    success: true,
    data: result.parsed ?? result.stdout,
  };
}

/**
 * Predefined JXA templates for common Apple Mail operations.
 * These serve as the reference implementation for the native-applescript
 * transport applied to Mail.app.
 */
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
      limit: "integer",
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
      limit: "integer",
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
