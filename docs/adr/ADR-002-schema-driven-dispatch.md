# ADR-002: Schema-Driven Dispatch over Code Generation

**Status:** Accepted
**Date:** 2026-01-26

## Context

When an MCP-AQL operation is invoked, the runtime must translate it into a target API call. Two approaches were considered:

1. **Code generation** — Generate TypeScript/JavaScript handler code from the adapter schema at build time. Each operation gets a concrete function.

2. **Schema-driven dispatch** — The runtime interprets the adapter schema at call time. No generated code; the schema itself drives request construction.

## Decision

Use schema-driven dispatch. The runtime reads the adapter schema (YAML front matter), resolves the operation definition, substitutes parameters into the URL template, and builds the HTTP request dynamically.

## Rationale

| Factor | Code Generation | Schema-Driven |
|--------|----------------|---------------|
| Build step required | Yes | No |
| Hot reloadable | No (rebuild required) | Yes (re-read schema) |
| Security auditability | Must audit generated code | Audit the schema directly |
| Complexity | Higher (codegen tooling) | Lower (interpreter) |
| Performance | Slightly faster (static) | Negligible overhead |
| Debugging | Generated code can be opaque | Schema is the source of truth |

The security auditability benefit is particularly important: adapter schemas define what API calls an LLM can make, and a text-based schema that is directly interpreted is easier to review than generated code.

## Consequences

**Positive:**
- No build step — change the schema, behavior changes immediately
- Schema IS the adapter — single source of truth
- Easier security auditing — review YAML, not generated code
- Simpler tooling — no code generator to maintain

**Negative:**
- Cannot express complex logic (conditionals, loops) in schemas
- Slightly more runtime overhead per request (negligible for HTTP I/O)
- Advanced use cases may need escape hatches (deferred)

## References

- [Schema-Driven Dispatch](../architecture/dispatch.md)
- [Adapter Element Type Specification](https://github.com/MCPAQL/spec/blob/develop/docs/adapter/element-type.md) (spec repo)
