/**
 * Browser-session transport plugin for MCP-AQL (Chrome DevTools Protocol).
 *
 * Attaches to the user's ALREADY-RUNNING Chrome over the DevTools Protocol
 * and evaluates read-only scripts inside one tab. The adapter never launches
 * a browser, never holds a vendor credential, and never drives input: the
 * only CDP methods it will send are the few in {@link ALLOWED_CDP_METHODS}.
 *
 * Zero runtime dependencies: uses the WebSocket client and `fetch` that ship
 * with Node 22+.
 *
 * Flow:
 * 1. Discover page targets via `http://<host>:<port>/json/list`
 * 2. Pick the tab whose URL origin matches `allowedOrigin` (refuse all others)
 * 3. Open the tab's `webSocketDebuggerUrl`
 * 4. `Runtime.evaluate` with `returnByValue` — JSON-serializable results only
 *
 * Security model:
 * - Method allowlist is a constant, checked on every send, covered by test
 * - Origin is checked at discovery AND inside every evaluate, atomically:
 *   the expression runs only if the page still reports the allowed origin
 * - No `Input.*`, no `Page.navigate`, no file-input methods, ever
 * - Expressions are adapter-authored, static scripts (the same trust model
 *   as the AppleScript templates): never caller- or user-supplied. This
 *   layer bounds what the *transport* can do; what the *scripts* may do is
 *   enforced separately by the read-only script scan (#44).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Default DevTools port (Chrome's own default). */
export const DEFAULT_CDP_PORT = 9222;

/** Default host; loopback only — never a remote browser. */
export const DEFAULT_CDP_HOST = "127.0.0.1";

/** The hosts the transport will attach to: a DevTools port on another machine would hand that network the user's session. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** `host:port` for a URL, with an IPv6 literal bracketed. */
export function devtoolsAuthority(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** Default per-call timeout for discovery, attach, and evaluate. */
export const DEFAULT_CDP_TIMEOUT_MS = 10_000;

/** Maximum bytes accepted from a single evaluate result (serialized). */
export const DEFAULT_MAX_RESULT_BYTES = 10 * 1024 * 1024;

/**
 * The complete set of CDP methods this transport is permitted to send.
 * Anything else is refused before it reaches the socket. Reading a page
 * needs exactly one method. `Runtime.enable` is deliberately absent: it is
 * not required for evaluation and would subscribe the socket to the page's
 * console and exception event stream.
 */
export const ALLOWED_CDP_METHODS: ReadonlySet<string> = new Set([
  "Runtime.evaluate",
]);

/** CDP domains that must never appear in the allowlist (asserted by test). */
export const FORBIDDEN_CDP_PREFIXES: readonly string[] = [
  "Input.",
  "Page.navigate",
  "Page.reload",
  "DOM.setFileInputFiles",
  "Network.setCookie",
  "Storage.",
  "Browser.",
  "Target.",
];

export type CdpErrorCode =
  | "TRANSPORT_CDP_PORT_CLOSED"
  | "TRANSPORT_CDP_NO_TARGET"
  | "TRANSPORT_CDP_ORIGIN_REFUSED"
  | "TRANSPORT_CDP_METHOD_DENIED"
  | "TRANSPORT_CDP_TIMEOUT"
  | "TRANSPORT_CDP_EVALUATE_ERROR"
  | "TRANSPORT_CDP_RESULT_TOO_LARGE"
  | "TRANSPORT_CDP_DISCONNECTED"
  | "TRANSPORT_CDP_PROTOCOL_ERROR";

/**
 * Structured transport failure. `message` is always non-empty and names
 * what to do next (same discipline as `describeExecutionFailure`).
 */
export class CdpTransportError extends Error {
  readonly code: CdpErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: CdpErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "CdpTransportError";
    this.code = code;
    this.detail = detail;
  }
}

/** Configuration for the browser-session transport. */
export interface BrowserCdpConfig {
  /**
   * Origin the target tab must have, e.g. `https://discord.com`.
   * Compared against `new URL(target.url).origin` exactly.
   */
  allowedOrigin: string;
  /** @default 127.0.0.1 */
  host?: string;
  /** @default 9222 */
  port?: number;
  /** @default 10000 */
  timeoutMs?: number;
  /** @default 10 MiB */
  maxResultBytes?: number;
}

/** One entry from Chrome's `/json/list`. Only the fields we read. */
export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

