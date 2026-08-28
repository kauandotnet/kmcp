# Architecture

## Intent

`kmcp` is a framework-neutral TypeScript library over the official MCP SDK v2. Its protocol,
authoring, lifecycle, discovery, and control-plane abstractions stand on their own.

The library keeps protocol mechanics and control-plane mechanics separate:

```text
authoring definitions ──> transforms ──> fresh official McpServer instances ──> HTTP / stdio adapters
                                              ▲
transport factory ──> official Client ──> connection manager ──> partial catalog
                                                │
                                                └──────────────> hub read model / routing ──> gateway
```

The library targets protocol revision 2026-07-28 (`MCP_MODERN_PROTOCOL_VERSION`); the 2025 era is
served from the same definitions through the SDK's stateless legacy fallback and tested alongside.

## Canonical object model

Every authoring surface materializes classes:

- `McpToolDefinition`
- `McpPromptDefinition`
- `McpResourceDefinition`
- `McpResourceTemplateDefinition`
- `McpServerDefinition`
- `McpServerRuntime`

Functional helpers are constructors with inference. The persistent builder accumulates the same
instances. Stage-3 decorators store per-instance recipes and compile those recipes into the same
classes. `McpServerRuntime` preserves official registration handles so advanced callers retain
enable, disable, update, and remove operations.

SDK schemas and handlers remain live runtime objects; they are not misrepresented as portable JSON.
Definitions detach and freeze protocol metadata while leaving schemas, templates, and handlers live.
Manager snapshots deliberately omit configured transport and credential material, but they are raw
diagnostic projections—not a substitute for an authorized, redacted, bounded public-panel DTO.

## Official SDK v2 rules preserved

- HTTP uses the official per-request `McpServerFactory` model.
- Client transports are neither pre-started nor shared; the official `Client` owns them.
- Standard Schema with JSON is the primary schema boundary. Deprecated raw Zod shapes are not part
  of this API.
- Schema-less tool callback arity remains `(context)`, not `(undefined, context)`.
- Client list methods use the official no-cursor aggregate behavior and configured page bound.
- Missing advertised capabilities become `unsupported`; an empty list alone is not treated as proof
  of support.
- Modern version negotiation is explicit. `kmcp` chooses `auto` by default but preserves the full
  official options as an escape hatch.
- Server authentication and arbitrary-upstream admission security are not invented by the SDK and
  are not silently claimed by this package. Verifiers are SDK `OAuthTokenVerifier`s, the gate is the
  SDK's `requireBearerAuth` composed with the well-known documents, and every default is fail-closed
  (`anonymous` has no default; routable binds require a gate or an explicit opt-out).
- Re-export policy: `kmcp/server` and `kmcp/client` re-export the curated SDK authoring and client
  sets so application code imports one package; the SDK's `LATEST_PROTOCOL_VERSION` (the latest
  _legacy_ revision) is deliberately not part of it.
- Two SDK gaps are bridged in one place each and covered by tests: `Client.callTool` output
  validation rejects a raw `input_required` result, so the manager sends `allowInputRequired` calls
  through the schema-less request path; the SDK's completion lookup only sees Zod `completable()`
  fields, so definitions with `complete` maps install kmcp's own `completion/complete` handler.

## Connection lifecycle invariants

Each registered definition contains safe identity fields and a transport factory. Credentials and
endpoint construction can remain inside that closure. They never enter manager snapshots.

The manager guarantees:

1. At most one connect task per connection.
2. A caller abort only stops that caller waiting; it cannot tear down a shared connect.
3. New operations are rejected after draining begins.
4. Disconnect waits for admitted operations before closing the official client.
5. Cleanup failure becomes `quarantined`, rather than falsely reporting `offline`.
6. Every successful connect receives a manager-lifetime monotonic generation, including after an ID
   is removed and registered again.
7. Catalog snapshots are valid only for their exact generation; reconnecting clears the published
   catalog rather than restamping prior data.
8. Removal is single-flight and fences reconnects already queued behind an earlier disconnect.

The present implementation is process-local. Durable desired state and cross-process ownership must
not be inferred from these guarantees.

## Auth model

