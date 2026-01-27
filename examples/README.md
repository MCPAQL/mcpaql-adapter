# Examples

Minimal working examples demonstrating MCP-AQL adapter patterns.

## Contents

| Example | Description |
|---------|-------------|
| [minimal-adapter.ts](minimal-adapter.ts) | Bare-minimum adapter with introspection only |
| [user-management-adapter.ts](user-management-adapter.ts) | CRUDE adapter with all five endpoints |

## Running Examples

```bash
# Prerequisites
node >= 18.0.0
npm install @modelcontextprotocol/sdk

# Run an example
npx tsx examples/minimal-adapter.ts
```

## Relationship to Examples Repo

These examples focus on **adapter implementation patterns** (TypeScript code).
For **adapter schema definitions** (declarative YAML), see the [examples repository](https://github.com/MCPAQL/examples).