/**
 * Minimal WebSocket surface used by the transport. Matches the WHATWG
 * `WebSocket` that Node 22+ provides globally; tests substitute a fake.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: SocketEvent) => void): void;
}

/** The parts of a WHATWG socket event this transport reads. */
export interface SocketEvent {
  data?: unknown;
  error?: unknown;
  message?: string;
}

export type SocketFactory = (url: string) => WebSocketLike;
export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Injection points for tests. Production callers omit this. */
export interface BrowserCdpDeps {
  socketFactory?: SocketFactory;
  fetchImpl?: FetchLike;
}

export interface EvaluateOptions {
  timeoutMs?: number;
}

/**
 * Where the hint tells the user to keep the debug-enabled profile. Chrome
 * 136 and later refuse `--remote-debugging-port` on the default profile, so
 * the profile must be a separate directory; it has its own logins.
 */
export const DEFAULT_CHROME_PROFILE_DIR = "$HOME/.mcpaql/chrome-debug";

/**
 * The exact Chrome launch commands a user needs when the port is closed,
 * for macOS and Linux. Printed in the PORT_CLOSED error so setup is one
 * copy-paste. Both flags are required: Chrome 136+ opens the port only
 * when `--user-data-dir` names a non-default directory. On macOS `open -n`
 * starts a new instance; without it a running Chrome is merely activated
 * and the flags never reach a process.
 */
export function launchHint(port: number = DEFAULT_CDP_PORT): string {
  const flags = `--remote-debugging-port=${port} --user-data-dir="${DEFAULT_CHROME_PROFILE_DIR}"`;
  return `Start Chrome with remote debugging enabled and a separate profile (Chrome 136+ requires both flags; sign in there once; ` +
    `this is a second Chrome instance, so your normal Chrome can stay open). ` +
    `macOS: open -n -a "Google Chrome" --args ${flags} ; ` +
    `Linux: google-chrome ${flags}`;
}

/**
 * Return the origin of a URL, or `null` when it is not parseable.
 */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Page targets at `allowedOrigin`: the one matching rule, shared with the startup probe. */
export function matchingPages(targets: CdpTarget[], allowedOrigin: string): CdpTarget[] {
  return targets.filter((t) => t.type === "page" && typeof t.url === "string" && originOf(t.url) === allowedOrigin);
}

/**
 * Choose the page target whose origin matches `allowedOrigin`.
 * Refuses non-page targets (workers, extensions) and other origins.
 * When several tabs match, the first in Chrome's list order (most recently
 * active) wins.
 */
export function selectTarget(targets: CdpTarget[], allowedOrigin: string): CdpTarget {
  const pages = targets.filter((t) => t.type === "page" && typeof t.url === "string");
  const matches = matchingPages(pages, allowedOrigin);
  const attachable = matches.find((t) => typeof t.webSocketDebuggerUrl === "string" && t.webSocketDebuggerUrl !== "");
  if (attachable) return attachable;
  if (matches.length > 0) {
    throw new CdpTransportError(
      "TRANSPORT_CDP_NO_TARGET",
      `Every tab at ${allowedOrigin} has no debugger endpoint; another DevTools client is attached. Close DevTools on those tabs and retry.`,
      { targetIds: matches.map((t) => t.id) },
    );
  }
  const seen = pages.map((t) => originOf(t.url)).filter((o): o is string => o !== null);
  const unique = [...new Set(seen)];
  const code: CdpErrorCode = pages.length === 0 ? "TRANSPORT_CDP_NO_TARGET" : "TRANSPORT_CDP_ORIGIN_REFUSED";
  throw new CdpTransportError(
    code,
    pages.length === 0
      ? `No open tabs found. Open ${allowedOrigin} in the debug-enabled Chrome and retry.`
      : `No tab at ${allowedOrigin}. Open it in the debug-enabled Chrome and retry. (Open origins: ${unique.join(", ")})`,
    { allowedOrigin, openOrigins: unique },
  );
}

/**
 * Discover targets from Chrome's HTTP endpoint.
 * A connection refusal becomes PORT_CLOSED with the launch hint.
 */
