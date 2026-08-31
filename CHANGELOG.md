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
  - `describeExecutionFailure()` — structured failure details for osascript errors (exit code, signal, elapsed time, timeout limit, stdout preview); `ScriptResult` now carries `elapsedMs`, `signal`, and `timedOut`
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

- Standardized documentation dates to 2026-01-26
- Expanded development guide prerequisites with dependency table and setup commands
- Updated `COMMERCIAL-LICENSE-TERMS.md` with indemnification provisions, support/SLA clarifications, and renumbered downstream sections to stay aligned with the spec repository

### Fixed

- Non-zero osascript exit codes are now reported correctly: the transport read `error.status` (only set by sync child_process APIs) instead of `error.code`, so every non-zero exit surfaced as exit code 1
- Native transport failures no longer surface as an empty message: `TRANSPORT_NATIVE_EXECUTION_ERROR` / `TRANSPORT_NATIVE_TIMEOUT` always name the exit code or signal and elapsed time, truncate oversized stderr, and include a stdout preview when stderr is empty (#32 section C; failure mode observed in adapter-generator#42)

