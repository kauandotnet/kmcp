# Architecture

## Intent

`kmcp` is a framework-neutral TypeScript library over the official MCP SDK v2. Its protocol,
authoring, lifecycle, discovery, and control-plane abstractions stand on their own.

The library keeps protocol mechanics and control-plane mechanics separate:

```text
authoring definitions ──> fresh official McpServer instances ──> HTTP / stdio adapters

transport factory ──> official Client ──> connection manager ──> partial catalog
                                                │
                                                └──────────────> hub read model / routing
```

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
  are not silently claimed by this package.

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

## Hub model

A hub is a class containing a safe ID, labels, and unique connection/namespace members. Tool and
prompt routes are reversible (`namespace.sourceName`) and dispatch through the managed generation.
Resources require an explicit namespace because arbitrary resource URIs cannot be safely rewritten
without a protocol gateway policy.

The current hub is intentionally a diagnostic read-model and routing kernel. Its aggregate catalog
contains descriptor routes for tools, prompts, static resources, and resource templates. Passing a
descriptor to an executable route rejects stale panel work; string routes deliberately resolve the
current catalog. A route is admitted only while its exact discovered item, generation, and catalog
fingerprint are current. It does not advertise itself as a downstream MCP server. A real gateway
must add:

- mandatory fail-closed execution policy;
- request-time immutable topology snapshots;
- collision-safe tool, prompt, resource, and template projection;
- auth-principal-partitioned discovery caches;
- complete candidate topology preparation and atomic publication;
- notification, subscription, completion, and input-required routing only when end-to-end support
  exists.

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
