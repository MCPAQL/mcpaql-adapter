/**
 * Tests for the native-applescript parameter sanitizer.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeParam, interpolateTemplate, SanitizationError } from "../src/plugins/transport/sanitizer.js";

// --- Text sanitization ---

test("sanitizeParam text: wraps simple string in AppleScript quotes", () => {
  const result = sanitizeParam("name", "hello", "text", "AppleScript");
  assert.equal(result, '"hello"');
});

test("sanitizeParam text: escapes double quotes in AppleScript", () => {
  const result = sanitizeParam("name", 'say "hi"', "text", "AppleScript");
  assert.equal(result, '"say \\"hi\\""');
});

test("sanitizeParam text: escapes backslashes in AppleScript", () => {
  const result = sanitizeParam("path", "C:\\Users\\test", "text", "AppleScript");
  assert.equal(result, '"C:\\\\Users\\\\test"');
});

test("sanitizeParam text: converts newlines to \\n in AppleScript", () => {
  const result = sanitizeParam("body", "line1\nline2", "text", "AppleScript");
  assert.equal(result, '"line1\\nline2"');
});

test("sanitizeParam text: converts \\r\\n to \\n in AppleScript", () => {
  const result = sanitizeParam("body", "line1\r\nline2", "text", "AppleScript");
  assert.equal(result, '"line1\\nline2"');
});

test("sanitizeParam text: converts tabs to \\t in AppleScript", () => {
  const result = sanitizeParam("body", "col1\tcol2", "text", "AppleScript");
  assert.equal(result, '"col1\\tcol2"');
});

test("sanitizeParam text: uses JSON.stringify for JavaScript", () => {
  const result = sanitizeParam("name", 'say "hi"', "text", "JavaScript");
  assert.equal(result, '"say \\"hi\\""');
});

test("sanitizeParam text: rejects null bytes", () => {
  assert.throws(
    () => sanitizeParam("name", "abc\x00def", "text"),
    SanitizationError,
  );
});

test("sanitizeParam text: rejects strings exceeding max length", () => {
  const longString = "a".repeat(100_001);
  assert.throws(
    () => sanitizeParam("name", longString, "text"),
    (error: unknown) => error instanceof SanitizationError && error.code === "SANITIZE_STRING_TOO_LONG",
  );
});

test("sanitizeParam text: throws SanitizationError for non-string text value", () => {
  assert.throws(
    () => sanitizeParam("name", 42, "text"),
    (error: unknown) =>
      error instanceof SanitizationError &&
      error.code === "SANITIZE_TYPE_MISMATCH" &&
      error.message.includes("name") &&
      error.message.includes("number"),
  );
});

test("sanitizeParam text: throws SanitizationError for boolean text value", () => {
  assert.throws(
    () => sanitizeParam("flag", true, "text"),
    (error: unknown) =>
      error instanceof SanitizationError &&
      error.code === "SANITIZE_TYPE_MISMATCH",
  );
});

// --- Injection prevention ---

test("sanitizeParam text: prevents tell application injection via quotes", () => {
  // Attempt to inject: close quote, inject command, open quote for remainder
  const malicious = '" & (do shell script "rm -rf /") & "';
  const result = sanitizeParam("name", malicious, "text", "AppleScript");
  // The entire string should be safely escaped inside quotes
  assert.match(result, /^"/);
  assert.match(result, /"$/);
  // The injected quotes should be escaped
  assert.ok(result.includes('\\"'));
  // It should NOT contain an unescaped closing quote followed by &
  assert.ok(!result.match(/[^\\]" &/));
});

test("sanitizeParam text: prevents injection via backslash-quote sequences", () => {
  const malicious = '\\" & (do shell script "echo pwned") & \\"';
  const result = sanitizeParam("name", malicious, "text", "AppleScript");
  // The result should be a single quoted string. The backslashes and quotes
  // from the input are all escaped, so the entire value is data, not code.
  // Verify it starts and ends with the outer quotes:
  assert.match(result, /^"/);
  assert.match(result, /"$/);
  // The backslashes from the input (\") should be double-escaped (\\\\")
  // so they cannot break out of the string literal:
  assert.ok(result.includes("\\\\"), "Backslashes from input should be escaped");
  assert.ok(result.includes('\\"'), "Quotes from input should be escaped");
});

// --- Integer sanitization ---

test("sanitizeParam integer: accepts valid integer", () => {
  assert.equal(sanitizeParam("count", 42, "integer"), "42");
});

test("sanitizeParam integer: accepts string that parses to integer", () => {
  assert.equal(sanitizeParam("count", "42", "integer"), "42");
});

test("sanitizeParam integer: accepts zero", () => {
  assert.equal(sanitizeParam("count", 0, "integer"), "0");
});

test("sanitizeParam integer: accepts negative integer", () => {
  assert.equal(sanitizeParam("count", -5, "integer"), "-5");
});

test("sanitizeParam integer: rejects float", () => {
  assert.throws(
    () => sanitizeParam("count", 3.14, "integer"),
    (error: unknown) => error instanceof SanitizationError && error.code === "SANITIZE_NOT_INTEGER",
  );
});

test("sanitizeParam integer: rejects NaN", () => {
  assert.throws(
    () => sanitizeParam("count", NaN, "integer"),
    (error: unknown) => error instanceof SanitizationError && error.code === "SANITIZE_INVALID_INTEGER",
  );
});

test("sanitizeParam integer: rejects Infinity", () => {
  assert.throws(
    () => sanitizeParam("count", Infinity, "integer"),
    (error: unknown) => error instanceof SanitizationError && error.code === "SANITIZE_INVALID_INTEGER",
  );
});

test("sanitizeParam integer: rejects non-numeric string", () => {
  assert.throws(
    () => sanitizeParam("count", "abc", "integer"),
    SanitizationError,
  );
});

// --- Real sanitization ---

test("sanitizeParam real: accepts float", () => {
  assert.equal(sanitizeParam("price", 3.14, "real"), "3.14");
});

test("sanitizeParam real: accepts integer as real", () => {
  assert.equal(sanitizeParam("price", 42, "real"), "42");
});

test("sanitizeParam real: rejects NaN", () => {
  assert.throws(
    () => sanitizeParam("price", NaN, "real"),
    (error: unknown) => error instanceof SanitizationError && error.code === "SANITIZE_INVALID_REAL",
  );
});

// --- Boolean sanitization ---

test("sanitizeParam boolean: accepts true", () => {
  assert.equal(sanitizeParam("flag", true, "boolean"), "true");
});

test("sanitizeParam boolean: accepts false", () => {
  assert.equal(sanitizeParam("flag", false, "boolean"), "false");
});

test("sanitizeParam boolean: accepts string 'true'", () => {
  assert.equal(sanitizeParam("flag", "true", "boolean"), "true");
});

test("sanitizeParam boolean: accepts number 1", () => {
  assert.equal(sanitizeParam("flag", 1, "boolean"), "true");
});

test("sanitizeParam boolean: rejects invalid value", () => {
  assert.throws(
    () => sanitizeParam("flag", "yes", "boolean"),
    SanitizationError,
  );
});

// --- List sanitization ---

test("sanitizeParam list: serializes array for JavaScript", () => {
  const result = sanitizeParam("items", ["a", "b"], "list", "JavaScript");
  assert.equal(result, '["a", "b"]');
});

test("sanitizeParam list: serializes array for AppleScript", () => {
  const result = sanitizeParam("items", ["a", "b"], "list", "AppleScript");
  assert.equal(result, '{"a", "b"}');
});

test("sanitizeParam list: handles mixed types", () => {
  const result = sanitizeParam("items", ["hello", 42, true], "list", "JavaScript");
  assert.equal(result, '["hello", 42, true]');
});

test("sanitizeParam list: rejects non-array", () => {
  assert.throws(
    () => sanitizeParam("items", "not an array", "list"),
    SanitizationError,
  );
});

test("sanitizeParam list: rejects excessive nesting", () => {
  // Build a deeply nested array
  let value: unknown = ["leaf"];
  for (let i = 0; i < 7; i++) {
    value = [value];
  }
  assert.throws(
    () => sanitizeParam("items", value, "list", "JavaScript"),
    (error: unknown) => error instanceof SanitizationError && error.code === "SANITIZE_NESTING_DEPTH",
  );
});

// --- Record sanitization ---

test("sanitizeParam record: serializes object for JavaScript", () => {
  const result = sanitizeParam("data", { key: "value" }, "record", "JavaScript");
  assert.equal(result, '{"key": "value"}');
});

test("sanitizeParam record: serializes object for AppleScript", () => {
  const result = sanitizeParam("data", { name: "test" }, "record", "AppleScript");
  assert.equal(result, '{name:"test"}');
});

test("sanitizeParam record: rejects non-identifier keys in AppleScript", () => {
  assert.throws(
    () => sanitizeParam("data", { "bad key": "value" }, "record", "AppleScript"),
    (error: unknown) => error instanceof SanitizationError && error.code === "SANITIZE_INVALID_IDENTIFIER",
  );
});

test("sanitizeParam record: allows non-identifier keys in JavaScript", () => {
  // JSON keys can be anything
  const result = sanitizeParam("data", { "bad key": "value" }, "record", "JavaScript");
  assert.equal(result, '{"bad key": "value"}');
});

// --- Missing value ---

test("sanitizeParam missing value: returns missing value for AppleScript", () => {
  assert.equal(sanitizeParam("opt", null, "missing value", "AppleScript"), "missing value");
});

test("sanitizeParam missing value: returns null for JavaScript", () => {
  assert.equal(sanitizeParam("opt", null, "missing value", "JavaScript"), "null");
});

test("sanitizeParam missing value: returns missing value for non-null", () => {
  assert.equal(sanitizeParam("opt", "ignored", "missing value", "AppleScript"), "missing value");
});

// --- Null handling ---

test("sanitizeParam: rejects null for non-missing-value types", () => {
  assert.throws(
    () => sanitizeParam("name", null, "text"),
    (error: unknown) => error instanceof SanitizationError && error.code === "SANITIZE_NULL_VALUE",
  );
});

test("sanitizeParam: rejects undefined for non-missing-value types", () => {
  assert.throws(
    () => sanitizeParam("name", undefined, "text"),
    SanitizationError,
  );
});

// --- Date sanitization ---

test("sanitizeParam date: accepts ISO date string for JavaScript", () => {
  const result = sanitizeParam("when", "2026-01-15T10:30:00Z", "date", "JavaScript");
  assert.match(result, /^new Date\(/);
});

test("sanitizeParam date: accepts ISO date string for AppleScript", () => {
  const result = sanitizeParam("when", "2026-01-15T10:30:00Z", "date", "AppleScript");
  assert.match(result, /^date "/);
});

test("sanitizeParam date: rejects invalid date string", () => {
  assert.throws(
    () => sanitizeParam("when", "not-a-date", "date"),
    (error: unknown) => error instanceof SanitizationError && error.code === "SANITIZE_INVALID_DATE",
  );
});

// --- Unknown type ---

test("sanitizeParam: rejects unknown type", () => {
  assert.throws(
    () => sanitizeParam("x", "val", "unknown_type" as any),
    (error: unknown) => error instanceof SanitizationError && error.code === "SANITIZE_UNKNOWN_TYPE",
  );
});

// --- Template interpolation ---

test("interpolateTemplate: substitutes parameters", () => {
  const result = interpolateTemplate(
    'tell application "Mail" to get name of account {{account_name}}',
    { account_name: '"iCloud"' },
  );
  assert.equal(result, 'tell application "Mail" to get name of account "iCloud"');
});

test("interpolateTemplate: substitutes multiple parameters", () => {
  const result = interpolateTemplate(
    "const limit = {{limit}}; const name = {{name}};",
    { limit: "10", name: '"INBOX"' },
  );
  assert.equal(result, 'const limit = 10; const name = "INBOX";');
});

test("interpolateTemplate: throws on undefined parameter", () => {
  assert.throws(
    () => interpolateTemplate("{{missing}}", {}),
    /Template references undefined parameter 'missing'/,
  );
});

test("interpolateTemplate: throws SanitizationError for undefined parameter", () => {
  assert.throws(
    () => interpolateTemplate("{{missing}}", {}),
    (error: unknown) => error instanceof SanitizationError && error.code === "SANITIZE_UNDEFINED_PARAM",
  );
});

test("interpolateTemplate: handles no placeholders", () => {
  const result = interpolateTemplate("no params here", {});
  assert.equal(result, "no params here");
});
