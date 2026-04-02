# Migration Guide: MCP Server to MCP-AQL Adapter

**Version:** 1.0.0-draft
**Status:** Draft
**Last Updated:** 2026-01-26

> **Note:** This guide provides practical **migration instructions** for converting existing MCP servers to MCP-AQL adapters. For normative protocol specifications, see the [spec repository](https://github.com/MCPAQL/spec).

## Abstract

This guide walks through the process of migrating an existing Model Context Protocol (MCP) server — one that exposes individual tools — to an MCP-AQL adapter that consolidates those tools into semantic CRUDE endpoints. The result is a ~96% reduction in token overhead while preserving full functionality.

---

## Table of Contents

1. [Why Migrate](#1-why-migrate)
2. [Before You Start](#2-before-you-start)
3. [Migration Steps](#3-migration-steps)
4. [Mapping Tools to CRUDE Operations](#4-mapping-tools-to-crude-operations)
5. [Converting Tool Handlers](#5-converting-tool-handlers)
6. [Adding Introspection](#6-adding-introspection)
7. [Validation Checklist](#7-validation-checklist)

---

## 1. Why Migrate

### 1.1 The Problem with Individual Tools

A standard MCP server registers each capability as a separate tool. For a server with 50 operations, the LLM receives 50 tool definitions in its context window:

```
50 tools × ~800 tokens/tool = ~40,000 tokens per request
```

This creates:
- **Context window pressure** — Less room for user content and reasoning
- **Selection confusion** — LLMs struggle to choose among many similar tools
- **Scaling limits** — Adding operations linearly increases token cost

### 1.2 What MCP-AQL Changes

MCP-AQL consolidates all operations behind 5 CRUDE endpoints:

```
5 endpoints × ~200 tokens/endpoint = ~1,000 tokens per request
```

Operations are discovered at runtime via introspection rather than statically defined in the tool list.

### 1.3 What Stays the Same

- Your backend logic does not change
- Your MCP server infrastructure (transport, connection) stays the same
- Parameter validation logic is reusable
- Response data structures are preserved

---

## 2. Before You Start

### 2.1 Inventory Your Tools

List every tool your MCP server currently registers. For each tool, note:

| Tool Name | What It Does | Read-Only? | Destructive? | Side Effects? |
|-----------|-------------|------------|--------------|---------------|

This inventory drives the CRUDE categorization in Step 4.

### 2.2 Identify Shared Parameters

Look for parameters that appear across multiple tools (e.g., `owner`, `repo` in a GitHub integration). These become path parameters or shared context in the adapter.

---

## 3. Migration Steps

### 3.1 Overview

| Step | What Changes | Effort |
|------|-------------|--------|
| 1. Categorize tools into CRUDE endpoints | Tool registration | Low |
| 2. Create operation router | New component | Medium |
| 3. Convert tool handlers to operation handlers | Handler signatures | Low |
| 4. Add introspection | New handler | Medium |
| 5. Update tool registration | 50 tools → 5 endpoints | Low |
| 6. Test and validate | Test updates | Medium |

### 3.2 Step-by-Step

The following sections walk through each step with code examples.

---

## 4. Mapping Tools to CRUDE Operations

### 4.1 Categorization Rules

| CRUDE Endpoint | Criteria | Examples |
|----------------|----------|----------|
| **CREATE** | Adds new state, non-destructive, additive | `create_file`, `add_tag`, `import_data` |
| **READ** | Read-only, no side effects, safe to retry | `get_file`, `list_items`, `search`, `introspect` |
| **UPDATE** | Modifies existing state | `rename_file`, `edit_content`, `change_status` |
| **DELETE** | Removes state, destructive | `delete_file`, `remove_tag`, `purge_cache` |
| **EXECUTE** | Non-idempotent, runtime lifecycle, side effects | `run_build`, `send_email`, `deploy`, `restart` |

### 4.2 Common Mappings

**Before (individual MCP tools):**

```typescript
// 12 separate tools registered
tools: [
  { name: "create_repo", ... },
  { name: "fork_repo", ... },
  { name: "list_repos", ... },
  { name: "get_repo", ... },
  { name: "search_repos", ... },
  { name: "get_readme", ... },
  { name: "update_repo", ... },
  { name: "transfer_repo", ... },
  { name: "delete_repo", ... },
  { name: "archive_repo", ... },
  { name: "star_repo", ... },
  { name: "unstar_repo", ... },
]
```

**After (CRUDE categorization):**

```typescript
const OPERATION_ROUTES = {
  // CREATE - additive
  create_repo:  { endpoint: "CREATE" },
  fork_repo:    { endpoint: "CREATE" },
  star_repo:    { endpoint: "CREATE" },

  // READ - safe, read-only
  list_repos:   { endpoint: "READ" },
  get_repo:     { endpoint: "READ" },
  search_repos: { endpoint: "READ" },
  get_readme:   { endpoint: "READ" },
  introspect:   { endpoint: "READ" },

  // UPDATE - modifying
  update_repo:   { endpoint: "UPDATE" },
  transfer_repo: { endpoint: "UPDATE" },
  archive_repo:  { endpoint: "UPDATE" },

  // DELETE - destructive
  delete_repo: { endpoint: "DELETE" },
  unstar_repo: { endpoint: "DELETE" },
};
```

### 4.3 Ambiguous Cases

Some operations could fit multiple categories. Use these tiebreakers:

| Ambiguity | Resolution |
|-----------|-----------|
| "Star" something | CREATE (adding a relation) |
| "Unstar" something | DELETE (removing a relation) |
| "Archive" something | UPDATE (changing state, not removing) |
| "Transfer" ownership | UPDATE (changing attribute) |
| "Fork" something | CREATE (producing a new resource) |
| "Run" or "trigger" something | EXECUTE (side effects, non-idempotent) |

---

## 5. Converting Tool Handlers

### 5.1 Before: Individual Tool Handler

```typescript
// Old: Each tool has its own handler
server.setRequestHandler("tools/call", async (request) => {
  switch (request.params.name) {
    case "create_repo":
      return handleCreateRepo(request.params.arguments);
    case "list_repos":
      return handleListRepos(request.params.arguments);
    // ... 10 more cases
  }
});
```

### 5.2 After: CRUDE Router

```typescript
// New: Single router dispatches to handlers
server.setRequestHandler("tools/call", async (request) => {
  const { name: toolName, arguments: args } = request.params;
  const endpoint = toolName.replace("mcp_aql_", "").toUpperCase();
  const { operation, params } = args;

  // Validate routing
  const route = OPERATION_ROUTES[operation];
  if (!route) {
    return formatError(`Unknown operation: ${operation}`);
  }
  if (route.endpoint !== endpoint) {
    return formatError(
      `Operation '${operation}' must be called via mcp_aql_${route.endpoint.toLowerCase()}`
    );
  }

  // Dispatch to existing handler (unchanged!)
  return handlers[operation](params);
});
```

### 5.3 Handler Signatures

Your existing handler logic stays the same. The only change is how it's invoked:

```typescript
// This function is identical before and after migration
async function handleCreateRepo(params: {
  name: string;
  private?: boolean;
  description?: string;
}) {
  const repo = await github.createRepo(params);
  return { success: true, data: repo };
}
```

---

## 6. Adding Introspection

### 6.1 Required Operation

Every MCP-AQL adapter MUST implement `introspect`. This operation enables runtime discovery — LLMs call it to learn what operations are available.

```typescript
function handleIntrospect(params: { query: string; name?: string }) {
  if (params.query === "operations") {
    if (params.name) {
      const op = OPERATION_ROUTES[params.name];
      return {
        success: true,
        data: { operation: op ? formatOperation(params.name, op) : null },
      };
    }
    return {
      success: true,
      data: {
        operations: Object.entries(OPERATION_ROUTES).map(
          ([name, route]) => formatOperation(name, route)
        ),
      },
    };
  }

  if (params.query === "types") {
    return { success: true, data: { types: getTypeDefinitions() } };
  }

  return { success: false, error: `Unknown query: ${params.query}` };
}
```

### 6.2 Building the Operation Catalog

Generate introspection data from your existing tool definitions:

```typescript
function formatOperation(name: string, route: OperationRoute) {
  return {
    name,
    endpoint: route.endpoint,
    description: route.description,
    parameters: route.parameters?.map((p) => ({
      name: p.name,
      type: p.type,
      required: p.required ?? false,
      description: p.description,
    })),
  };
}
```

---

## 7. Validation Checklist

After migration, verify:

```markdown
## Migration Validation

### Tool Registration
- [ ] Old individual tools are removed
- [ ] 5 CRUDE endpoints registered (or fewer if not all are needed)
- [ ] Tool descriptions are clear and endpoint-specific

### Operation Routing
- [ ] Every former tool maps to exactly one CRUDE endpoint
- [ ] Operations are rejected on wrong endpoints
- [ ] Unknown operations return clear error messages

### Introspection
- [ ] `introspect` operation works via mcp_aql_read
- [ ] All operations are discoverable
- [ ] Operation details include parameters and descriptions

### Response Format
- [ ] All responses use `{ success: true, data }` or `{ success: false, error }`
- [ ] No raw exceptions leak to clients

### Backwards Compatibility
- [ ] All functionality from original tools is preserved
- [ ] Parameter names follow snake_case convention
- [ ] Response data structures are unchanged

### Token Reduction
- [ ] Tool count reduced from N to 5 (or fewer)
- [ ] Estimated token savings calculated
```

---

## References

- [Development Guide](development.md)
- [Testing Guide](testing.md)
- [Architecture Overview](../architecture/overview.md)
- [CRUDE Pattern](https://github.com/MCPAQL/spec/blob/develop/docs/crude-pattern.md) (spec repo)
- [MCP-AQL Specification](https://github.com/MCPAQL/spec/blob/develop/docs/versions/v1.0.0-draft.md) (spec repo)
