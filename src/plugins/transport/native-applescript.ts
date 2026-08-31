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
  ScriptParamDef,
  ScriptResult,
  ScriptTemplate,
  ScriptingLanguage,
} from "./types.js";
import { SanitizationError, interpolateTemplate, sanitizeParam } from "./sanitizer.js";
import { parseScriptOutput } from "./serializer.js";

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
  if (process.platform !== "darwin") {
    throw new Error("native-applescript transport requires macOS (darwin)");
  }

  const args = language === "JavaScript"
    ? ["-l", "JavaScript", "-e", script]
    : ["-e", script];

  try {
    const { stdout, stderr } = await execFileAsync("/usr/bin/osascript", args, {
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_SIZE,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USER: process.env.USER,
      },
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
 * Resolve a param definition entry to its type and optional flag.
 * Supports both the shorthand string form and the full object form.
 */
function resolveParamDef(
  entry: AppleScriptParamType | ScriptParamDef,
): { type: AppleScriptParamType; optional: boolean; defaultValue?: unknown } {
  if (typeof entry === "string") {
    return { type: entry, optional: false };
  }
  return {
    type: entry.type,
    optional: entry.optional === true,
    defaultValue: entry.default,
  };
}

/**
 * Build a complete script from a template and parameters.
 * Sanitizes all parameters before interpolation.
 *
 * @param template - The script template
 * @param params - Raw parameter values from the MCP-AQL request
 * @returns The complete, safe-to-execute script text
 * @throws {SanitizationError} If a required parameter is missing or a value fails sanitization
 */
export function buildScript(
  template: ScriptTemplate,
  params: Record<string, unknown>,
): string {
  const sanitized: Record<string, string> = {};
  const optionalNames = new Set<string>();

  for (const [name, entry] of Object.entries(template.params)) {
    const { type: expectedType, optional, defaultValue } = resolveParamDef(entry);
    if (optional) {
      optionalNames.add(name);
    }
    let value = params[name];
    if (value === undefined && defaultValue !== undefined) {
      value = defaultValue;
    }
    if (value === undefined) {
      if (!optional) {
        throw new SanitizationError(
          "SANITIZE_MISSING_REQUIRED_PARAM",
          name,
          `Missing required parameter '${name}' for operation.`,
        );
      }
      continue; // Optional params may be absent; template must handle this
    }
    sanitized[name] = sanitizeParam(name, value, expectedType, template.language);
  }

  return interpolateTemplate(
    template.template,
    sanitized,
    optionalNames.size > 0 ? optionalNames : undefined,
  );
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

  try {
    const script = buildScript(template, params);
    const result = await executeOsascript(script, template.language, timeoutMs);

    if (!result.ok) {
      const code = result.exitCode === -1
        ? "TRANSPORT_NATIVE_TIMEOUT"
        : "TRANSPORT_NATIVE_EXECUTION_ERROR";
      return {
        success: false,
        error: {
          code,
          message: `AppleScript execution failed: ${result.stderr}`,
          stderr: result.stderr,
        },
      };
    }

    return {
      success: true,
      data: result.parsed ?? result.stdout,
    };
  } catch (error: unknown) {
    if (error instanceof SanitizationError) {
      return {
        success: false,
        error: {
          code: "TRANSPORT_SANITIZATION_ERROR",
          message: error.message,
        },
      };
    }
    return {
      success: false,
      error: {
        code: "TRANSPORT_NATIVE_EXECUTION_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// Re-export APPLE_MAIL_TEMPLATES from its dedicated module for backward compatibility.
export { APPLE_MAIL_TEMPLATES } from "./apple-mail-templates.js";
