# Plugin System Implementation

**Version:** 1.0.0-draft
**Status:** Draft (MVP)
**Last Updated:** 2026-01-27
**Moved from:** [MCPAQL/spec](https://github.com/MCPAQL/spec) (implementation portions of `docs/architecture/plugin-interface.md`)

> **Note:** This document describes the **implementation architecture** of the plugin system. For normative plugin interface contracts (what each plugin type MUST provide), see the [Plugin Interface Contracts](https://github.com/MCPAQL/spec/blob/develop/docs/plugin-contracts.md) in the spec repository.

## Abstract

This document defines the plugin system implementation for the MCP-AQL adapter runtime, including plugin resolution, composition pipeline, execution order, and the behavior of MVP built-in plugins.

---

## Table of Contents

1. [Plugin Resolution](#1-plugin-resolution)
2. [MVP Plugin Implementations](#2-mvp-plugin-implementations)
3. [Plugin Composition](#3-plugin-composition)
4. [Future Extensions](#4-future-extensions)

---

## 1. Plugin Resolution

Plugins are resolved by name at runtime:

1. Check built-in plugins (shipped with runtime)
2. Return plugin instance
3. MUST fail with `PLUGIN_NOT_FOUND` error if unknown

```typescript
// Pseudocode
function resolvePlugin(category: string, name: string): Plugin {
  const plugin = BUILTIN_PLUGINS[category][name];
  if (!plugin) {
    throw new PluginNotFoundError(category, name);
  }
  return plugin;
}
```

---

## 2. MVP Plugin Implementations

### 2.1 HTTP Transport Plugin

**Name:** `http`
**Description:** HTTP/HTTPS transport using standard fetch or HTTP client

**Behavior:**

1. Constructs HTTP request from `TransportRequest`
2. Sends request using HTTPS (HTTP only for localhost)
3. MUST handle connection errors with appropriate error codes
4. MUST return raw response without interpretation

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeout` | number | 30000 | Request timeout (ms) |
| `retries` | number | 0 | Retry attempts on network failure |
| `retryDelay` | number | 1000 | Base retry delay (ms) |

**Error Handling:**

| Condition | Error Code |
|-----------|------------|
| DNS resolution failure | `TRANSPORT_DNS_ERROR` |
| Connection refused | `TRANSPORT_CONNECTION_REFUSED` |
| Connection timeout | `TRANSPORT_TIMEOUT` |
| TLS/SSL error | `TRANSPORT_TLS_ERROR` |
| Network error | `TRANSPORT_NETWORK_ERROR` |

### 2.2 REST Protocol Plugin

**Name:** `rest`
**Description:** RESTful API conventions over HTTP

**Request Building:**

1. Parse `maps_to` format: `METHOD /path/with/{placeholders}`
2. Extract HTTP method (GET, POST, PUT, PATCH, DELETE)
3. Substitute path placeholders with parameter values
4. Build query string for GET requests with remaining params
5. Build request body for non-GET requests with remaining params
6. Set appropriate Content-Type header

**Path Parameter Substitution:**

```
maps_to: "GET /repos/{owner}/{repo}/issues/{issue_number}"
params: { owner: "octocat", repo: "Hello-World", issue_number: 42 }
result: "GET /repos/octocat/Hello-World/issues/42"
```

**Query vs Body Parameters:**

| Method | Path Params | Other Params |
|--------|-------------|--------------|
| GET | In URL path | Query string |
| DELETE | In URL path | Query string |
| POST | In URL path | Request body |
| PUT | In URL path | Request body |
| PATCH | In URL path | Request body |

**Response Parsing:**

| Status Range | Result |
|--------------|--------|
| 2xx | `ok: true`, data from body |
| 4xx | `ok: false`, error from body or status |
| 5xx | `ok: false`, error from body or status |

### 2.3 JSON Serialization Plugin

**Name:** `json`
**Description:** JSON encoding/decoding
**Content-Type:** `application/json`

**Serialize:**
- MUST call `JSON.stringify(data)`
- MUST handle circular references with error

**Deserialize:**
- MUST call `JSON.parse(raw)`
- MUST return `null` for empty responses
- MUST throw on malformed JSON

**Error Handling:**

| Condition | Error Code |
|-----------|------------|
| Circular reference | `SERIALIZATION_CIRCULAR_REF` |
| Invalid JSON in response | `SERIALIZATION_PARSE_ERROR` |

### 2.4 None Auth Plugin

**Name:** `none`
**Description:** No authentication

**Behavior:** Returns request unchanged.

```typescript
authenticate(request, config, context) {
  return request;
}
```

### 2.5 API Key Auth Plugin

**Name:** `api_key`
**Description:** API key in HTTP header

**Configuration:**

```yaml
auth:
  type: api_key
  header_name: X-API-Key
  key_env: MY_API_KEY
```

**Behavior:**

1. Read key from `context.getEnv(config.key_env)`
2. Add header `config.header_name: {key}`
3. Fail if key not found in environment

**Error Handling:**

| Condition | Error Code |
|-----------|------------|
| Missing key_env in config | `AUTH_CONFIG_INVALID` |
| Missing header_name in config | `AUTH_CONFIG_INVALID` |
| Environment variable not set | `AUTH_CREDENTIAL_MISSING` |

### 2.6 Bearer Auth Plugin

**Name:** `bearer`
**Description:** Bearer token in Authorization header

**Configuration:**

```yaml
auth:
  type: bearer
  token_env: GITHUB_TOKEN
```

**Behavior:**

1. Read token from `context.getEnv(config.token_env)`
2. Add header `Authorization: Bearer {token}`
3. Fail if token not found in environment

**Error Handling:**

| Condition | Error Code |
|-----------|------------|
| Missing token_env in config | `AUTH_CONFIG_INVALID` |
| Environment variable not set | `AUTH_CREDENTIAL_MISSING` |

---

## 3. Plugin Composition

### 3.1 Request Pipeline

Plugins compose into a request pipeline:

```
┌──────────────────────────────────────────────────────────────┐
│                    OPERATION REQUEST                          │
│  { operation: "get_repo", params: { owner, repo } }          │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                    PROTOCOL PLUGIN                            │
│  rest.buildRequest()                                          │
│  Maps operation to HTTP request structure                     │
│  Output: { url, method, headers, body? }                     │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                 SERIALIZATION PLUGIN                          │
│  json.serialize()                                             │
│  Serializes body if present, sets Content-Type               │
│  Output: { url, method, headers, body: string }              │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                     AUTH PLUGIN                               │
│  bearer.authenticate()                                        │
│  Attaches Authorization header                                │
│  Output: { url, method, headers + auth, body }               │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                   TRANSPORT PLUGIN                            │
│  http.send()                                                  │
│  Sends HTTP request, receives response                        │
│  Output: { status, statusText, headers, body }               │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                 SERIALIZATION PLUGIN                          │
│  json.deserialize()                                           │
│  Parses response body                                         │
│  Output: parsed data object                                   │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                    PROTOCOL PLUGIN                            │
│  rest.parseResponse()                                         │
│  Interprets status, extracts data or error                   │
│  Output: { ok, status, data, error? }                        │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                   MCP-AQL RESPONSE                            │
│  { success: true, data: {...} }                              │
│  OR { success: false, error: "..." }                         │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Pipeline Execution

```typescript
// Pseudocode
async function executePipeline(
  operation: OperationDefinition,
  params: Record<string, unknown>,
  adapter: AdapterSchema
): Promise<OperationResult> {
  const protocol = resolvePlugin('protocol', adapter.target.protocol);
  const serialization = resolvePlugin('serialization', adapter.target.serialization);
  const auth = resolvePlugin('auth', adapter.auth.type);
  const transport = resolvePlugin('transport', adapter.target.transport);

  // Build request
  let request = protocol.buildRequest(operation, params, adapter.target);

  // Serialize body if present
  if (request.body !== undefined) {
    request.body = serialization.serialize(request.body);
    request.headers['Content-Type'] = serialization.contentType;
  }

  // Attach authentication
  request = auth.authenticate(request, adapter.auth, authContext);

  // Send request
  const response = await transport.send(request, {});

  // Deserialize response
  const body = serialization.deserialize(response.body);

  // Parse into standard format
  const parsed = protocol.parseResponse({ ...response, body }, operation);

  // Convert to MCP-AQL result
  if (parsed.ok) {
    return { success: true, data: parsed.data };
  } else {
    return { success: false, error: parsed.error.message };
  }
}
```

---

## 4. Future Extensions

### 4.1 Additional Transport Plugins

**WebSocket (`websocket`):**
- Persistent bidirectional connections
- Message framing and delivery
- Reconnection handling

**Serial (`serial`):**
- Serial port communication
- Baud rate and flow control
- Platform-specific drivers

**Native (`native-*`):**
- Platform-specific native APIs
- macOS, Windows, Linux variants
- Direct system calls without HTTP

### 4.2 Additional Protocol Plugins

**GraphQL (`graphql`):**
- Query/mutation construction
- Variable substitution
- Error extraction from extensions

**gRPC (`grpc`):**
- Protocol buffer serialization
- HTTP/2 framing
- Streaming support

**JSON-RPC (`jsonrpc`):**
- Request ID management
- Batch requests
- Error code mapping

### 4.3 Additional Auth Plugins

**OAuth 2.0 (`oauth`):**
- Multiple flow types (authorization code, client credentials)
- Token refresh handling
- Scope management

**Mutual TLS (`mtls`):**
- Client certificate management
- Certificate chain validation
- Key storage integration

**AWS Signature V4 (`aws-sig4`):**
- Request signing
- Region and service scoping
- Credential resolution

### 4.4 Pagination Plugins

See #37 for cursor-based pagination specification.

| Plugin | Style | Description |
|--------|-------|-------------|
| `cursor` | Opaque cursor | Next cursor in response |
| `offset` | Limit/offset | Numeric offset pagination |
| `page` | Page number | Page-based pagination |
| `link_header` | RFC 5988 | Link header parsing |

### 4.5 User-Extensible Plugins

Future versions may support:
- Plugin directory for user-installed plugins
- Plugin manifest format
- Security sandboxing
- Plugin versioning and updates

---

## References

- [Plugin Interface Contracts](https://github.com/MCPAQL/spec/blob/develop/docs/plugin-contracts.md) (normative interfaces)
- [Adapter Element Type Specification](https://github.com/MCPAQL/spec/blob/develop/docs/adapter/element-type.md)
- [Universal Adapter Runtime](./runtime.md)
- [MCP-AQL Specification](https://github.com/MCPAQL/spec/blob/develop/docs/versions/v1.0.0-draft.md)
- GitHub Issue: [#62](https://github.com/MCPAQL/spec/issues/62)
