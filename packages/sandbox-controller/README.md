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
  PushedCredentials,
  pushedCredentialOptions,
  sandboxTools,
  sandboxWatchResponse,
} from "@decocms/sandbox-controller";

// Memory only: a restart forgets it until Studio's next push.
const credentials = new PushedCredentials();

const provider = new AgentSandboxProvider({
  // The host's local proxy to the cluster; it authenticates on its own.
  kubeConfig: kubeConfigForServer("http://127.0.0.1:7777"),
  // Reach daemons the host's way instead of an apiserver port-forward.
  forwardPort: (pod, port) => openDaemonForward(pod, port),
  stateStore, // the host's RunnerStateStore
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

The watch route writes an SSE keepalive comment every
`SANDBOX_WATCH_KEEPALIVE_MS`. Studio reads the watch as the host's sign of
life: it reconnects a dropped stream, and gives up on a provisioning call only
after the host has been silent for four keepalives.

## Development

```bash
bun run --cwd=packages/sandbox-controller build   # dist/index.js + index.d.ts
bun run --cwd=packages/sandbox-controller pack    # dist/sandbox-controller.tgz
bun test packages/sandbox/server/provider/remote.test.ts
```

A local host can depend on the packed tarball with
`bun add @decocms/sandbox-controller@file:<path>/dist/sandbox-controller.tgz`.

## Boundaries

- The host owns authorization: the tools carry no auth of their own.
- With the default `daemonAddress: "forward"`, the daemon address is the
  host's own `127.0.0.1` forward, reachable only from the same machine.
- The sources live in `packages/sandbox`; change them there. A change to a
  bundled source bumps this package's version on release, which publishes it.
- `zod` and `@opentelemetry/api` are peer dependencies: the host's `zod`
  parses the exported schemas, and the provider's meter options are
  `@opentelemetry/api` types.

## Related documentation

- [`packages/sandbox`](../sandbox/README.md)
- [`apps/api`](../../apps/api/README.md)
