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
- Export `postgresRunnerStateStore`, a Postgres `RunnerStateStore` in the
  library's own `sandbox_controller` schema, and `migrateRunnerStateStore`,
  which creates and upgrades that schema.
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
  migrateRunnerStateStore,
  postgresRunnerStateStore,
  PushedCredentials,
  pushedCredentialOptions,
  sandboxTools,
  sandboxWatchResponse,
} from "@decocms/sandbox-controller";

// At boot, before the store serves a call. The store opens its own pool.
await migrateRunnerStateStore({ url: databaseUrl });
const stateStore = postgresRunnerStateStore({ url: databaseUrl });

// Memory only: a restart forgets it until Studio's next push.
const credentials = new PushedCredentials();

const provider = new AgentSandboxProvider({
  // The host's local proxy to the cluster; it authenticates on its own.
  kubeConfig: kubeConfigForServer("http://127.0.0.1:7777"),
  // Reach daemons the host's way instead of an apiserver port-forward.
  forwardPort: (pod, port) => openDaemonForward(pod, port),
  stateStore,
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

The host never calls Studio. Credentials only Studio can mint (clone tokens,
org-fs API keys) reach it two ways: each `SANDBOX_ENSURE` carries them, with
how long they stay valid, and every 10 minutes Studio calls `SANDBOX_LIST`
(tenants and repos, no credentials) and then `SANDBOX_CREDENTIALS_PUSH`.
Studio mints only for tenants and credentials its own records authorize, plus
its `STUDIO_SANDBOX_TENANT_POOLS`, so those must list the pools the host runs.
The store keeps each entry's expiry, never replaces a longer-lived entry with
a shorter one, and answers a re-mint with nothing when an entry has less life
left than the runner asks for. With `persistCredentials: false` the persisted
state keeps no clone token, submodule token or org-fs config; recovery takes
them from the store. After a host restart, a sandbox recovered before the next
push has no credential until that push, at most 10 minutes later.

The state store keeps one row per sandbox in `sandbox_controller.runner_state`,
with the same semantics as Studio's in-process store. `withLock` serializes
provisioning of one sandbox across replicas with a transaction-scoped
advisory lock keyed by user and project ref; a caller that waits longer than
90 seconds (`lockWaitMs`) gets a retryable "sandbox advisory lock busy" error.
Each lock holder keeps a connection for the whole provisioning, so the store
opens its own pool of `maxConnections` (default 4) instead of sharing the
host's; `close()` ends it. The host runs `migrateRunnerStateStore` at boot;
the store never migrates on its own. Migrating is idempotent and holds an
advisory lock, so every replica can run it at once. Applied versions are
recorded in `sandbox_controller.migrations`. `state` embeds short-lived
credentials; never log it.

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
