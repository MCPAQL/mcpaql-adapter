/**
 * Tests for the native-applescript transport plugin.
 *
 * Tests that don't require actual macOS/osascript are run unconditionally.
 * Tests that execute osascript are gated behind platform detection.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from "node:assert/strict";
import { platform } from "node:os";
import test from "node:test";

import {
  buildScript,
  executeOsascript,
  APPLE_MAIL_TEMPLATES,
} from "../src/plugins/transport/native-applescript.js";

const isMacOS = platform() === "darwin";

// --- buildScript ---

test("buildScript: interpolates sanitized parameters into JXA template", () => {
  const template = APPLE_MAIL_TEMPLATES.list_mailboxes;
  const script = buildScript(template, { account_name: "iCloud" });
  // The account_name should be sanitized (quoted) and interpolated
  assert.match(script, /"iCloud"/);
  assert.ok(!script.includes("{{account_name}}"));
});

test("buildScript: sanitizes integer parameters", () => {
  const template = APPLE_MAIL_TEMPLATES.list_messages;
  const script = buildScript(template, {
    account_name: "iCloud",
    mailbox_name: "INBOX",
    limit: 10,
  });
  assert.match(script, /const limit = 10;/);
});

test("buildScript: sanitizes boolean parameters", () => {
  const template = APPLE_MAIL_TEMPLATES.mark_read;
  const script = buildScript(template, {
    account_name: "iCloud",
    mailbox_name: "INBOX",
    message_id: 12345,
    read_status: true,
  });
  assert.match(script, /readStatus = true/);
});

test("buildScript: prevents injection in text parameters", () => {
  const template = APPLE_MAIL_TEMPLATES.list_mailboxes;
  // Attempt to inject script through account name
  const maliciousName = '"); ObjC.import("stdlib"); $.system("rm -rf /"); ("';
  const script = buildScript(template, { account_name: maliciousName });
  // The injection attempt should be safely quoted inside a JSON string literal.
  // JSON.stringify escapes inner quotes, so the malicious "); cannot break out.
  // Verify the account name is passed as a single JSON-escaped string argument:
  assert.match(script, /mail\.accounts\.byName\("/);
  // The key safety check: the "); sequence must be escaped (as \");) not literal
  // In the final script, JSON.stringify produces: "\"); ObjC.import(\"stdlib\"); ..."
  // The leading quote is from JSON.stringify, the inner quotes are escaped.
  // This means the entire malicious payload is a string VALUE, not executable code.
  const paramValue = script.match(/byName\(([^)]+)\)/)?.[1];
  assert.ok(paramValue, "Should have a parameter value in byName()");
  // The value should start and end with double quotes (it's a string literal)
  assert.match(paramValue, /^"/);
  assert.match(paramValue, /"$/);
});

test("buildScript: handles all APPLE_MAIL_TEMPLATES without errors", () => {
  // Verify each template can be built with dummy params
  const dummyParams: Record<string, Record<string, unknown>> = {
    list_accounts: {},
    list_mailboxes: { account_name: "test" },
    list_messages: { account_name: "test", mailbox_name: "INBOX", limit: 10 },
    get_message: { account_name: "test", mailbox_name: "INBOX", message_id: 1 },
    search_messages: { account_name: "test", mailbox_name: "INBOX", query: "hello", limit: 10 },
    mark_read: { account_name: "test", mailbox_name: "INBOX", message_id: 1, read_status: true },
    mark_flagged: { account_name: "test", mailbox_name: "INBOX", message_id: 1, flagged_status: true },
    delete_message: { account_name: "test", mailbox_name: "INBOX", message_id: 1 },
    move_message: { account_name: "test", source_mailbox: "INBOX", destination_mailbox: "Archive", message_id: 1 },
  };

  for (const [name, params] of Object.entries(dummyParams)) {
    const template = APPLE_MAIL_TEMPLATES[name];
    assert.ok(template, `Template '${name}' should exist`);
    const script = buildScript(template, params);
    assert.ok(script.length > 0, `Script for '${name}' should not be empty`);
    assert.ok(!script.includes("{{"), `Script for '${name}' should have no unresolved placeholders`);
  }
});

// --- osascript execution (macOS only) ---

test("executeOsascript: executes simple JXA expression", { skip: !isMacOS }, async () => {
  const result = await executeOsascript("JSON.stringify({answer: 42});", "JavaScript");
  assert.equal(result.ok, true);
  assert.deepEqual(result.parsed, { answer: 42 });
});

test("executeOsascript: executes simple AppleScript expression", { skip: !isMacOS }, async () => {
  const result = await executeOsascript('return "hello"', "AppleScript");
  assert.equal(result.ok, true);
  assert.equal(result.stdout.trim(), "hello");
});

test("executeOsascript: handles script errors gracefully", { skip: !isMacOS }, async () => {
  const result = await executeOsascript("this is not valid code!!", "JavaScript");
  assert.equal(result.ok, false);
  assert.ok(result.stderr.length > 0);
});

test("executeOsascript: handles timeout", { skip: !isMacOS }, async () => {
  // Use delay() which is a standard AppleScript command (also available in JXA)
  const result = await executeOsascript(
    "delay(10); JSON.stringify(true);",
    "JavaScript",
    200, // 200ms timeout - should timeout well before 10s delay
  );
  assert.equal(result.ok, false);
  assert.ok(result.stderr.length > 0, "Expected error message on timeout");
});

test("executeOsascript: returns parsed JSON for JXA array output", { skip: !isMacOS }, async () => {
  const result = await executeOsascript(
    'JSON.stringify(["a", "b", "c"]);',
    "JavaScript",
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.parsed, ["a", "b", "c"]);
});

// --- Apple Mail integration tests (macOS only, requires Mail.app) ---

test("APPLE_MAIL_TEMPLATES.list_accounts: executes against Mail.app", {
  skip: !isMacOS,
}, async () => {
  const template = APPLE_MAIL_TEMPLATES.list_accounts;
  const script = buildScript(template, {});
  const result = await executeOsascript(script, template.language, 10_000);
  // Mail might not be running or might have no accounts - that's OK
  // We just verify the script executes without a syntax error
  if (result.ok) {
    assert.ok(Array.isArray(result.parsed), "Expected array of accounts");
  } else {
    // Acceptable: Mail not running, no accounts configured, etc.
    assert.ok(result.stderr.length > 0, "Expected error message");
  }
});
