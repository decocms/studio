# @decocms/sandbox-controller

Runs Studio agent sandboxes on Kubernetes for a service outside Studio, and
serves them to Studio as a remote provider.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/sandbox-controller` (`packages/sandbox-controller`) |
| Kind | Public library, bundled from `@decocms/sandbox` |
| Runtime | Bun |
| Distribution | Public npm package |

## Overview

The sandbox controller is a library, not a service. A host process — on deco's
clusters, `decocms/control-plane` — depends on it, builds an
`AgentSandboxProvider` against the sandbox cluster, and serves the sandbox API.
Studio's `RemoteSandboxProvider` (`@decocms/sandbox/provider/remote`) calls
that API when `STUDIO_SANDBOX_CONTROL_PLANE_URL` is set; without it, Studio runs
the same provider in-process.

The package re-exports code from `@decocms/sandbox` and `@decocms/shared`,
which are private, and bundles it into one module with declarations.

## Responsibilities

- Export `AgentSandboxProvider`, its option and state-store types, and
  `kubeConfigForServer`, a credential-less kubeconfig for a local proxy, built
  with the package's own client.
- Export `migrateSandboxControllerSchema`, which creates and upgrades the
  library's own `sandbox_controller` Postgres schema, and the stores in it:
  `postgresRunnerStateStore`, a `RunnerStateStore` (its `scope` keeps several
  hosts' or environments' rows and locks apart in one database), and
  `postgresTenantPoolStore`, the tenant warm pools per sandbox cluster, with
  `tenantPoolReader`, a cached list for the provider's `tenantPools`.
- Export the tenant pool model: `TenantPool` and `TenantPoolRepo`, their
  validators (`tenantPoolSchema`, `tenantPoolFieldsSchema`,
  `tenantPoolRepoSchema`), `normalizeRepoUrl`, and
  `renderTenantPoolWarmPools`, which builds a pool's `SandboxWarmPool`
  objects for the host to apply.
- Export the wire contract in `sandbox-api`: tool names and schemas, and the
  watch route.
- Export host helpers: `sandboxTools` (framework-free tool definitions),
  `sandboxWatchResponse` (claim phases as SSE), `PushedCredentials` (the
  in-memory store of the credentials Studio pushes) and
  `pushedCredentialOptions` (the provider's mint hooks over that store).

## Usage

```ts
import {
  AgentSandboxProvider,
  kubeConfigForServer,
  migrateSandboxControllerSchema,
  postgresRunnerStateStore,
  postgresTenantPoolStore,
  PushedCredentials,
  pushedCredentialOptions,
  renderTenantPoolWarmPools,
  sandboxTools,
  sandboxWatchResponse,
  tenantPoolReader,
} from "@decocms/sandbox-controller";

// At boot, before any store serves a call. Each store opens its own pool.
await migrateSandboxControllerSchema({ url: databaseUrl });
const stateStore = postgresRunnerStateStore({ url: databaseUrl });
const poolStore = postgresTenantPoolStore({ url: databaseUrl });
// The host's admin surface writes pools and their repo allocations.
await poolStore.upsertPool("sandbox-cluster-1", {
  name: "acme",
  tenant: orgId,
  size: 4,
});
const acme = await poolStore.setRepos("sandbox-cluster-1", "acme", [
  { repoUrl: "https://github.com/acme/site", replicas: 2 },
]);
// The host applies these; the provider only binds and warms their pods.
const warmPools = renderTenantPoolWarmPools(acme!, {
  templateName: "studio-sandbox-prod",
});
const pools = tenantPoolReader(poolStore, "sandbox-cluster-1");
await pools.start();

// Memory only: a restart forgets it until Studio's next push.
const credentials = new PushedCredentials();