export async function discoverTargets(
  host: string,
  port: number,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<CdpTarget[]> {
  const url = `http://${devtoolsAuthority(host, port)}/json/list`;
  // One deadline for the whole discovery: the request and the body read share `timeoutMs`.
  const deadline = Date.now() + timeoutMs;
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await withTimeout(fetchImpl(url), timeoutMs, "discovery");
  } catch (err) {
    if (err instanceof CdpTransportError) throw err;
    throw new CdpTransportError(
      "TRANSPORT_CDP_PORT_CLOSED",
      `Cannot reach Chrome DevTools at ${url}: ${describe(err)}. ${launchHint(port)}`,
      { host, port },
    );
  }
  if (!response.ok) {
    throw new CdpTransportError(
      "TRANSPORT_CDP_PROTOCOL_ERROR",
      `DevTools endpoint ${url} returned HTTP ${response.status}.`,
      { status: response.status },
    );
  }
  let body: unknown;
  try {
    body = await withTimeout(response.json(), Math.max(1, deadline - Date.now()), "discovery body");
  } catch (err) {
    if (err instanceof CdpTransportError) throw err;
    throw new CdpTransportError(
      "TRANSPORT_CDP_PROTOCOL_ERROR",
      `DevTools endpoint ${url} returned unreadable JSON: ${describe(err)}`,
    );
  }
  if (!Array.isArray(body)) {
    throw new CdpTransportError(
      "TRANSPORT_CDP_PROTOCOL_ERROR",
      `DevTools endpoint ${url} returned a non-array body.`,
    );
  }
  return body.filter(isTarget);
}

function isTarget(value: unknown): value is CdpTarget {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.type === "string" && typeof v.url === "string";
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeText = cause instanceof Error && cause.message ? ` (${cause.message})` : "";
    return (err.message || err.name) + causeText;
  }
  if (typeof err === "object" && err !== null) {
    const ev = err as SocketEvent;
    if (ev.error !== undefined) return describe(ev.error);
    if (typeof ev.message === "string" && ev.message !== "") return ev.message;
  }
  const text = String(err);
  return text === "[object Object]" || text === "[object ErrorEvent]" || text === "[object Event]"
    ? "connection refused or upgrade rejected (is Chrome running with --remote-debugging-port and --user-data-dir, and is this the same user?)"
    : text;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CdpTransportError(
        "TRANSPORT_CDP_TIMEOUT",
        `${what} timed out after ${timeoutMs}ms.`,
        { timeoutMs, what },
      ));
    }, timeoutMs);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Allowance for the CDP envelope around a result when sizing frames. */
const FRAME_OVERHEAD_BYTES = 4096;

function closeQuietly(socket: WebSocketLike): void {
  try {
    socket.close();
  } catch {
    // Closing an already-closed socket is not an error we care about.
  }
}

/** Marker key the guarded expression returns when the tab is on another origin. */
export const ORIGIN_MISMATCH_KEY = "__cdpOriginMismatch";

/**
 * Wrap an expression so it runs only if the page still reports the allowed
 * origin. Check and evaluation share one execution context, so a navigation
 * between them is impossible.
 */
export function guardExpression(expression: string, allowedOrigin: string): string {
  return `(async () => { if (location.origin !== ${JSON.stringify(allowedOrigin)}) ` +
    `return { ${JSON.stringify(ORIGIN_MISMATCH_KEY)}: location.origin }; ` +
    `return (${expression}); })()`;
}

/** The origin a guarded evaluation reported, or null when it ran normally. */
export function originMismatchOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  return typeof v[ORIGIN_MISMATCH_KEY] === "string" ? (v[ORIGIN_MISMATCH_KEY] as string) : null;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * Read-only CDP session against one tab.
 *
 * Lifecycle: `connect()` → `evaluate()` (any number of times) → `close()`.
 * Every `evaluate` re-verifies the attached target's origin so a tab that
 * navigated away cannot keep being read.
 */
export class BrowserCdpTransport {
  private readonly config: Required<BrowserCdpConfig>;
  private readonly socketFactory: SocketFactory;
  private readonly fetchImpl: FetchLike;
  private socket: WebSocketLike | null = null;
  private target: CdpTarget | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private connecting: Promise<CdpTarget> | null = null;
  /** Bumped by every close(); an attach that outlives its generation is abandoned. */
  private generation = 0;

  constructor(config: BrowserCdpConfig, deps: BrowserCdpDeps = {}) {
    if (typeof config.allowedOrigin !== "string" || originOf(config.allowedOrigin) !== config.allowedOrigin) {
      throw new CdpTransportError(
        "TRANSPORT_CDP_ORIGIN_REFUSED",
        `allowedOrigin must be a bare origin like https://example.com (got ${JSON.stringify(config.allowedOrigin)}).`,
      );
    }
    const host = config.host ?? DEFAULT_CDP_HOST;
    if (!isLoopbackHost(host)) {
      throw new CdpTransportError(
        "TRANSPORT_CDP_ORIGIN_REFUSED",
        `host must be loopback (127.0.0.1, localhost, or ::1); got ${JSON.stringify(host)}. This transport never attaches to a remote browser.`,
        { host },
      );
    }
    this.config = {
      allowedOrigin: config.allowedOrigin,
      host,
      port: config.port ?? DEFAULT_CDP_PORT,
      timeoutMs: config.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS,
      maxResultBytes: config.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
    };
    this.socketFactory = deps.socketFactory ?? defaultSocketFactory;
    this.fetchImpl = deps.fetchImpl ?? defaultFetch;
  }

