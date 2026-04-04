/**
 * Tests for the native-applescript output serializer.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseScriptOutput, wrapJxaForJsonOutput } from "../src/plugins/transport/serializer.js";

// --- JXA output parsing ---

test("parseScriptOutput JXA: parses JSON object", () => {
  const result = parseScriptOutput('{"name":"test","count":42}', "JavaScript");
  assert.deepEqual(result, { name: "test", count: 42 });
});

test("parseScriptOutput JXA: parses JSON array", () => {
  const result = parseScriptOutput('[1, 2, 3]', "JavaScript");
  assert.deepEqual(result, [1, 2, 3]);
});

test("parseScriptOutput JXA: parses JSON string", () => {
  const result = parseScriptOutput('"hello"', "JavaScript");
  assert.equal(result, "hello");
});

test("parseScriptOutput JXA: parses JSON number", () => {
  const result = parseScriptOutput("42", "JavaScript");
  assert.equal(result, 42);
});

test("parseScriptOutput JXA: parses JSON boolean true", () => {
  const result = parseScriptOutput("true", "JavaScript");
  assert.equal(result, true);
});

test("parseScriptOutput JXA: parses JSON boolean false", () => {
  const result = parseScriptOutput("false", "JavaScript");
  assert.equal(result, false);
});

test("parseScriptOutput JXA: parses JSON null", () => {
  const result = parseScriptOutput("null", "JavaScript");
  assert.equal(result, null);
});

test("parseScriptOutput JXA: handles undefined output", () => {
  const result = parseScriptOutput("undefined", "JavaScript");
  assert.equal(result, null);
});

test("parseScriptOutput JXA: handles empty output", () => {
  const result = parseScriptOutput("", "JavaScript");
  assert.equal(result, null);
});

test("parseScriptOutput JXA: handles whitespace-only output", () => {
  const result = parseScriptOutput("   \n  ", "JavaScript");
  assert.equal(result, null);
});

test("parseScriptOutput JXA: returns plain string for unparseable output", () => {
  const result = parseScriptOutput("some random text", "JavaScript");
  assert.equal(result, "some random text");
});

test("parseScriptOutput JXA: parses floating point number", () => {
  const result = parseScriptOutput("3.14", "JavaScript");
  assert.equal(result, 3.14);
});

// --- AppleScript output parsing ---

test("parseScriptOutput AppleScript: parses missing value", () => {
  const result = parseScriptOutput("missing value", "AppleScript");
  assert.equal(result, null);
});

test("parseScriptOutput AppleScript: parses boolean true", () => {
  const result = parseScriptOutput("true", "AppleScript");
  assert.equal(result, true);
});

test("parseScriptOutput AppleScript: parses boolean false", () => {
  const result = parseScriptOutput("false", "AppleScript");
  assert.equal(result, false);
});

test("parseScriptOutput AppleScript: parses integer", () => {
  const result = parseScriptOutput("42", "AppleScript");
  assert.equal(result, 42);
});

test("parseScriptOutput AppleScript: parses negative integer", () => {
  const result = parseScriptOutput("-5", "AppleScript");
  assert.equal(result, -5);
});

test("parseScriptOutput AppleScript: parses real number", () => {
  const result = parseScriptOutput("3.14", "AppleScript");
  assert.equal(result, 3.14);
});

test("parseScriptOutput AppleScript: parses comma-separated list", () => {
  const result = parseScriptOutput("INBOX, Drafts, Sent Messages", "AppleScript");
  assert.deepEqual(result, ["INBOX", "Drafts", "Sent Messages"]);
});

test("parseScriptOutput AppleScript: returns plain string for single value", () => {
  const result = parseScriptOutput("INBOX", "AppleScript");
  assert.equal(result, "INBOX");
});

test("parseScriptOutput AppleScript: handles empty output", () => {
  const result = parseScriptOutput("", "AppleScript");
  assert.equal(result, null);
});

// --- JXA wrapper ---

test("wrapJxaForJsonOutput: generates valid JXA wrapper", () => {
  const script = wrapJxaForJsonOutput("Mail", "return app.accounts().length;");
  assert.match(script, /ObjC\.import\('stdlib'\)/);
  assert.match(script, /Application\("Mail"\)/);
  assert.match(script, /JSON\.stringify\(_result\)/);
  assert.match(script, /return app\.accounts\(\)\.length;/);
});

test("wrapJxaForJsonOutput: escapes application name", () => {
  const script = wrapJxaForJsonOutput('My "App"', "return 1;");
  assert.match(script, /Application\("My \\"App\\""\)/);
});
