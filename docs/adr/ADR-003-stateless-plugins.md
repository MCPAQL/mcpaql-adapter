# ADR-003: Stateless Singleton Plugins

**Status:** Accepted
**Date:** 2026-01-26

## Context

Plugins handle transport, protocol, serialization, and authentication. The runtime needs a strategy for plugin lifecycle management:

1. **Stateful instances** — Create a new plugin instance per request. Plugins can maintain request-specific state.

2. **Stateless singletons** — One plugin instance per type, shared across all requests. Plugins must not maintain request-specific state.

## Decision

Plugins are stateless singletons. The runtime resolves each plugin once at adapter load time and reuses the same instance for all requests. Plugins MUST NOT maintain request-specific state between calls.

## Rationale

- **Simplicity** — No instance management, no lifecycle hooks, no cleanup
- **Thread safety** — No shared mutable state eliminates concurrency issues
- **Testability** — Stateless functions are trivially unit testable
- **Memory** — One instance per plugin type, not per request
- **Predictability** — No hidden state means no order-dependent bugs

Request-specific context is passed explicitly via function parameters (`TransportRequest`, `AuthConfig`, `AuthContext`), not stored in plugin instances.

## Consequences

**Positive:**
- Simple mental model — plugins are pure functions with a namespace
- No memory leaks from accumulated request state
- Safe to share across concurrent requests
- Easy to mock in tests

**Negative:**
- Plugins that need persistent state (connection pools, caches) must use external mechanisms
- OAuth token refresh requires state — the `AuthContext` interface provides `getEnv()` as an escape hatch; richer state management deferred to future specification

## References

- [Plugin Interface Contracts](https://github.com/MCPAQL/spec/blob/develop/docs/plugin-contracts.md) (spec repo)
- [Plugin System Implementation](../architecture/plugin-system.md)
