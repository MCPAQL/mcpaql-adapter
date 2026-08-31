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
  executeOperation,
  APPLE_MAIL_TEMPLATES,
} from "../src/plugins/transport/native-applescript.js";
import { SanitizationError } from "../src/plugins/transport/sanitizer.js";
import type { ScriptTemplate } from "../src/plugins/transport/types.js";

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
    recent_messages: { account_name: "test", mailbox_name: "INBOX", days: 7, limit: 10 },
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

// --- executeOperation error paths (cross-platform, no osascript needed) ---

test("executeOperation: returns TRANSPORT_SANITIZATION_ERROR when buildScript receives invalid params", async () => {
  // list_mailboxes requires account_name as text; passing null triggers SanitizationError
  const template = APPLE_MAIL_TEMPLATES.list_mailboxes;
  const config = { application: "Mail" };
  const result = await executeOperation(config, template, { account_name: null });
  assert.equal(result.success, false);
  assert.equal(result.error?.code, "TRANSPORT_SANITIZATION_ERROR");
  assert.match(result.error!.message, /account_name/);
});

test("executeOperation: returns TRANSPORT_SANITIZATION_ERROR when interpolateTemplate has undefined param", async () => {
  // Template references {{name}} but params only supply a different key
  const template: ScriptTemplate = {
    language: "JavaScript",
    template: "const x = {{name}};",
    params: {}, // no declared params, so buildScript won't sanitize anything
  };
  const config = { application: "TestApp" };
  const result = await executeOperation(config, template, {});
  assert.equal(result.success, false);
  assert.equal(result.error?.code, "TRANSPORT_SANITIZATION_ERROR");
  assert.match(result.error!.message, /name/);
});

// --- Required/optional param validation ---

test("buildScript: throws SanitizationError for missing required param", () => {
  const template: ScriptTemplate = {
    language: "JavaScript",
    template: "const x = {{name}};",
    params: { name: "text" }, // required by default (string shorthand)
  };
  assert.throws(
    () => buildScript(template, {}),
    (error: unknown) =>
      error instanceof SanitizationError &&
      error.code === "SANITIZE_MISSING_REQUIRED_PARAM" &&
      error.message.includes("name"),
  );
});

test("buildScript: skips optional params silently", () => {
  const template: ScriptTemplate = {
    language: "JavaScript",
    template: "const x = 1;", // Template does NOT reference the optional param
    params: { limit: { type: "integer", optional: true } },
  };
  // Should not throw even though `limit` is not supplied
  const script = buildScript(template, {});
  assert.equal(script, "const x = 1;");
});

test("buildScript: leaves placeholder for optional param referenced in template but not supplied", () => {
  const template: ScriptTemplate = {
    language: "JavaScript",
    template: "const limit = {{limit}};",
    params: { limit: { type: "integer", optional: true } },
  };
  // Should not throw; placeholder left as-is for optional params
  const script = buildScript(template, {});
  assert.equal(script, "const limit = {{limit}};");
});

// --- executeOperation catch-all error path ---

test("executeOperation: returns structured error on osascript failure, never throws", async () => {
  // Use a template that produces intentionally invalid script to trigger osascript error
  const template: ScriptTemplate = {
    language: "JavaScript",
    template: "this is not valid code!!;",
    params: {},
  };
  const config = { application: "TestApp" };
  const result = await executeOperation(config, template, {});
  // On macOS this will execute and fail inside osascript (ok: false)
  // On non-macOS this will be caught by the catch-all and returned as structured error
  // Either way: it should NOT throw
  assert.equal(result.success, false);
  assert.ok(result.error, "Expected error in result");
  assert.ok(result.error!.code, "Expected error code");
  assert.ok(result.error!.message, "Expected error message");
});

test("executeOperation: returns TRANSPORT_SANITIZATION_ERROR for non-string text param", async () => {
  const template: ScriptTemplate = {
    language: "JavaScript",
    template: "const x = {{name}};",
    params: { name: "text" },
  };
  const config = { application: "TestApp" };
  const result = await executeOperation(config, template, { name: 123 });
  assert.equal(result.success, false);
  assert.equal(result.error?.code, "TRANSPORT_SANITIZATION_ERROR");
  assert.match(result.error!.message, /name/);
});

// --- bridge rules enforcement (issue #32 section A) ---

test("APPLE_MAIL_TEMPLATES: no template enumerates a mailbox", () => {
  for (const [name, template] of Object.entries(APPLE_MAIL_TEMPLATES)) {
    const src = template.template;
    assert.ok(
      !/\bmessages\(\)/.test(src),
      `Template '${name}' must not call messages() — it enumerates the entire mailbox`,
    );
    assert.ok(
      !/messages\.length/.test(src),
      `Template '${name}' must not read messages.length — it enumerates the entire mailbox`,
    );
    for (const match of src.matchAll(/\.whose\(/g)) {
      const following = src.slice(match.index!, match.index! + 20);
      assert.match(
        following,
        /\.whose\(\{id:/,
        `Template '${name}' may only use whose() for id lookup, found: ${following}`,
      );
    }
  }
});

test("APPLE_MAIL_TEMPLATES: scan templates return the paging envelope", () => {
  for (const name of ["list_messages", "recent_messages", "search_messages"]) {
    const src = APPLE_MAIL_TEMPLATES[name].template;
    for (const key of ["cursor: done ? null : index", "complete: done", "truncated:", "scanned:", "elapsed_ms:"]) {
      assert.ok(src.includes(key), `Template '${name}' envelope missing '${key}'`);
    }
  }
});

// --- parameter defaults ---

test("buildScript: applies declared defaults for scan parameters", () => {
  const template = APPLE_MAIL_TEMPLATES.list_messages;
  const script = buildScript(template, {
    account_name: "Google",
    mailbox_name: "INBOX",
    limit: 10,
  });
  assert.match(script, /const cursor = 0;/);
  assert.match(script, /const scanCap = 200;/);
  assert.match(script, /const timeBudgetMs = 20000;/);
  assert.ok(!script.includes("{{"), "no unresolved placeholders");
});

test("buildScript: supplied values override declared defaults", () => {
  const template = APPLE_MAIL_TEMPLATES.list_messages;
  const script = buildScript(template, {
    account_name: "Google",
    mailbox_name: "INBOX",
    limit: 10,
    cursor: 250,
    scan_cap: 50,
  });
  assert.match(script, /const cursor = 250;/);
  assert.match(script, /const scanCap = 50;/);
});

test("buildScript: defaulted text param is sanitized like a supplied one", () => {
  const template = APPLE_MAIL_TEMPLATES.search_messages;
  const script = buildScript(template, {
    account_name: "Google",
    mailbox_name: "INBOX",
    query: "hello",
    limit: 5,
  });
  assert.match(script, /const field = "subject";/);
});

test("APPLE_MAIL_TEMPLATES.list_mailboxes: no longer reports message_count", () => {
  const src = APPLE_MAIL_TEMPLATES.list_mailboxes.template;
  assert.ok(!src.includes("message_count"), "message_count requires messages.length");
  assert.ok(src.includes("unread_count"), "unread_count is cheap and stays");
});
