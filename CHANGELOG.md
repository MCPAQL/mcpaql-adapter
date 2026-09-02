# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Discord DOM extractor (`src/plugins/transport/discord-dom.ts`) — second piece of the read-only Discord adapter (#38, closes #40)
  - `extractMessages` reads the Discord web client's rendered message list with full fidelity: complete text (no ~100-character accessibility-tree truncation), emoji as alt text, line breaks, mentions, links, grouped-message author attribution, reply linkage to the referenced message id, reactions with counts and own-reaction flag, attachment URLs and filenames (never downloaded), link embeds, edited flag, ISO timestamps
  - One implementation for two runtimes: the same function is unit-tested in Node against a dependency-free fake DOM and shipped to the browser as its own source text via `buildExtractMessagesExpression`
  - `DISCORD_SELECTORS` is the single selector table; every entry prefers stable attributes over Discord's hashed class names, and a test asserts each entry is used
  - Caps applied inside the page (`maxMessages` and `maxBytes`, counted as UTF-8 bytes including the envelope) keep the newest messages and set `truncated`; a missing message list, an ambiguous split view without `channelId`, or a single message larger than the cap returns a named `problem` instead of empty success
  - `author_ref` carries the group-start message id for grouped rows so a caller paging through a virtualized list can resolve authors across pages; system rows stay unattributed rather than inheriting a neighbor
  - The "(edited)" decoration is reported as a flag, never as content; non-breaking spaces are normalized in every rendered string; own reactions are detected from markup, not localized label text
  - A test transpiles the module the way `tsc` does and runs the result bare, so the shipped text is proven, not only the test runtime's
  - Test helper `test/helpers/fake-dom.ts`: minimal DOM with a small CSS selector subset

