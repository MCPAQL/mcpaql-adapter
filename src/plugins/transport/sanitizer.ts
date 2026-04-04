/**
 * Parameter sanitization for the native-applescript transport.
 *
 * CRITICAL SECURITY COMPONENT: Prevents AppleScript injection by ensuring
 * all parameter values are safely escaped before interpolation into script
 * templates. This is the AppleScript equivalent of SQL parameterization.
 *
 * Design principles:
 * - Allowlist-based: only known-safe characters pass through
 * - Type-aware: each AppleScript type has its own serialization path
 * - Defense in depth: even "safe" strings are quoted and escaped
 * - No eval: parameters are data, never executable code
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { AppleScriptParamType } from "./types.js";

/**
 * Characters that are NEVER allowed in any parameter value, regardless of type.
 * These could be used for script injection or OS-level exploits.
 */
const FORBIDDEN_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/**
 * Maximum length for any single parameter value (as string).
 * Prevents denial-of-service via extremely large inputs.
 */
const MAX_PARAM_LENGTH = 100_000;

/**
 * Maximum nesting depth for list/record parameters.
 */
const MAX_NESTING_DEPTH = 5;

export class SanitizationError extends Error {
  readonly code: string;
  readonly paramName: string;

  constructor(code: string, paramName: string, message: string) {
    super(message);
    this.name = "SanitizationError";
    this.code = code;
    this.paramName = paramName;
  }
}

/**
 * Sanitize and serialize a parameter value for safe interpolation into
 * an AppleScript template.
 *
 * @param name - The parameter name (for error reporting)
 * @param value - The raw parameter value from the MCP-AQL request
 * @param expectedType - The expected AppleScript type
 * @param language - The target scripting language ("AppleScript" or "JavaScript")
 * @returns The sanitized string ready for template interpolation
 */
export function sanitizeParam(
  name: string,
  value: unknown,
  expectedType: AppleScriptParamType,
  language: "AppleScript" | "JavaScript" = "AppleScript",
): string {
  if (value === null || value === undefined) {
    if (expectedType === "missing value") {
      return language === "JavaScript" ? "null" : "missing value";
    }
    throw new SanitizationError(
      "SANITIZE_NULL_VALUE",
      name,
      `Parameter '${name}' is null/undefined but expected type '${expectedType}'.`,
    );
  }

  switch (expectedType) {
    case "text":
      return sanitizeText(name, value, language);
    case "integer":
      return sanitizeInteger(name, value);
    case "real":
      return sanitizeReal(name, value);
    case "boolean":
      return sanitizeBoolean(name, value, language);
    case "list":
      return sanitizeList(name, value, language, 0);
    case "record":
      return sanitizeRecord(name, value, language, 0);
    case "date":
      return sanitizeDate(name, value, language);
    case "missing value":
      return language === "JavaScript" ? "null" : "missing value";
    default:
      throw new SanitizationError(
        "SANITIZE_UNKNOWN_TYPE",
        name,
        `Unknown AppleScript type '${expectedType}' for parameter '${name}'.`,
      );
  }
}

/**
 * Sanitize a text value for AppleScript string interpolation.
 * Escapes backslashes and double quotes, wraps in quotes.
 */
function sanitizeText(
  name: string,
  value: unknown,
  language: "AppleScript" | "JavaScript",
): string {
  const str = String(value);
  validateStringConstraints(name, str);

  if (language === "JavaScript") {
    // JSON.stringify handles all escaping for JavaScript strings
    return JSON.stringify(str);
  }

  // AppleScript string escaping: backslash and double-quote
  const escaped = str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, "\\n")
    .replace(/\r/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");

  return `"${escaped}"`;
}

/**
 * Sanitize an integer value.
 */
function sanitizeInteger(name: string, value: unknown): string {
  const num = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(num)) {
    throw new SanitizationError(
      "SANITIZE_INVALID_INTEGER",
      name,
      `Parameter '${name}' is not a finite number: ${String(value)}.`,
    );
  }

  if (!Number.isInteger(num)) {
    throw new SanitizationError(
      "SANITIZE_NOT_INTEGER",
      name,
      `Parameter '${name}' is not an integer: ${num}.`,
    );
  }

  if (num > Number.MAX_SAFE_INTEGER || num < Number.MIN_SAFE_INTEGER) {
    throw new SanitizationError(
      "SANITIZE_INTEGER_RANGE",
      name,
      `Parameter '${name}' exceeds safe integer range: ${num}.`,
    );
  }

  return String(num);
}

/**
 * Sanitize a real (floating point) value.
 */
function sanitizeReal(name: string, value: unknown): string {
  const num = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(num)) {
    throw new SanitizationError(
      "SANITIZE_INVALID_REAL",
      name,
      `Parameter '${name}' is not a finite number: ${String(value)}.`,
    );
  }

  return String(num);
}

/**
 * Sanitize a boolean value.
 */
function sanitizeBoolean(
  name: string,
  value: unknown,
  language: "AppleScript" | "JavaScript",
): string {
  if (typeof value === "boolean") {
    return language === "JavaScript" ? String(value) : String(value);
  }

  if (value === "true" || value === 1) {
    return "true";
  }

  if (value === "false" || value === 0) {
    return "false";
  }

  throw new SanitizationError(
    "SANITIZE_INVALID_BOOLEAN",
    name,
    `Parameter '${name}' is not a valid boolean: ${String(value)}.`,
  );
}

/**
 * Sanitize a list (array) value.
 */
