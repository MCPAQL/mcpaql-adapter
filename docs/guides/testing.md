# MCP-AQL Adapter Testing Guide

**Version:** 1.0.0-draft
**Status:** Draft
**Last Updated:** 2026-01-26

> **Note:** This guide provides practical **testing patterns** for MCP-AQL adapters. For normative protocol specifications, see the [spec repository](https://github.com/MCPAQL/spec).

## Abstract

This guide defines testing patterns and strategies for MCP-AQL adapter implementations. It covers unit testing, integration testing, endpoint routing validation, introspection verification, and conformance testing.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Unit Testing](#2-unit-testing)
3. [Integration Testing](#3-integration-testing)
4. [Endpoint Routing Tests](#4-endpoint-routing-tests)
5. [Introspection Tests](#5-introspection-tests)
6. [Plugin Tests](#6-plugin-tests)
7. [Conformance Testing](#7-conformance-testing)

---

## 1. Overview

### 1.1 Test Pyramid

MCP-AQL adapters follow a standard test pyramid:

| Level | What to Test | Speed | Count |
|-------|-------------|-------|-------|
| Unit | Individual handlers, parameter validation, response formatting | Fast | Many |
| Integration | Full request pipeline (tool call → response) | Medium | Some |
| Conformance | Protocol compliance against specification | Slow | Few |

### 1.2 Test Framework

Examples use [Vitest](https://vitest.dev/), but any test runner works:

```bash
npm install -D vitest
```

---

## 2. Unit Testing

### 2.1 Handler Tests

Test each operation handler in isolation, independent of the MCP transport layer:

```typescript
import { describe, it, expect } from "vitest";
import { createUser, getUser } from "../src/handlers/users";

describe("createUser", () => {
  it("creates user with valid params", async () => {
    const result = await createUser({
      email: "alice@example.com",
      name: "Alice",
    });

    expect(result.success).toBe(true);
    expect(result.data.email).toBe("alice@example.com");
    expect(result.data.id).toBeDefined();
  });

  it("returns error for missing required field", async () => {
    const result = await createUser({ name: "Alice" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("email");
  });

  it("applies default values", async () => {
    const result = await createUser({
      email: "bob@example.com",
      name: "Bob",
    });

    expect(result.success).toBe(true);
    expect(result.data.roles).toContain("user");
  });
});
```

### 2.2 Parameter Validation Tests

```typescript
import { validateParams } from "../src/validation";

describe("validateParams", () => {
  it("passes with all required params present", () => {
    expect(() =>
      validateParams({ email: "a@b.com", name: "A" }, ["email", "name"])
    ).not.toThrow();
  });

  it("throws for missing required params", () => {
    expect(() =>
      validateParams({ name: "A" }, ["email", "name"])
    ).toThrow("Missing required parameters: email");
  });

  it("ignores extra params", () => {
    expect(() =>
      validateParams({ email: "a@b.com", name: "A", extra: true }, ["email"])
    ).not.toThrow();
  });
});
```

### 2.3 Response Format Tests

Verify all responses use the discriminated union format:

```typescript
describe("response format", () => {
  it("success responses have success: true and data", async () => {
    const result = await listUsers({});

    expect(result).toHaveProperty("success", true);
    expect(result).toHaveProperty("data");
    expect(result).not.toHaveProperty("error");
  });

  it("error responses have success: false and error", async () => {
    const result = await getUser({ user_id: "nonexistent" });

    expect(result).toHaveProperty("success", false);
    expect(result).toHaveProperty("error");
    expect(typeof result.error).toBe("string");
  });
});
```

---

## 3. Integration Testing

### 3.1 Full Pipeline Tests

Test the complete request flow from MCP tool call to response:

```typescript
import { callTool } from "./helpers/mcp-client";

describe("full pipeline", () => {
  it("handles create → read → delete lifecycle", async () => {
    // Create
    const created = await callTool("mcp_aql_create", {
      operation: "create_user",
      params: { email: "test@example.com", name: "Test" },
    });
    expect(created.success).toBe(true);
    const userId = created.data.id;

    // Read
    const fetched = await callTool("mcp_aql_read", {
      operation: "get_user",
      params: { user_id: userId },
    });
    expect(fetched.success).toBe(true);
    expect(fetched.data.email).toBe("test@example.com");

    // Delete
    const deleted = await callTool("mcp_aql_delete", {
      operation: "delete_user",
      params: { user_id: userId },
    });
    expect(deleted.success).toBe(true);

    // Verify deleted
    const gone = await callTool("mcp_aql_read", {
      operation: "get_user",
      params: { user_id: userId },
    });
    expect(gone.success).toBe(false);
  });
});
```

### 3.2 Test Helper

A minimal test helper for calling tools without the MCP transport:

```typescript
// tests/helpers/mcp-client.ts
import { router } from "../../src/router";

export async function callTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const endpoint = toolName.replace("mcp_aql_", "").toUpperCase();
  const { operation, params } = args as {
    operation: string;
    params?: Record<string, unknown>;
  };

  return router.dispatch(operation, endpoint, params ?? {});
}
```

---

## 4. Endpoint Routing Tests

### 4.1 Correct Routing

Verify operations are accepted on their designated CRUDE endpoint:

```typescript
describe("endpoint routing", () => {
  const ROUTING_TABLE = [
    { operation: "create_user", endpoint: "mcp_aql_create" },
    { operation: "list_users", endpoint: "mcp_aql_read" },
    { operation: "introspect", endpoint: "mcp_aql_read" },
    { operation: "update_user", endpoint: "mcp_aql_update" },
    { operation: "delete_user", endpoint: "mcp_aql_delete" },
    { operation: "send_verification_email", endpoint: "mcp_aql_execute" },
  ];

  for (const { operation, endpoint } of ROUTING_TABLE) {
    it(`routes ${operation} to ${endpoint}`, async () => {
      const result = await callTool(endpoint, {
        operation,
        params: getMinimalParams(operation),
      });

      // Should not get a routing error
      if (!result.success) {
        expect(result.error).not.toContain("must be called via");
      }
    });
  }
});
```

### 4.2 Routing Rejection

Verify operations are rejected on wrong endpoints:

```typescript
describe("endpoint rejection", () => {
  it("rejects create_user on READ endpoint", async () => {
    const result = await callTool("mcp_aql_read", {
      operation: "create_user",
      params: { email: "a@b.com", name: "A" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("mcp_aql_create");
  });

  it("rejects delete_user on CREATE endpoint", async () => {
    const result = await callTool("mcp_aql_create", {
      operation: "delete_user",
      params: { user_id: "1" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("mcp_aql_delete");
  });
});
```

---

## 5. Introspection Tests

### 5.1 Operations Discovery

```typescript
describe("introspection - operations", () => {
  it("lists all operations", async () => {
    const result = await callTool("mcp_aql_read", {
      operation: "introspect",
      params: { query: "operations" },
    });

    expect(result.success).toBe(true);
    expect(result.data.operations).toBeInstanceOf(Array);
    expect(result.data.operations.length).toBeGreaterThan(0);

    // Every operation must have name, endpoint, description
    for (const op of result.data.operations) {
      expect(op).toHaveProperty("name");
      expect(op).toHaveProperty("endpoint");
      expect(op).toHaveProperty("description");
    }
  });

  it("introspect itself is discoverable", async () => {
    const result = await callTool("mcp_aql_read", {
      operation: "introspect",
      params: { query: "operations" },
    });

    const names = result.data.operations.map(
      (op: { name: string }) => op.name
    );
    expect(names).toContain("introspect");
  });

  it("returns single operation details", async () => {
    const result = await callTool("mcp_aql_read", {
      operation: "introspect",
      params: { query: "operations", name: "create_user" },
    });

    expect(result.success).toBe(true);
    expect(result.data.operation).toBeDefined();
    expect(result.data.operation.name).toBe("create_user");
  });

  it("returns null for unknown operation", async () => {
    const result = await callTool("mcp_aql_read", {
      operation: "introspect",
      params: { query: "operations", name: "nonexistent" },
    });

    expect(result.success).toBe(true);
    expect(result.data.operation).toBeNull();
  });
});
```

### 5.2 Types Discovery

```typescript
describe("introspection - types", () => {
  it("lists available types", async () => {
    const result = await callTool("mcp_aql_read", {
      operation: "introspect",
      params: { query: "types" },
    });

    expect(result.success).toBe(true);
    expect(result.data.types).toBeInstanceOf(Array);
  });
});
```

---

## 6. Plugin Tests

### 6.1 Serialization Plugin

```typescript
import { jsonPlugin } from "../src/plugins/json";

describe("JSON serialization plugin", () => {
  it("serializes objects to JSON strings", () => {
    const result = jsonPlugin.serialize({ key: "value" });
    expect(result).toBe('{"key":"value"}');
  });

  it("deserializes JSON strings to objects", () => {
    const result = jsonPlugin.deserialize('{"key":"value"}');
    expect(result).toEqual({ key: "value" });
  });

  it("throws on invalid JSON", () => {
    expect(() => jsonPlugin.deserialize("not json")).toThrow();
  });

  it("has correct content type", () => {
    expect(jsonPlugin.contentType).toBe("application/json");
  });
});
```

### 6.2 Auth Plugin

```typescript
import { bearerPlugin } from "../src/plugins/bearer";

describe("Bearer auth plugin", () => {
  it("attaches Authorization header", () => {
    const request = {
      url: "https://api.example.com/test",
      method: "GET",
      headers: {},
    };

    const result = bearerPlugin.authenticate(
      request,
      { type: "bearer", token_env: "TEST_TOKEN" },
      { getEnv: (name) => (name === "TEST_TOKEN" ? "secret123" : undefined) }
    );

    expect(result.headers["Authorization"]).toBe("Bearer secret123");
  });

  it("throws when token env var is missing", () => {
    const request = { url: "https://api.example.com/test", method: "GET", headers: {} };

    expect(() =>
      bearerPlugin.authenticate(
        request,
        { type: "bearer", token_env: "MISSING_TOKEN" },
        { getEnv: () => undefined }
      )
    ).toThrow();
  });
});
```

---

## 7. Conformance Testing

### 7.1 Conformance Checklist

Automated conformance tests verify protocol compliance:

```typescript
describe("MCP-AQL Level 1 Conformance", () => {
  it("implements introspect operation", async () => {
    const result = await callTool("mcp_aql_read", {
      operation: "introspect",
      params: { query: "operations" },
    });
    expect(result.success).toBe(true);
  });

  it("registers at least one CRUDE endpoint", async () => {
    // Adapter exposes at least mcp_aql_read (for introspect)
    const tools = await listTools();
    const crudeTools = tools.filter((t: { name: string }) =>
      t.name.startsWith("mcp_aql_")
    );
    expect(crudeTools.length).toBeGreaterThanOrEqual(1);
  });

  it("uses discriminated union responses", async () => {
    const success = await callTool("mcp_aql_read", {
      operation: "introspect",
      params: { query: "operations" },
    });
    expect(success).toHaveProperty("success", true);
    expect(success).toHaveProperty("data");

    const failure = await callTool("mcp_aql_read", {
      operation: "nonexistent_operation",
      params: {},
    });
    expect(failure).toHaveProperty("success", false);
    expect(failure).toHaveProperty("error");
  });

  it("uses snake_case for operation names", async () => {
    const result = await callTool("mcp_aql_read", {
      operation: "introspect",
      params: { query: "operations" },
    });

    for (const op of result.data.operations) {
      expect(op.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
```

### 7.2 Running Conformance Tests

```bash
# Run all tests
npx vitest

# Run only conformance tests
npx vitest tests/conformance

# Run with coverage
npx vitest --coverage
```

---

## References

- [Development Guide](development.md)
- [Architecture Overview](../architecture/overview.md)
- [MCP-AQL Specification](https://github.com/MCPAQL/spec/blob/develop/docs/versions/v1.0.0-draft.md) (spec repo)
- [Structured Error Codes](https://github.com/MCPAQL/spec/blob/develop/docs/error-codes.md) (spec repo)