- Browser-session transport plugin (`src/plugins/transport/browser-cdp.ts`) — first piece of the read-only Discord adapter (#38, closes #39)
  - Attaches to the user's already-running Chrome over the DevTools Protocol using Node's built-in WebSocket and `fetch`; zero runtime dependencies
  - Read-only by construction: a one-method allowlist (`Runtime.evaluate`) checked on every send, with a forbidden-prefix list (`Input.`, `Page.navigate`, storage, target, browser domains) asserted by test. `Runtime.enable` is deliberately not sent; evaluation does not need it and it would subscribe the socket to the page's event stream
  - Expressions are adapter-authored static scripts, never caller-supplied; this layer bounds the transport, and the read-only script scan (#44) bounds the scripts
  - Origin pinning: only a page target on the configured origin is selected, and every evaluate is wrapped so the origin check and the expression run in the same execution context; a tab that navigates away never runs the expression and the session closes
  - Named, never-empty failures: port closed (with the exact Chrome launch flag), no target, origin refused, method denied, timeout, page exception, result too large, disconnected, protocol error
  - Result size cap and per-call timeouts
  - Concurrent first calls share one connection attempt; a failed or dangling handshake closes the socket it opened; discovery body reads are under the timeout with unreadable JSON mapped to a protocol error
  - Listeners are bound to their socket so a stale close from an earlier socket cannot tear down a newer session; close during an in-flight connect abandons it; unserializable page values (NaN, DOM nodes) and empty responses are named errors; oversize frames are rejected before parsing; WebSocket error events produce readable text; target selection skips a tab with DevTools open when another tab on the origin is attachable
  - 45 unit tests against fake socket and fetch doubles

- `@mcpaql/security` package (`src/security/`) — standalone security infrastructure ported from DollhouseMCP
  - `tool-classification.ts` — CLI tool risk assessment with 50+ dangerous patterns, risk scoring 0-100
  - `content-validator.ts` — 45+ prompt injection patterns, HTML/XSS detection, YAML bomb detection
  - `unicode-validator.ts` — 93+ homoglyph mappings (Cyrillic, Greek uppercase/lowercase, fullwidth, math), bidi overrides, zero-width character detection
  - `input-normalizer.ts` — recursive Unicode NFC normalization with severity escalation
  - `input-validator.ts` — control character removal, path traversal detection, shell metacharacter sanitization
  - `pattern-matcher.ts` — glob-style pattern matching with DoS protection (500 char limit, LRU cache)
  - `rate-limiter.ts` — token bucket rate limiting
  - `approval-records.ts` — approval record lifecycle with TTL, LRU eviction, scope management
  - 300 tests across 8 modules with zero external dependencies
- Apple Mail metadata cache (`src/plugins/cache/`) — issue #32 section B1
  - `mail-cache.ts` — SQLite-backed message METADATA cache (never bodies) via the `node:sqlite` built-in; parameterized query surface with mandatory capped limits (capability parity with the bridge operations), deny-by-default account/mailbox scoping, per-query audit log; no Full Disk Access anywhere — populated only through the Automation-permitted bridge
  - `mail-sync.ts` — resumable budgeted `backfillStep` (with `maxDepth` for jumbo mailboxes) and `incrementalSync` (newest-first, stops at the first cached message), driven by the bounded scan templates
  - graceful degradation: `isMailCacheSupported()` gates on `node:sqlite` availability (Node >= 22.5 flagged, unflagged from 23.4); callers fall back to bounded bridge scans
- Native AppleScript transport plugin (`src/plugins/transport/`)
  - `native-applescript.ts` - Transport plugin for macOS application automation via osascript
  - `sanitizer.ts` - Parameter sanitization and injection prevention (AppleScript equivalent of SQL parameterization)
  - `serializer.ts` - AppleScript output to JSON serialization and JXA JSON wrapper
  - `types.ts` - Type definitions for script templates, configs, and results
  - Predefined JXA templates for Apple Mail operations
  - `describeExecutionFailure()` — structured failure details for osascript errors (exit code, signal, elapsed time, timeout limit, stdout preview); `ScriptResult` now carries `elapsedMs`, `signal`, and `timedOut`
  - `recent_messages` template — newest-first date-bounded listing (adapter-generator#27)
  - `search_messages` gains a `field` parameter: `subject` (default), `sender`, or `any`
  - Bounded-scan paging for `list_messages`, `recent_messages`, `search_messages`: `cursor`, `scan_cap`, `time_budget_ms` parameters and a `{messages, count, scanned, cursor, complete, truncated, elapsed_ms}` envelope (#32 section A)
  - `ScriptParamDef.default` — declared parameter defaults, sanitized like supplied values
- TypeScript project infrastructure (`package.json`, `tsconfig.json`)
- 83 unit tests covering sanitization, serialization, template interpolation, injection prevention, and osascript execution
- Initial architecture documentation migrated from spec repository
  - `docs/architecture/runtime.md` - Universal adapter runtime specification
  - `docs/architecture/plugin-system.md` - Plugin system implementation details
  - `docs/architecture/dispatch.md` - Schema-driven dispatch pattern
  - `docs/architecture/overview.md` - Architecture overview
  - `docs/guides/development.md` - Adapter development guide
- Testing guide with patterns for unit, integration, and conformance testing
- Migration guide for converting MCP servers to MCP-AQL adapters
- Architecture Decision Records (ADRs)
  - ADR-001: Plugin Pipeline Order
  - ADR-002: Schema-Driven Dispatch over Code Generation
  - ADR-003: Stateless Singleton Plugins
- Example adapter implementations
  - `examples/minimal-adapter.ts` - Bare-minimum adapter with introspection
  - `examples/user-management-adapter.ts` - Full CRUDE adapter with all endpoints
- Split licensing documentation (`LICENSING.md`, `LICENSE-DOCS`)
- Updated README.md with repository purpose, document index, guides, ADRs, and examples

### Changed

- **Breaking:** Apple Mail scan templates (`list_messages`, `search_messages`) return the paging envelope instead of a bare array, iterate by index with one `properties()` Apple Event per message, and never call `messages()`, `messages.length`, or non-id `whose` — the enumeration paths that timed out on 100k-message mailboxes (#26, #32 section A). Enforced by a template-source test.
- **Breaking:** `list_mailboxes` no longer reports `message_count` (it required `messages.length` per mailbox, which fails for accounts containing one large mailbox); `unread_count` remains
- CI test job runs on Node 24 (was 22) so the `node:sqlite`-backed cache tests execute unflagged
- Standardized documentation dates to 2026-01-26
- Expanded development guide prerequisites with dependency table and setup commands
- Updated `COMMERCIAL-LICENSE-TERMS.md` with indemnification provisions, support/SLA clarifications, and renumbered downstream sections to stay aligned with the spec repository

### Fixed

- Non-zero osascript exit codes are now reported correctly: the transport read `error.status` (only set by sync child_process APIs) instead of `error.code`, so every non-zero exit surfaced as exit code 1
- Native transport failures no longer surface as an empty message: `TRANSPORT_NATIVE_EXECUTION_ERROR` / `TRANSPORT_NATIVE_TIMEOUT` always name the exit code or signal and elapsed time, truncate oversized stderr, and include a stdout preview when stderr is empty (#32 section C; failure mode observed in adapter-generator#42)