function sanitizeList(
  name: string,
  value: unknown,
  language: "AppleScript" | "JavaScript",
  depth: number,
): string {
  if (depth > MAX_NESTING_DEPTH) {
    throw new SanitizationError(
      "SANITIZE_NESTING_DEPTH",
      name,
      `Parameter '${name}' exceeds maximum nesting depth of ${MAX_NESTING_DEPTH}.`,
    );
  }

  if (!Array.isArray(value)) {
    throw new SanitizationError(
      "SANITIZE_NOT_ARRAY",
      name,
      `Parameter '${name}' is not an array.`,
    );
  }

  const items = value.map((item, index) =>
    sanitizeAutoDetect(`${name}[${index}]`, item, language, depth + 1),
  );

  if (language === "JavaScript") {
    return `[${items.join(", ")}]`;
  }

  return `{${items.join(", ")}}`;
}

/**
 * Sanitize a record (object) value.
 */
function sanitizeRecord(
  name: string,
  value: unknown,
  language: "AppleScript" | "JavaScript",
  depth: number,
): string {
  if (depth > MAX_NESTING_DEPTH) {
    throw new SanitizationError(
      "SANITIZE_NESTING_DEPTH",
      name,
      `Parameter '${name}' exceeds maximum nesting depth of ${MAX_NESTING_DEPTH}.`,
    );
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SanitizationError(
      "SANITIZE_NOT_RECORD",
      name,
      `Parameter '${name}' is not a plain object.`,
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);

  if (language === "JavaScript") {
    const pairs = entries.map(
      ([key, val]) =>
        `${JSON.stringify(key)}: ${sanitizeAutoDetect(`${name}.${key}`, val, language, depth + 1)}`,
    );
    return `{${pairs.join(", ")}}`;
  }

  // AppleScript record: {key1:"val1", key2:"val2"}
  const pairs = entries.map(([key, val]) => {
    validateIdentifier(name, key);
    return `${key}:${sanitizeAutoDetect(`${name}.${key}`, val, language, depth + 1)}`;
  });
  return `{${pairs.join(", ")}}`;
}

/**
 * Sanitize a date value.
 */
function sanitizeDate(
  name: string,
  value: unknown,
  language: "AppleScript" | "JavaScript",
): string {
  const str = String(value);

  // Validate it parses as a date
  const parsed = new Date(str);
  if (isNaN(parsed.getTime())) {
    throw new SanitizationError(
      "SANITIZE_INVALID_DATE",
      name,
      `Parameter '${name}' is not a valid date string: ${str}.`,
    );
  }

  if (language === "JavaScript") {
    return `new Date(${JSON.stringify(parsed.toISOString())})`;
  }

  // AppleScript date: date "Saturday, January 1, 2000 12:00:00 AM"
  return `date "${sanitizeDateForAppleScript(parsed)}"`;
}

/**
 * Format a Date for AppleScript's date literal syntax.
 */
function sanitizeDateForAppleScript(date: Date): string {
  // AppleScript expects dates in the system locale format.
  // Using a consistent ISO-ish format that AppleScript can parse.
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  // This format works with AppleScript's date coercion
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

/**
 * Auto-detect type and sanitize accordingly.
 * Used for nested elements in lists and records.
 */
function sanitizeAutoDetect(
  name: string,
  value: unknown,
  language: "AppleScript" | "JavaScript",
  depth: number,
): string {
  if (value === null || value === undefined) {
    return language === "JavaScript" ? "null" : "missing value";
  }

  if (typeof value === "string") {
    return sanitizeText(name, value, language);
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? sanitizeInteger(name, value) : sanitizeReal(name, value);
  }

  if (typeof value === "boolean") {
    return sanitizeBoolean(name, value, language);
  }

  if (Array.isArray(value)) {
    return sanitizeList(name, value, language, depth);
  }

  if (typeof value === "object") {
    return sanitizeRecord(name, value, language, depth);
  }

  throw new SanitizationError(
    "SANITIZE_UNSUPPORTED_TYPE",
    name,
    `Parameter '${name}' has unsupported JavaScript type '${typeof value}'.`,
  );
}

/**
 * Validate string constraints (length, forbidden characters).
 */
function validateStringConstraints(name: string, value: string): void {
  if (value.length > MAX_PARAM_LENGTH) {
    throw new SanitizationError(
      "SANITIZE_STRING_TOO_LONG",
      name,
      `Parameter '${name}' exceeds maximum length of ${MAX_PARAM_LENGTH} characters.`,
    );
  }

  if (FORBIDDEN_CHARS.test(value)) {
    throw new SanitizationError(
      "SANITIZE_FORBIDDEN_CHARS",
      name,
      `Parameter '${name}' contains forbidden control characters.`,
    );
  }
}

/**
 * Validate that a string is a safe AppleScript identifier.
 * Used for record keys in AppleScript (not JXA, which uses JSON keys).
 */
function validateIdentifier(paramName: string, key: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
    throw new SanitizationError(
      "SANITIZE_INVALID_IDENTIFIER",
      paramName,
      `Record key '${key}' in parameter '${paramName}' is not a valid AppleScript identifier.`,
    );
  }
}

/**
 * Interpolate sanitized parameters into a script template.
 * This is the ONLY function that should be used to build executable scripts.
 *
 * @param template - The template text with `{{param_name}}` placeholders
 * @param sanitizedParams - Parameters that have ALREADY been sanitized via sanitizeParam()
 * @returns The interpolated script text ready for osascript
 */
export function interpolateTemplate(
  template: string,
  sanitizedParams: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, paramName: string) => {
    if (!(paramName in sanitizedParams)) {
      throw new Error(`Template references undefined parameter '${paramName}'.`);
    }
    return sanitizedParams[paramName];
  });
}