  /** The target this session is attached to, once connected. */
  get attachedTarget(): CdpTarget | null {
    return this.target;
  }

  /**
   * Discover, select, and attach. Idempotent while connected; concurrent
   * callers share one in-flight attempt so only one socket ever exists.
   */
  connect(): Promise<CdpTarget> {
    if (this.socket && this.target && !this.closed) return Promise.resolve(this.target);
    if (this.connecting) return this.connecting;
    this.connecting = this.attach().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async attach(): Promise<CdpTarget> {
    this.closed = false;
    const gen = this.generation;
    const abandoned = (): boolean => gen !== this.generation;
    const targets = await discoverTargets(
      this.config.host,
      this.config.port,
      this.fetchImpl,
      this.config.timeoutMs,
    );
    if (abandoned()) throw new CdpTransportError("TRANSPORT_CDP_DISCONNECTED", "Transport closed during connect.");
    const target = selectTarget(targets, this.config.allowedOrigin);
    const wsUrl = target.webSocketDebuggerUrl as string;
    let socket: WebSocketLike;
    try {
      socket = this.socketFactory(wsUrl);
    } catch (err) {
      throw new CdpTransportError(
        "TRANSPORT_CDP_PROTOCOL_ERROR",
        `Cannot open WebSocket ${wsUrl}: ${describe(err)}`,
      );
    }
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve());
          socket.addEventListener("error", (event) => {
            reject(new CdpTransportError(
              "TRANSPORT_CDP_DISCONNECTED",
              `WebSocket to ${wsUrl} failed: ${describe(event)}`,
            ));
          });
        }),
        this.config.timeoutMs,
        "attach",
      );
      if (abandoned()) throw new CdpTransportError("TRANSPORT_CDP_DISCONNECTED", "Transport closed during connect.");
    } catch (err) {
      // A handshake that failed, dangled, or was abandoned must not leak a live connection.
      closeQuietly(socket);
      throw err;
    }
    // Listeners are bound to this socket: a stale event from an earlier socket can never touch a newer session.
    socket.addEventListener("message", (event) => {
      if (this.socket === socket) this.onMessage(event.data);
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.onClose();
    });
    this.socket = socket;
    this.target = target;
    return target;
  }

  /**
   * Evaluate a JavaScript expression in the attached tab and return its
   * JSON-serialized value. Promises are awaited. Exceptions in the page
   * become EVALUATE_ERROR; oversize results become RESULT_TOO_LARGE.
   *
   * `expression` must be a single expression (an IIFE is fine). It is
   * wrapped so the origin check and the evaluation happen in the same
   * execution context: if the tab has navigated away, the expression does
   * not run and the session is closed.
   */
  async evaluate(expression: string, options: EvaluateOptions = {}): Promise<unknown> {
    if (typeof expression !== "string" || expression.trim() === "") {
      throw new CdpTransportError("TRANSPORT_CDP_EVALUATE_ERROR", "Expression must be a non-empty string.");
    }
    await this.connect();
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const raw = await this.send(
      "Runtime.evaluate",
      {
        expression: guardExpression(expression, this.config.allowedOrigin),
        returnByValue: true,
        awaitPromise: true,
        // Never allow the evaluated script to trigger user gestures.
        userGesture: false,
        timeout: timeoutMs,
      },
      timeoutMs,
    );
    if (typeof raw !== "object" || raw === null) {
      throw new CdpTransportError("TRANSPORT_CDP_PROTOCOL_ERROR", "DevTools returned an empty evaluate response.");
    }
    const result = raw as {
      result?: { type?: string; subtype?: string; value?: unknown; unserializableValue?: string; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? "unknown page exception";
      throw new CdpTransportError(
        "TRANSPORT_CDP_EVALUATE_ERROR",
        `Page script threw: ${desc.slice(0, 500)}`,
      );
    }
    const remote = result.result ?? {};
    if (remote.unserializableValue !== undefined) {
      throw new CdpTransportError(
        "TRANSPORT_CDP_EVALUATE_ERROR",
        `Page script returned a non-JSON value (${remote.unserializableValue}). Return plain data.`,
      );
    }
    if (remote.value === undefined && remote.type !== undefined && remote.type !== "undefined") {
      throw new CdpTransportError(
        "TRANSPORT_CDP_EVALUATE_ERROR",
        `Page script returned a ${remote.subtype ?? remote.type} that cannot be serialized. Return plain data.`,
      );
    }
    const value = remote.value;
    const mismatch = originMismatchOf(value);
    if (mismatch !== null) {
      this.close();
      throw new CdpTransportError(
        "TRANSPORT_CDP_ORIGIN_REFUSED",
        `Attached tab left ${this.config.allowedOrigin} (now ${mismatch}). Session closed; reconnect once the tab is back.`,
        { allowedOrigin: this.config.allowedOrigin, currentOrigin: mismatch },
      );
    }
    const size = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
    if (size > this.config.maxResultBytes) {
      throw new CdpTransportError(
        "TRANSPORT_CDP_RESULT_TOO_LARGE",
        `Result is ${size} bytes; limit is ${this.config.maxResultBytes}. Narrow the query or lower the limit.`,
        { size, maxResultBytes: this.config.maxResultBytes },
      );
    }
    return value;
  }

  /** Close the socket. Pending calls reject with DISCONNECTED. */
  close(): void {
    this.generation++;
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    this.target = null;
    this.rejectAllPending("Transport closed.");
    if (socket) closeQuietly(socket);
  }

  /**
   * The single choke point. Every CDP message passes here, and anything
   * outside {@link ALLOWED_CDP_METHODS} is refused before serialization.
   */
  private send(method: string, params: Record<string, unknown>, timeoutMs = this.config.timeoutMs): Promise<unknown> {
    if (!ALLOWED_CDP_METHODS.has(method)) {
      return Promise.reject(new CdpTransportError(
        "TRANSPORT_CDP_METHOD_DENIED",
        `CDP method ${method} is not permitted by this read-only transport.`,
        { method },
      ));
    }
    if (!this.socket || this.closed) {
      return Promise.reject(new CdpTransportError("TRANSPORT_CDP_DISCONNECTED", "Not connected."));
    }
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return withTimeout(promise, timeoutMs, method).catch((err) => {
      this.pending.delete(id);
      throw err;
    });
  }

  private onMessage(data: unknown): void {
    const text = typeof data === "string" ? data : String(data);
    // Reject oversize frames before parsing so a huge result never costs three copies in memory.
    if (text.length > this.config.maxResultBytes + FRAME_OVERHEAD_BYTES) {
      const idMatch = /"id":\s*(\d+)/.exec(text.slice(0, 256));
      const entry = idMatch ? this.pending.get(Number(idMatch[1])) : undefined;
      if (entry) {
        this.pending.delete(Number(idMatch![1]));
        entry.reject(new CdpTransportError(
          "TRANSPORT_CDP_RESULT_TOO_LARGE",
          `Result frame is ${text.length} characters; limit is ${this.config.maxResultBytes} bytes. Narrow the query or lower the limit.`,
          { size: text.length, maxResultBytes: this.config.maxResultBytes },
        ));
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // Non-JSON frames are ignored; the pending call will time out with context.
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const msg = parsed as { id?: number; result?: unknown; error?: { code?: number; message?: string } };
    if (typeof msg.id !== "number") return; // Event, not a response. We subscribe to none.
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      entry.reject(new CdpTransportError(
        "TRANSPORT_CDP_PROTOCOL_ERROR",
        `DevTools returned error ${msg.error.code ?? "?"}: ${msg.error.message ?? "no message"}`,
        { cdpError: msg.error },
      ));
      return;
    }
    entry.resolve(msg.result);
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket = null;
    this.target = null;
    this.rejectAllPending("WebSocket closed by the browser (tab closed or Chrome quit).");
  }

  private rejectAllPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.reject(new CdpTransportError("TRANSPORT_CDP_DISCONNECTED", reason));
    }
  }
}

function defaultSocketFactory(url: string): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (u: string) => WebSocketLike }).WebSocket;
  if (!Ctor) {
    throw new CdpTransportError(
      "TRANSPORT_CDP_PROTOCOL_ERROR",
      "Global WebSocket is unavailable; Node 22 or newer is required.",
    );
  }
  return new Ctor(url);
}

/** The production fetch; exported so other callers of `discoverTargets` use the same one. */
export const defaultFetch: FetchLike = (url) => fetch(url);
