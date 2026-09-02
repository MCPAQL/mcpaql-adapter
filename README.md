# MCP-AQL Reference Adapter

Reference implementation for MCP-AQL (Model Context Protocol - Advanced Agent API Adapter Query Language) adapters.

## Purpose

This repository contains the **implementation architecture documentation** and reference adapter code for the MCP-AQL protocol. It provides:

- Implementation guidance for building MCP-AQL adapters
- Architecture documentation for the universal adapter runtime
- Plugin system implementation details
- Development guides and patterns

For **normative protocol specifications** (wire format, schema semantics, interface contracts), see the [spec repository](https://github.com/MCPAQL/spec).

## Documentation

### Architecture

| Document | Description |
|----------|-------------|
| [Architecture Overview](docs/architecture/overview.md) | How adapters work internally |
| [Universal Runtime](docs/architecture/runtime.md) | Schema interpreter execution engine |
| [Plugin System](docs/architecture/plugin-system.md) | Plugin composition and MVP implementations |
| [Schema-Driven Dispatch](docs/architecture/dispatch.md) | Declarative operation dispatch pattern |

### Guides

| Document | Description |
|----------|-------------|
| [Development Guide](docs/guides/development.md) | How to build MCP-AQL adapters |
| [Testing Guide](docs/guides/testing.md) | Testing patterns for adapters |
| [Migration Guide](docs/guides/migration.md) | Migrating from MCP server to MCP-AQL adapter |
| [Discord Adapter](docs/guides/discord-adapter.md) | Read-only Discord adapter: setup, operations, posture |

### Architecture Decision Records

| ADR | Title |
|-----|-------|
| [ADR-001](docs/adr/ADR-001-plugin-pipeline-order.md) | Plugin Pipeline Order |
| [ADR-002](docs/adr/ADR-002-schema-driven-dispatch.md) | Schema-Driven Dispatch over Code Generation |
| [ADR-003](docs/adr/ADR-003-stateless-plugins.md) | Stateless Singleton Plugins |

### Examples

| Example | Description |
|---------|-------------|
| [Minimal Adapter](examples/minimal-adapter.ts) | Bare-minimum adapter with introspection |
| [User Management](examples/user-management-adapter.ts) | Full CRUDE adapter with all endpoints |

## Relationship to Spec

This repository contains **Level 4 content** (implementation guidance) from the MCP-AQL four-level protocol model:

| Level | What | Lives in |
|-------|------|----------|
| 1. Wire format | Request/response JSON, error codes, introspection | [spec](https://github.com/MCPAQL/spec) |
| 2. Schema semantics | Operation declarations, params, auth, target | [spec](https://github.com/MCPAQL/spec) |
| 3. Canonical format | Markdown + YAML front matter interchange format | [spec](https://github.com/MCPAQL/spec) |
| 4. Implementation guidance | Runtime architecture, plugin pipeline, dispatch | **this repo** |

## Related Repositories

| Repository | Purpose |
|------------|---------|
| [spec](https://github.com/MCPAQL/spec) | Protocol specification, schemas, conformance tests |
| [examples](https://github.com/MCPAQL/examples) | Example adapter configurations |
| [adapter-generator](https://github.com/MCPAQL/adapter-generator) | Tool to generate adapters from API specs |

## License

- **Documentation**: CC BY 4.0
- **Code/schemas/tests**: AGPL-3.0

See [LICENSING](LICENSING.md) for details.
