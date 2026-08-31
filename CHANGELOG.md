# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
- Native AppleScript transport plugin (`src/plugins/transport/`)
  - `native-applescript.ts` - Transport plugin for macOS application automation via osascript
  - `sanitizer.ts` - Parameter sanitization and injection prevention (AppleScript equivalent of SQL parameterization)
  - `serializer.ts` - AppleScript output to JSON serialization and JXA JSON wrapper
  - `types.ts` - Type definitions for script templates, configs, and results
  - Predefined JXA templates for Apple Mail operations
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
- Standardized documentation dates to 2026-01-26
- Expanded development guide prerequisites with dependency table and setup commands
- Updated `COMMERCIAL-LICENSE-TERMS.md` with indemnification provisions, support/SLA clarifications, and renumbered downstream sections to stay aligned with the spec repository
