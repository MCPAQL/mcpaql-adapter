# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Discord MCP-AQL operation layer (`src/plugins/transport/discord-operations.ts`) — first piece of the runnable adapter (#38, part of #52)
  - `DISCORD_OPERATIONS` registers the four read operations (`list_dms`, `list_guilds`, `list_channels`, `read_messages`) with parameter definitions, danger level, and the one documented side effect; `validateParams` fills defaults, clamps integer bounds, treats `null` as absent, and refuses unknown parameters with `VALIDATION_UNKNOWN_PARAM` rather than ignoring them
  - `runDiscordOperation` maps each operation to the library (`buildListExpression` + the transport's `evaluate`, `readMessages`) and never throws: every failure is the `{ success: false, error }` envelope, with transport codes kept (a closed port is `TRANSPORT_CDP_PORT_CLOSED` with the launch hint), a channel that never mounts as `NOT_FOUND_RESOURCE`, and anything else as `INTERNAL_ERROR`
  - `buildIntrospection` answers `introspect` for operations and result types; `resolveOperationArguments` accepts nested `params` or flat arguments
  - Each operation declares the page-script effects it may use, and the same scan the read-only test runs is applied at runtime to every expression before it is evaluated: a forbidden primitive, or a gated one the operation did not declare, is refused with `PERMISSION_DENIED` and never reaches the page; a test also runs the scan over everything an operation actually evaluated against a fake tab
  - `introspect` reports `_protocol.version` as the MCP-AQL spec version (`1.0.0-alpha.1`) with mode and capability flags, and the adapter's own version under `adapter`

- Discord adapter guide (`docs/guides/discord-adapter.md`) — closes #45 for the read-only Discord adapter (#38): the library-only status (the runnable server is #52), what it is and is not, the Chrome setup including the separate profile Chrome 136+ requires, the one side effect, the Discord terms note, the functions and result shapes as they exist, untrusted-content handling, and where to look when Discord changes its markup
- Discord untrusted-content classification (`src/plugins/transport/discord-untrusted.ts`) — the other half of #44
  - `readMessages` runs its result through the classifier: `flags`, `flagged_ids`, and `highest_severity` travel with every read; `redact` is an opt-in parameter
  - `classifyDiscordMessages` runs every text field (content, author, reply label, embed title/description/provider, attachment filename) through the `@mcpaql/security` content validator and reports flags per message and per field with severity and pattern names; nothing is changed unless `redact` is set, and then only `high`/`critical` fields; input is never mutated; oversize fields are flagged rather than scanned
- Discord page-script registry and read-only scan (`src/plugins/transport/discord-scripts.ts`, `test/discord-read-only.test.ts`) — part of #44 for the read-only Discord adapter (#38)
  - Every script the adapter evaluates in the page is registered with the side effects it declares (`navigate-same-origin`, `scroll-message-list`); a test fails if a function marked SELF-CONTAINED in a Discord module is missing from the registry
  - No script may use an input, network, storage, identity, or injection primitive (focus, click, key events, `fetch`, cookies, storage, `eval`, script elements, Discord client internals); gated primitives (`history.pushState`, `scrollTop`, `dispatchEvent`) are allowed only under a declared effect, a declared effect must actually be used, dispatched events must match the effect (`scroll` or `popstate`), navigation targets must be `/channels/` paths, and no script may reload the client
- Discord `read_messages` with history backfill (`src/plugins/transport/discord-history.ts`) — fourth piece of the read-only Discord adapter (#38, closes #42)
  - `readMessages(deps, params)` opens the channel (jumping to the `before` cursor message so a resume does not scroll from the newest), extracts the mounted window, merges by id, and scrolls for older rows until `limit` is filled below `before`, the beginning of the channel is reached, `scan_cap` rows are examined, or `time_budget_ms` is spent
  - Returns the bounded-scan envelope from #35: `{messages (newest first), count, scanned, cursor, complete, truncated, stop_reason, problem, elapsed_ms}`; every stop other than "filled" or "beginning" is `complete: false` with a resumable cursor, never silent truncation
  - Grouped authors are resolved across windows from `author_ref`
  - In-page steps are synchronous (`scrollNudge`, `mountedCount`) and all waiting happens in Node: Chrome throttles timers in hidden tabs, so in-page waits can stall past a transport timeout (observed live)
  - The nudge moves the real scroller (class token stem `scroller`, containing the list) away and back to the top and dispatches a synthetic scroll event after each move; native scroll events need rendering frames, which a hidden tab never gets (verified live: 51 rows became 81 in a hidden, unfocused tab)
  - `openChannel` accepts an anchor `messageId`; navigation paths remain same-origin and snowflake-validated
- Discord listing and navigation (`src/plugins/transport/discord-nav.ts`) — third piece of the read-only Discord adapter (#38, closes #41)
  - In-page `listDms` (real conversations only: id, name, kind, presence, unread), `listGuilds` (server rail with unread prefixes stripped and the raw label kept), `listChannels` (channels with kind and enclosing category, plus the open server's id and name); each returns `{items, count, truncated, problem}` and is shipped to the browser as its own source text with the shared `plainText` helper inlined
  - Node-side `openChannel(evaluate, target)`: short-circuits when the channel is already mounted, otherwise changes the client's route (a history push plus the `popstate` event Discord's router handles, so no reload and no lost drafts or voice) to a same-origin path built only from validated snowflake ids, then polls for the channel's message list; every evaluate and sleep is bounded by the actual remaining budget, and only the context-replaced error is tolerated while transport failures propagate; never accepts a caller URL
  - Shared `buildPageExpression` and `renderText` in `discord-dom.ts` are used by every page script; the snowflake pattern, message-row prefix, and message-list selector have one definition each
  - `DISCORD_NAV_SELECTORS` is the single selector table; every selector-valued entry is parse-tested
  - Documented side effect, the only one in the module: opening a channel marks it read, exactly as clicking it does
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