Capability `auth` is admission at materialization: `definition.admit(context)` evaluates every check
against `context.authInfo` and `instantiate()` installs exactly the admitted set, so a denied
capability is absent from lists and answers "not found" with zero request-time code. Capability
kinds are pre-declared from the unfiltered definition so an empty admitted set yields empty lists,
never `-32601`. The HTTP gate is the only `authInfo` producer; `withMcpAuth` discards
caller-supplied `authInfo`. Clients receive opaque OAuth reasons; detailed causes go to `onerror` /
`onCapabilityDenied`.

## Catalog model

Tools, resources, templates, and prompts are discovered independently. Each section is one of:

- `unsupported`: the negotiated server capabilities do not advertise it.
- `fresh`: the latest discovery succeeded.
- `stale`: discovery failed, but a prior generation-bound view is retained.
- `failed`: discovery failed and no prior items exist.

Catalog item counts and JSON structure are bounded. One guarded traversal normalizes official SDK
list values into detached, recursively frozen JSON before publication; optional object properties
whose value is `undefined` are omitted with JSON semantics, while invalid array entries, accessors,
symbols, exotic prototypes, and cycles are rejected. Fingerprints are stable change detectors, not
cryptographic integrity proofs.

## Hub and gateway model

A hub is a class containing a safe ID, labels, and unique connection/namespace members. Tool and
prompt routes are reversible (`namespace.sourceName`), resource routes are `namespace:uri`, and
every route dispatches through the managed generation and catalog fingerprint. Template-expanded
reads are matched against the member's listed templates with the SDK `UriTemplate`.

`kmcp/gateway` serves a hub as one downstream MCP server and satisfies the prerequisites a real
gateway needs:

| Prerequisite                         | Mechanism                                                                                                                                                                                                                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request-time immutable topology      | Every request materializes a server from one hub catalog snapshot (`McpGatewayDefinition.current()`), rebuilt only when the topology key changes.                                                                                                                                 |
| Fail-closed execution policy         | Handlers resolve the projected name against the current route index at call time; a removed route fails closed, a live one dispatches through the hub's generation/fingerprint fence.                                                                                             |
| Collision-safe projection            | `namespace.name` validated against the SDK tool-name grammar; resources `namespaced` (reversible `ns:uri`, requires a scheme-safe namespace) or `passthrough` (a URI listed by two members drops both). Unprojectable routes are reported in `snapshot().dropped`, never renamed. |
| Principal-partitioned discovery      | `policy.authorize` is capability `auth`; downstream `authInfo` is never forwarded upstream, upstream connections carry their own credentials and cache partitions.                                                                                                                |
| Atomic publication                   | A new hub snapshot is a new projection; `gateway.start()` diffs sections and pushes `list_changed` to live HTTP handlers and reconciles pinned instances (stdio) in place.                                                                                                        |
| Routing only with end-to-end support | MRTR rounds (`inputResponses`, `requestState`, downstream client capabilities) are relayed verbatim; completions forwarded when the upstream advertises them; logging and resource-update subscriptions are not forwarded.                                                        |

## Path to a durable panel/control plane

The next extraction should introduce ports rather than add framework state to the core:

1. `McpControlPlaneStore` with transactional connections, hubs, catalogs, observations, and outbox.
2. Revision/CAS-based desired state, tombstones, and opaque runtime generations.
3. Mandatory admin policy, separate from downstream hub execution policy.
4. Explicit connection and hub reconcilers: prepare candidate, preflight, atomically swap, persist
   observation, then drain the old generation.
5. Replayable event cursor paired with a consistent snapshot for race-free panel hydration.
6. Credential references and SSRF/redirect/DNS/credential-forwarding admission around arbitrary
   upstream URLs.
7. At least one durable adapter with restart hydration before claiming persistence.

HTTP frameworks, a CLI, or a web panel should be adapters over these contracts—not part of the
protocol/control-plane kernel.

## Known gaps

- Cursor pagination, list-level middleware and protocol-level tool errors all require ownership of
  the SDK `tools/list` / `tools/call` handlers, which `McpServer` does not delegate; revisit when
  the SDK adds page sizes or a protocol-error passthrough.
- The modern event bus fans `resourceUpdated(uri)` out to every subscription regardless of
  principal; per-principal visibility does not extend to update notifications, so the gateway does
  not forward them (phase 2 must gate `resourceSubscriptions` per principal).
- Legacy per-request HTTP serving cannot deliver server-to-client requests (no client capability
  view); modern clients get the full MRTR path, 2025 clients over stdio get the SDK's legacy shim.
