# ADR-001: Plugin Pipeline Order

**Status:** Accepted
**Date:** 2026-01-26

## Context

The universal adapter runtime composes four plugin types (protocol, auth, serialization, transport) into a request pipeline. The order in which these plugins execute affects correctness:

- The protocol plugin must build the request structure before auth can attach credentials
- Auth must modify headers before serialization finalizes the body
- Serialization must set the Content-Type header before transport sends
- Transport is always last (it performs the actual I/O)

Several orderings are possible, and getting this wrong causes subtle bugs (e.g., auth headers overwritten by serialization, or Content-Type set before the body is ready).

## Decision

The plugin pipeline executes in this fixed order:

1. **Protocol** — builds `TransportRequest` from operation definition and parameters
2. **Auth** — attaches credentials (headers, query params) to the request
3. **Serialization** — encodes the request body and sets Content-Type
4. **Transport** — sends the request and returns raw response

Response processing reverses the relevant steps:

1. **Serialization** — decodes the response body
2. **Protocol** — parses the response into `ParsedResponse` format

## Consequences

**Positive:**
- Auth plugins can set headers without worrying about serialization overwriting them
- Protocol plugins produce a complete request structure that downstream plugins augment
- The fixed order eliminates a class of composition bugs
- Easy to reason about and debug

**Negative:**
- Less flexible than a fully configurable pipeline
- Auth plugins that need to sign the serialized body (e.g., AWS Signature V4) will need access to the post-serialization request — deferred to future specification

## References

- [Plugin System Implementation](../architecture/plugin-system.md)
- [Plugin Interface Contracts](https://github.com/MCPAQL/spec/blob/develop/docs/plugin-contracts.md) (spec repo)
