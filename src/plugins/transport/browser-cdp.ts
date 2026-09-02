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
 * - Origin is checked at discovery AND re-checked before every evaluate
 * - No `Input.*`, no `Page.navigate`, no file-input methods, ever
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Default DevTools port (Chrome's own default). */
export const DEFAULT_CDP_PORT = 9222;

/** Default host; loopback only — never a remote browser. */
export const DEFAULT_CDP_HOST = "127.0.0.1";

/** Default per-call timeout for discovery, attach, and evaluate. */
export const DEFAULT_CDP_TIMEOUT_MS = 10_000;

/** Maximum bytes accepted from a single evaluate result (serialized). */
export const DEFAULT_MAX_RESULT_BYTES = 10 * 1024 * 1024;

/**
 * The complete set of CDP methods this transport is permitted to send.
 * Anything else is refused before it reaches the socket. Kept deliberately
 * tiny: reading a page needs nothing but evaluation.
 */
export const ALLOWED_CDP_METHODS: ReadonlySet<string> = new Set([
  "Runtime.enable",
  "Runtime.disable",
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
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
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
 * The exact Chrome launch flag a user needs when the port is closed.
 * Printed in the PORT_CLOSED error so setup is one copy-paste.
 */
export function launchHint(port: number = DEFAULT_CDP_PORT): string {
  return `Start Chrome with remote debugging enabled, e.g. ` +
    `macOS: open -a "Google Chrome" --args --remote-debugging-port=${port} ; ` +
    `Linux: google-chrome --remote-debugging-port=${port}`;
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

/**
 * Choose the page target whose origin matches `allowedOrigin`.
 * Refuses non-page targets (workers, extensions) and other origins.
 * When several tabs match, the first in Chrome's list order (most recently
 * active) wins.
 */
export function selectTarget(targets: CdpTarget[], allowedOrigin: string): CdpTarget {
  const pages = targets.filter((t) => t.type === "page" && typeof t.url === "string");
  const match = pages.find((t) => originOf(t.url) === allowedOrigin);
  if (match) {
    if (!match.webSocketDebuggerUrl) {
      throw new CdpTransportError(
        "TRANSPORT_CDP_NO_TARGET",
        `Tab at ${allowedOrigin} has no debugger endpoint; another DevTools client may be attached. Close DevTools on that tab and retry.`,
        { targetId: match.id },
      );
    }
    return match;
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
  const url = `http://${host}:${port}/json/list`;
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
  const body = await response.json();
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
  if (err instanceof Error) return err.message || err.name;
  return String(err);
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

  constructor(config: BrowserCdpConfig, deps: BrowserCdpDeps = {}) {
    if (typeof config.allowedOrigin !== "string" || originOf(config.allowedOrigin) !== config.allowedOrigin) {
      throw new CdpTransportError(
        "TRANSPORT_CDP_ORIGIN_REFUSED",
        `allowedOrigin must be a bare origin like https://example.com (got ${JSON.stringify(config.allowedOrigin)}).`,
      );
    }
    this.config = {
      allowedOrigin: config.allowedOrigin,
      host: config.host ?? DEFAULT_CDP_HOST,
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

  /** Discover, select, and attach. Idempotent while connected. */
  async connect(): Promise<CdpTarget> {
    if (this.socket && this.target && !this.closed) return this.target;
    this.closed = false;
    const targets = await discoverTargets(
      this.config.host,
      this.config.port,
      this.fetchImpl,
      this.config.timeoutMs,
    );
    const target = selectTarget(targets, this.config.allowedOrigin);
    const wsUrl = target.webSocketDebuggerUrl as string;
    const socket = this.socketFactory(wsUrl);
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
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", () => this.onClose());
    this.socket = socket;
    this.target = target;
    await this.send("Runtime.enable", {});
    return target;
  }

  /**
   * Evaluate a JavaScript expression in the attached tab and return its
   * JSON-serialized value. Promises are awaited. Exceptions in the page
   * become EVALUATE_ERROR; oversize results become RESULT_TOO_LARGE.
   */
  async evaluate(expression: string, options: EvaluateOptions = {}): Promise<unknown> {
    if (typeof expression !== "string" || expression.trim() === "") {
      throw new CdpTransportError("TRANSPORT_CDP_EVALUATE_ERROR", "Expression must be a non-empty string.");
    }
    await this.connect();
    await this.assertStillOnOrigin();
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const raw = await this.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        // Never allow the evaluated script to trigger user gestures.
        userGesture: false,
        timeout: timeoutMs,
      },
      timeoutMs,
    );
    const result = raw as {
      result?: { type?: string; value?: unknown; description?: string };
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
    const value = result.result?.value;
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
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    this.target = null;
    this.rejectAllPending("Transport closed.");
    try {
      socket?.close();
    } catch {
      // Closing an already-closed socket is not an error we care about.
    }
  }

  /**
   * Re-verify the attached tab is still on the allowed origin by asking
   * the page itself. Uses the one allowed method, so it stays inside the
   * allowlist.
   */
  private async assertStillOnOrigin(): Promise<void> {
    const raw = await this.send(
      "Runtime.evaluate",
      { expression: "location.origin", returnByValue: true },
      this.config.timeoutMs,
    );
    const origin = (raw as { result?: { value?: unknown } }).result?.value;
    if (origin !== this.config.allowedOrigin) {
      this.close();
      throw new CdpTransportError(
        "TRANSPORT_CDP_ORIGIN_REFUSED",
        `Attached tab left ${this.config.allowedOrigin} (now ${String(origin)}). Session closed; reconnect once the tab is back.`,
        { allowedOrigin: this.config.allowedOrigin, currentOrigin: origin },
      );
    }
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === "string" ? data : String(data));
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

const defaultFetch: FetchLike = (url) => fetch(url);