const provider = new AgentSandboxProvider({
  // The host's local proxy to the cluster; it authenticates on its own.
  kubeConfig: kubeConfigForServer("http://127.0.0.1:7777"),
  // Reach daemons the host's way instead of an apiserver port-forward.
  forwardPort: (pod, port) => openDaemonForward(pod, port),
  stateStore,
  // Warm-pool mode; tenant pools need it.
  sentinelToken,
  // Read on every ensure, push and reconcile tick: a synchronous snapshot.
  tenantPools: pools.current,
  // Mint hooks that read the store, and `persistCredentials: false`.
  ...pushedCredentialOptions(credentials),
});

// Wrap each definition in the host's tool type, behind the host's auth.
const tools = sandboxTools(() => provider, credentials);

// GET /api/sandbox/watch?handle=… behind the same auth.
const watch = (req: Request, handle: string) =>
  sandboxWatchResponse(provider, handle, req.signal);
```

## Architecture

```text
Studio ──MCP tools + SSE watch──▶ host (this library) ──▶ Kubernetes
Studio ──────── daemon and preview traffic ────────────▶ sandbox pod
```

The host answers where a sandbox's daemon is and which bearer opens it; Studio
dials the daemon itself (`daemonAddress: "service"` answers the in-cluster
Service URL). The control plane holds no cluster credential: its kube and
daemon calls are sandbox ops its cluster's data-plane agent runs
(`decocms/operator` `internal/agent/ops.go`).

### Tenant warm pools

A tenant pool is warm pod capacity reserved for one tenant: `size` pods, built
from the pool's `image`. The tenant is an opaque key; the provider compares it
with the claim's tenant key, which is the claiming user's org id. Repos are
optional allocations on top: each `{ repoUrl, branch, workload, replicas }`
takes `replicas` of the pool's pods and keeps them cloned, installed and
running that repo's dev server. The allocations' replicas add up to at most
`size`; the rest are blank warm pods, which clone on bind like the generic
pool's. `repoUrl` is a credential-free https clone URL, stored normalized:
lowercase host, no userinfo, no trailing `.git` or `/`.

The operator binds any warm pod of the `SandboxWarmPool` a claim names, and
the daemon refuses to move a cloned pod to another repo, so each allocation
is its own `SandboxWarmPool`. `renderTenantPoolWarmPools(pool, {
templateName })` returns one per allocation, named
`<pool>-<8 hex of repoUrl#branch>`, and a blank one named `<pool>` with the
remaining replicas, rendered even at 0 so a shrink is applied. All of them use
the `-medium` template of the pool's image, which is the template a bound claim
names. The host applies and deletes these objects; the library never writes
them.

A claim binds, in order: an allocation in its tenant's pools for the claim's
repo, on the claim's branch if one is, else any branch; its tenant's blank
pods; the generic pool. Only a pool whose image is the claim's image
qualifies, and a pool with no blank replicas is skipped. The reconciler warms
allocation pods only, with per-pod refresh and failure backoff; a blank pod is
configured by the claim that binds it. The provider takes the pools as
`tenantPools`, a list or a function, and reads a function on every use, so a
change takes effect on the next ensure and reconcile tick, without a restart.
The reconciler forgets a removed allocation's pods and zeroes its depth gauge.
`markTenantPoolsDirty(repoUrl, ref)` refreshes the allocations on that repo
and branch on the next tick.

### Credentials

The host never calls Studio. Credentials only Studio can mint (clone tokens,
org-fs API keys) reach it two ways: each `SANDBOX_ENSURE` carries them, with
how long they stay valid, and every 10 minutes Studio calls `SANDBOX_LIST`
(tenants and repos, and each pool's name, tenant, image and repo allocations,
with no credentials) and then `SANDBOX_CREDENTIALS_PUSH`. Studio treats the
listing as untrusted: it mints for a tenant only while the user is a member of
the org, and for a repo only while its connection or repository belongs to
that org. For a pool repo it mints only from its own repository record in the
org named by the pool's tenant whose clone URL matches the listed one, and
pushes nothing without one. Pool credentials arrive as `poolCloneUrls`, keyed
by tenant and repo URL, and `pushedCredentialOptions` hands them to the
allocations' pods. `STUDIO_SANDBOX_TENANT_POOLS` configures pools only for
Studio's in-process provider; with a control plane, Studio ignores it.
The store keeps each entry's expiry, never replaces a longer-lived entry with
a shorter one, and answers a re-mint with nothing when an entry has less life
left than the runner asks for. With `persistCredentials: false` the persisted
state keeps no clone token, submodule token or org-fs config; recovery takes
them from the store. After a host restart, a sandbox recovered before the next
push has no credential until that push, at most 10 minutes later.

