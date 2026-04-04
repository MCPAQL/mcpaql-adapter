/**
 * Types for the native-applescript transport plugin.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * The scripting language used to execute commands.
 * - "AppleScript" uses `osascript -e`
 * - "JavaScript" uses `osascript -l JavaScript -e` (JXA) for JSON-native output
 */
export type ScriptingLanguage = "AppleScript" | "JavaScript";

/**
 * Configuration for the native-applescript transport plugin.
 * Provided in the adapter schema's `target` section.
 */
export interface NativeAppleScriptConfig {
  /**
   * The macOS application to target.
   * Used for `tell application "<app>"` blocks.
   */
  application: string;

  /**
   * Default timeout for osascript execution in milliseconds.
   * @default 30000
   */
  timeout?: number;

  /**
   * Preferred scripting language.
   * JXA is preferred for JSON-native output; AppleScript is the fallback.
   * @default "JavaScript"
   */
  language?: ScriptingLanguage;
}

/**
 * Definition of a single parameter within a script template.
 */
export interface ScriptParamDef {
  /**
   * The expected AppleScript type for this parameter.
   */
  type: AppleScriptParamType;

  /**
   * Whether this parameter is optional.
   * Optional parameters may be omitted without error; the template must
   * handle missing values (e.g., provide a default in the script body).
   * @default false
   */
  optional?: boolean;
}

/**
 * A parameterized AppleScript template.
 * Parameters are referenced as `{{param_name}}` in the template text.
 * All parameters are sanitized before interpolation.
 */
export interface ScriptTemplate {
  /**
   * The scripting language for this template.
   */
  language: ScriptingLanguage;

  /**
   * The template text with `{{param_name}}` placeholders.
   */
  template: string;

  /**
   * Expected parameter names and their AppleScript types.
   * Used for validation and serialization.
   *
   * Each value may be either a bare type string (shorthand for required params)
   * or a full `ScriptParamDef` object that includes an `optional` flag.
   */
  params: Record<string, AppleScriptParamType | ScriptParamDef>;
}

/**
 * AppleScript parameter types supported by the serializer.
 */
export type AppleScriptParamType =
  | "text"
  | "integer"
  | "real"
  | "boolean"
  | "list"
  | "record"
  | "date"
  | "missing value";

/**
 * Result from executing an AppleScript via osascript.
 */
export interface ScriptResult {
  /**
   * Whether the script executed successfully (exit code 0).
   */
  ok: boolean;

  /**
   * The stdout output from osascript.
   */
  stdout: string;

  /**
   * The stderr output from osascript.
   */
  stderr: string;

  /**
   * The exit code from osascript.
   */
  exitCode: number;

  /**
   * The parsed JSON output (when using JXA).
   * `undefined` when output is not valid JSON.
   */
  parsed?: unknown;
}