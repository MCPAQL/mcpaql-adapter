/**
 * Type serialization contract for AppleScript <-> JSON conversion.
 *
 * Handles two directions:
 * 1. JSON -> AppleScript: Serializing MCP-AQL parameter values into AppleScript
 *    literals. Handled by the sanitizer module (sanitizeParam).
 * 2. AppleScript -> JSON: Parsing osascript stdout into structured JSON.
 *    This module handles direction 2.
 *
 * Design: JXA (JavaScript for Automation) is preferred because it outputs
 * JSON natively via JSON.stringify(). When AppleScript output must be parsed,
 * this module provides a best-effort parser for common AppleScript value formats.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Parse the output from an osascript execution into a JSON-compatible value.
 *
 * @param stdout - The raw stdout string from osascript
 * @param language - The scripting language that produced the output
 * @returns The parsed value (object, array, string, number, boolean, or null)
 */
export function parseScriptOutput(
  stdout: string,
  language: "AppleScript" | "JavaScript",
): unknown {
  const trimmed = stdout.trim();

  if (trimmed === "") {
    return null;
  }

  if (language === "JavaScript") {
    return parseJxaOutput(trimmed);
  }

  return parseAppleScriptOutput(trimmed);
}

/**
 * Parse JXA output, which is expected to be valid JSON.
 */
function parseJxaOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    // JXA sometimes outputs bare values (e.g., `42`, `true`, `undefined`)
    if (output === "undefined" || output === "null") {
      return null;
    }

    if (output === "true") {
      return true;
    }

    if (output === "false") {
      return false;
    }

    const num = Number(output);
    if (!isNaN(num) && output !== "") {
      return num;
    }

    // Return as plain string if not parseable
    return output;
  }
}

/**
 * Parse AppleScript output into a JSON-compatible value.
 *
 * AppleScript output formats:
 * - Strings: no quotes, just raw text
 * - Numbers: plain digits
 * - Booleans: "true" or "false"
 * - Lists: "item1, item2, item3"
 * - Records: "key1:value1, key2:value2"
 * - Missing value: "missing value"
 * - Dates: "date \"...\""
 *
 * This is necessarily heuristic; JXA is strongly preferred for reliable output.
 */
function parseAppleScriptOutput(output: string): unknown {
  // Missing value
  if (output === "missing value") {
    return null;
  }

  // Boolean
  if (output === "true") {
    return true;
  }
  if (output === "false") {
    return false;
  }

  // Number (integer or real)
  if (/^-?\d+$/.test(output)) {
    return parseInt(output, 10);
  }
  if (/^-?\d+\.\d+$/.test(output)) {
    return parseFloat(output);
  }

  // AppleScript list output: comma-separated values
  // This is ambiguous (a string could contain commas) so we only attempt
  // this when the output looks like a list (starts/ends don't have quotes).
  if (output.includes(", ") && !output.startsWith("{") && !output.includes(":")) {
    const items = splitAppleScriptList(output);
    if (items.length > 1) {
      return items.map((item) => parseAppleScriptOutput(item.trim()));
    }
  }

  // Return as plain string
  return output;
}

/**
 * Split an AppleScript list output by commas, respecting nested structures.
 * Simple heuristic: split on ", " that isn't inside quotes.
 */
function splitAppleScriptList(output: string): string[] {
  const items: string[] = [];
  let current = "";
  let depth = 0;
  let inQuote = false;

  for (let i = 0; i < output.length; i++) {
    const char = output[i];

    if (char === '"' && (i === 0 || output[i - 1] !== "\\")) {
      inQuote = !inQuote;
    }

    if (!inQuote) {
      if (char === "{" || char === "(") {
        depth++;
      }
      if (char === "}" || char === ")") {
        depth--;
      }

      if (char === "," && depth === 0 && output[i + 1] === " ") {
        items.push(current.trim());
        current = "";
        i++; // skip space after comma
        continue;
      }
    }

    current += char;
  }

  if (current.trim()) {
    items.push(current.trim());
  }

  return items;
}

/**
 * Build a JXA script that wraps an operation in JSON.stringify for reliable output.
 *
 * @param application - The target application name
 * @param scriptBody - The JXA expression to evaluate (should return a value)
 * @returns A complete JXA script that outputs JSON to stdout
 */
export function wrapJxaForJsonOutput(application: string, scriptBody: string): string {
  return [
    "ObjC.import('stdlib');",
    `const app = Application(${JSON.stringify(application)});`,
    "app.includeStandardAdditions = true;",
    `const _result = (function() { ${scriptBody} })();`,
    "JSON.stringify(_result);",
  ].join("\n");
}