### Storage

The state store keeps one row per sandbox in `sandbox_controller.runner_state`,
with the same semantics as Studio's in-process store. `withLock` serializes
provisioning of one sandbox across replicas with a transaction-scoped
advisory lock keyed by user and project ref; a caller that waits longer than
90 seconds (`lockWaitMs`) gets a retryable "sandbox advisory lock busy" error.
Each lock holder keeps a connection for the whole provisioning, so the store
opens its own pool of `maxConnections` (default 4) instead of sharing the
host's; `close()` ends it. The host runs `migrateSandboxControllerSchema` at boot;
the store never migrates on its own. Migrating is idempotent and holds an
advisory lock, so every replica can run it at once. Applied versions are
recorded in `sandbox_controller.migrations`. `state` embeds short-lived
credentials; never log it.

The pool store keeps one row per pool in `sandbox_controller.tenant_pools`,
unique by cluster and name, so one database can serve several sandbox
clusters, and one row per allocation in `sandbox_controller.tenant_pool_repos`,
unique by pool, repo URL and branch and deleted with its pool.
`upsertPool(cluster, pool)` validates with `tenantPoolFieldsSchema` and creates
or updates the pool of that name, leaving its repos as they are, but throws
`TenantPoolConflictError` when the name belongs to another tenant: its warm pods
hold that tenant's checkouts. `setRepos(cluster, name, repos)` validates with
`tenantPoolRepoSchema` and replaces all of a pool's allocations in one
transaction, answering null when there is no such pool. Both lock the pool row
and throw `TenantPoolCapacityError` rather than let the allocations exceed the
size. `deletePool` answers whether a pool was removed; `list(cluster)` returns
the cluster's pools with their repos. `tenantPoolReader(store, cluster)` loads the cluster's pools on
`start()`, on `refresh()` and every `refreshMs` (default 30 seconds);
`current()` answers the last loaded list synchronously. A failed load keeps
the last list, and a load that finishes after a newer one is dropped. A write
from another replica reaches a reader on its next tick; the writer's own
process can call `refresh()` right away.

### Watch

The watch route writes an SSE keepalive comment every
`SANDBOX_WATCH_KEEPALIVE_MS`. Studio reads the watch as the host's sign of
life: it reconnects a dropped stream, and gives up on a provisioning call only
after the host has been silent for four keepalives.

## Development

```bash
bun run --cwd=packages/sandbox-controller build   # dist/index.js + index.d.ts
bun run --cwd=packages/sandbox-controller pack    # dist/sandbox-controller.tgz
bun test packages/sandbox/server/provider/remote.test.ts
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
  bun test packages/sandbox/server/provider/postgres-state-store.integration.test.ts
```

A local host can depend on the packed tarball with
`bun add @decocms/sandbox-controller@file:<path>/dist/sandbox-controller.tgz`.

## Boundaries

- The host owns authorization: the tools carry no auth of their own.
- With the default `daemonAddress: "forward"`, the daemon address is the
  host's own `127.0.0.1` forward, reachable only from the same machine.
- The sources live in `packages/sandbox`; change them there. A change to a
  bundled source bumps this package's version on release, which publishes it.
- `zod`, `@opentelemetry/api` and `postgres` are peer dependencies: the
  host's `zod` parses the exported schemas, the provider's meter options are
  `@opentelemetry/api` types, and the state store runs on the host's
  `postgres`.

## Related documentation

- [`packages/sandbox`](../sandbox/README.md)
- [`apps/api`](../../apps/api/README.md)
