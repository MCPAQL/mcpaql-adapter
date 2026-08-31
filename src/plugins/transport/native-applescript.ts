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
    exitCode?: number;
    signal?: string | null;
    elapsedMs?: number;
    timeoutMs?: number;
    stdoutPreview?: string;
  };
}

/**
 * Structured description of a failed osascript execution.
 * Produced by {@link describeExecutionFailure}; the `message` is guaranteed
 * to be non-empty and self-contained even when osascript produced no stderr.
 */
export interface ExecutionErrorDetail {
  code: "TRANSPORT_NATIVE_TIMEOUT" | "TRANSPORT_NATIVE_EXECUTION_ERROR";
  message: string;
  stderr?: string;
  exitCode: number;
  signal: string | null;
  elapsedMs: number;
  timeoutMs: number;
  stdoutPreview?: string;
}

/**
 * Maximum stderr length included in a failure message before truncation.
 */
const STDERR_MESSAGE_LIMIT = 500;

/**
 * Maximum stdout preview length included when stderr is empty.
 */
const STDOUT_PREVIEW_LIMIT = 200;

/**
 * Build a structured, never-empty error description from a failed script
 * result. An empty `osascript failed:` message hides everything from the
 * caller (adapter-generator#42); this always names the exit code or signal,
 * the elapsed time, and — when stderr is empty — a preview of any stdout the
 * script produced before dying.
 *
 * @param result - The failed script result (`ok: false`)
 * @param timeoutMs - The timeout that governed the execution
 * @returns Structured failure detail with a self-contained message
 */
export function describeExecutionFailure(
  result: ScriptResult,
  timeoutMs: number,
): ExecutionErrorDetail {
  const timedOut = result.timedOut === true;
  const stderr = result.stderr.trim();
  const stdoutTrimmed = result.stdout.trim();
  const stdoutPreview = stdoutTrimmed === ""
    ? undefined
    : stdoutTrimmed.slice(0, STDOUT_PREVIEW_LIMIT);

  const parts: string[] = [];
  if (timedOut) {
    parts.push(`osascript timed out after ${result.elapsedMs}ms (limit ${timeoutMs}ms)`);
  } else if (result.signal) {
    parts.push(`osascript was terminated by ${result.signal} after ${result.elapsedMs}ms`);
  } else {
    parts.push(`osascript exited with code ${result.exitCode} after ${result.elapsedMs}ms`);
  }

  if (!timedOut) {
    if (stderr !== "") {
      const truncated = stderr.length > STDERR_MESSAGE_LIMIT
        ? `${stderr.slice(0, STDERR_MESSAGE_LIMIT)}…`
        : stderr;
      parts.push(`stderr: ${truncated}`);
    } else {
      parts.push("stderr was empty");
    }
  }
  if ((timedOut || stderr === "") && stdoutPreview !== undefined) {
    parts.push(`stdout preview: ${stdoutPreview}`);
  }

  return {
    code: timedOut ? "TRANSPORT_NATIVE_TIMEOUT" : "TRANSPORT_NATIVE_EXECUTION_ERROR",
    message: parts.join(". "),
    stderr: stderr === "" ? undefined : stderr,
    exitCode: result.exitCode,
    signal: result.signal ?? null,
    elapsedMs: result.elapsedMs,
    timeoutMs,
    stdoutPreview,
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

  const startedAt = Date.now();

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
      elapsedMs: Date.now() - startedAt,
      signal: null,
      parsed,
    };
  } catch (error: unknown) {
    const execError = error as {
      // execFile sets `code` to the numeric exit code on non-zero exit
      // (or a string like "ENOENT" on spawn failure); `status` is only
      // populated by the sync APIs.
      code?: string | number;
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
        elapsedMs: Date.now() - startedAt,
        signal: execError.signal ?? "SIGTERM",
        timedOut: true,
      };
    }

    // Execution-layer failures (e.g. ERR_CHILD_PROCESS_STDIO_MAXBUFFER when
    // stdout exceeds maxBuffer) reject with a STRING error.code, an EMPTY
    // stderr string, and the real cause in error.message — fold both into
    // stderr so the failure stays diagnosable instead of collapsing into
    // "exit code 1, stderr was empty".
    const stringCode = typeof execError.code === "string" ? execError.code : undefined;
    let stderrText = execError.stderr ?? "";
    if (stderrText.trim() === "" && stringCode !== undefined) {
      // Only for string-coded failures: a plain non-zero exit with silent
      // stderr keeps stderr empty (error.message would just repeat the
      // command line), and describeExecutionFailure reports it as such.
      const cause = error instanceof Error ? error.message : String(error);
      stderrText = `${stringCode}: ${cause}`;
    }

    return {
      ok: false,
      stdout: execError.stdout ?? "",
      stderr: stderrText,
      exitCode: typeof execError.code === "number"
        ? execError.code
        : execError.status ?? 1,
      elapsedMs: Date.now() - startedAt,
      signal: execError.signal ?? null,
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
      const detail = describeExecutionFailure(result, timeoutMs);
      return {
        success: false,
        error: {
          code: detail.code,
          message: detail.message,
          stderr: detail.stderr,
          exitCode: detail.exitCode,
          signal: detail.signal,
          elapsedMs: detail.elapsedMs,
          timeoutMs: detail.timeoutMs,
          stdoutPreview: detail.stdoutPreview,
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
