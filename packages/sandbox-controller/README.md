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
  `loadKubeConfig`, which builds a kubeconfig with the package's own client.
- Export the wire contract in `sandbox-api`: tool names and schemas, the watch
  route, and the credential callbacks into Studio.
- Export host helpers: `sandboxTools` (framework-free tool definitions),
  `sandboxWatchResponse` (claim phases as SSE), and `studioCredentialMinters`
  (re-mint clone URLs and org-fs configs through Studio).

## Usage

```ts
import {
  AgentSandboxProvider,
  loadKubeConfig,
  sandboxTools,
  sandboxWatchResponse,
  studioCredentialMinters,
} from "@decocms/sandbox-controller";

const provider = new AgentSandboxProvider({
  kubeConfig: loadKubeConfig({ path: "/etc/sandbox/kubeconfig" }),
  stateStore, // the host's RunnerStateStore
  ...studioCredentialMinters({ studioUrl, token }),
});

// Wrap each definition in the host's tool type, behind the host's auth.
const tools = sandboxTools(() => provider);

// GET /api/sandbox/watch?handle=… behind the same auth.
const watch = (req: Request, handle: string) =>
  sandboxWatchResponse(provider, handle, req.signal);
```

## Architecture

```text
Studio ──MCP tools + SSE watch──▶ host (this library) ──▶ Kubernetes
   ▲                                  │
   └──── credential callbacks ────────┘
Studio ──────── daemon and preview traffic ────────────▶ sandbox pod
```

The host answers where a sandbox's daemon is and which bearer opens it; Studio
dials the daemon itself. The same bearer authenticates both directions: Studio
to the host's tools and watch route, and the host to Studio's
`/api/sandbox-callbacks/*`. Studio still checks each callback's tenant against
its own records before minting.

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
- The daemon address a local host returns is its own `127.0.0.1`
  port-forward, reachable only from the same machine.
- The sources live in `packages/sandbox`; change them there.

## Related documentation

- [`packages/sandbox`](../sandbox/README.md)
- [`apps/api`](../../apps/api/README.md)
