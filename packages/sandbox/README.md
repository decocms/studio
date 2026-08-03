# @decocms/sandbox

Runs Studio coding workloads through AgentSandbox with lifecycle, filesystem,
dispatch, and proxy contracts.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/sandbox` (`packages/sandbox`) |
| Kind | Private sandbox control-plane and daemon package |
| Runtime | Go daemon (`daemon-go/`); Bun host-side providers |
| Distribution | Private workspace package; container image with the daemon binary |

## Overview

`@decocms/sandbox` owns the boundary between Studio and an execution environment
used by coding agents. A sandbox contains a project checkout and a **Go daemon**
(`daemon-go/`, one static binary, PID 1 of the pod) that performs filesystem, Git,
process, dispatch, and preview-proxy operations. It is the only daemon
implementation; the TypeScript one it replaced is deleted, and its black-box
contract now lives in `daemon-e2e/`.

Studio addresses a sandbox by logical identity and talks to it through the one
`AgentSandboxProvider`. Kubernetes transport and lifecycle behavior stay inside
that class.

A sandbox is isolated per user and project reference, so one user's workspace
never becomes another user's execution context.

## Responsibilities

- Define stable sandbox identities, provider kinds, references, and lifecycle
  contracts.
- Provision or attach to isolated execution environments.
- Build and run the authenticated Go daemon inside each environment.
- Expose asynchronous filesystem, Git, task, terminal, and preview operations.
- Carry agent dispatch streams between Studio, the daemon, and a harness.
- Proxy HTTP and WebSocket traffic to development servers inside a sandbox.
- Support organization filesystem mounts and cleanup (the privileged mounter
  sidecar in `orgfs/` is the one piece of in-sandbox TypeScript left).

## Usage

Studio enables hosted sandbox infrastructure with
`STUDIO_AGENT_SANDBOX_ENABLED=true`. The API owns that deployment capability;
the provider package only defines sandbox contracts and implementations.
`user-desktop` survives only as a persisted provider kind on old rows.
During the rolling compatibility window, deployments also set
`STUDIO_SANDBOX_PROVIDER=agent-sandbox` so an older API image remains
rollback-compatible.

Code that works with the hosted provider names it directly:

```ts
import type { SandboxId } from "@decocms/sandbox/provider";
import type { AgentSandboxProvider } from "@decocms/sandbox/provider/agent-sandbox";

export async function ensureSandbox(
  provider: AgentSandboxProvider,
  id: SandboxId,
) {
  return provider.ensure(id);
}
```

Dispatch producers and consumers share schemas from the package instead of
redeclaring wire objects:

```ts
import { harnessStreamInputSchema } from "@decocms/sandbox/dispatch";

const input = harnessStreamInputSchema.parse(untrustedInput);
```

## Architecture

The package has four major layers:

1. **Provider layer** — `AgentSandboxProvider` owns lifecycle and proxy operations
   through the Kubernetes agent-sandbox operator.
2. **Daemon layer** — the Go daemon (`daemon-go/`) serves HTTP inside the sandbox
   on port `9000`. Authenticated routes perform project, process, Git,
   filesystem, and dispatch work.
3. **Dispatch layer** — versioned Zod schemas and relay helpers carry harness input,
   output, control frames, and task state.
4. **Proxy and filesystem layer** — HTTP/WebSocket helpers expose development
   servers, while organization filesystem helpers manage mounted Studio content.

A logical sandbox is identified by `SandboxId`, which pairs a `userId` with an
opaque `projectRef`. AgentSandbox maps that identity to a deterministic,
DNS-safe handle. The handle and preview URL are bearer-like links for the
preview surface; daemon control requests still require separate authentication.

The normal request path is:

```text
Studio API -> AgentSandboxProvider -> authenticated daemon -> process/filesystem/harness
```

For `agent-sandbox`, the provider resolves the Kubernetes workload and its routed
daemon URL.

## Development

Run package checks from the repository root:

```bash
bun run --cwd=packages/sandbox check
bun run --cwd=packages/sandbox test
```

Package the type generator baked into sandbox images:

```bash
bun run --cwd=packages/sandbox build
```

Build, vet and unit-test the daemon:

```bash
cd packages/sandbox/daemon-go
go build -o bin/daemon .
go vet ./... && go test -race ./...
```

Run the black-box daemon conformance suite against that binary (its default
target — point `DAEMON_E2E_CMD` at any other implementation to run the same
assertions against it):

```bash
bun test packages/sandbox/daemon-e2e/daemon*.e2e.test.ts
```

Run focused host-side tests while iterating:

```bash
bun test packages/sandbox/dispatch
bun test packages/sandbox/orgfs
```

Format and lint repository changes before committing:

```bash
bun run fmt
bun run lint
```

## Boundaries

- Studio callers name `AgentSandboxProvider`; its Kubernetes clients and
  transport internals must not leak into business logic.
- Daemon code is Go and lives in `daemon-go/`. Do not add a second daemon
  implementation, and do not reach into `daemon-go/` from TypeScript — the
  contract between them is HTTP, asserted in `daemon-e2e/`.
- Studio's health probe kills a sandbox on a single missed response, so nothing
  on the daemon's probe path may block behind slow I/O or a held lock.
- Mutating and control-plane daemon routes require the daemon bearer token.
  Health and selected read-only status/stream routes are deliberately
  unauthenticated; keep that exception narrow and never place secrets in their
  responses.
- A sandbox handle may guard a public preview URL, but it never authorizes daemon
  control requests. Treat preview URLs as sensitive links and daemon tokens as
  credentials.
- Treat every dispatch frame, route parameter, filesystem path, and proxy target
  as untrusted input. Parse protocol objects with the exported schemas and keep
  path containment checks at filesystem boundaries.
- Offloaded fetch destinations must match the allowlist derived from trusted
  server configuration. An empty or invalid allowlist fails closed.
- NATS Core provides transport, not durable delivery. Dispatch state, retry
  behavior, deduplication, and cancellation must remain explicit.
- Side-effecting work must not be retried unless the operation is idempotent or
  protected by a claim/fence.

## Provider selection

| Provider | Use case | Transport |
| --- | --- | --- |
| `agent-sandbox` | Isolated Kubernetes workloads | Agent-sandbox operator and routed daemon HTTP/WebSocket |

Production deployments with hosted sandboxes must set
`STUDIO_AGENT_SANDBOX_ENABLED=true` (plus the temporary rollback alias above).
The old `host`, `local-docker` and `user-desktop` provider modes are not
supported by the hosted API.

## Routing and preview traffic

The daemon listens on port `9000`. A production `agent-sandbox` deployment may
set `STUDIO_SANDBOX_PREVIEW_URL_PATTERN`, for example
`https://{handle}.preview.example.com`. The preview gateway resolves that handle
to a live claim, and the daemon forwards ordinary HTTP and WebSocket traffic to
the configured development-server port.

Studio may also proxy arbitrary supported preview ports through its
organization-scoped sandbox routes. The proxy rewrites development WebSocket URLs
so HMR remains on the authenticated Studio route instead of exposing an
unreachable container-local address.

Handles have the shape `<branch-slug>-<hash>` (or `s-<hash>` without a usable
branch slug), where the hash is derived from `userId:projectRef`.

Daemon control endpoints use the `/_sandbox/*` namespace, with `/health` at the
root. Providers decide how those routes travel; they are separate from the public
preview contract.

## Export surface

| Import | Purpose |
| --- | --- |
| `@decocms/sandbox/shared` | Constants, daemon event types, shell quoting, Git identity, and shared helpers |
| `@decocms/sandbox/provider` | Provider contracts, provider-kind resolution, sandbox references, and filesystem hooks |
| `@decocms/sandbox/provider/agent-sandbox` | Kubernetes agent-sandbox provider implementation |
| `@decocms/sandbox/daemon-client` | Authenticated daemon HTTP client |
| `@decocms/sandbox/org-fs` | Organization filesystem client and contracts |
| `@decocms/sandbox/dispatch` | Dispatch schemas, relay, versioning, and fixtures namespace |
| `@decocms/sandbox/dispatch/*` | Individual dispatch modules |
| `@decocms/sandbox/proxy/http` | HTTP preview proxy primitives |
| `@decocms/sandbox/proxy/websocket` | WebSocket preview proxy primitives |

These are the supported entry points. Do not import package internals by filesystem
path.

## Layout

| Path | What it is |
| --- | --- |
| `daemon-go/` | The sandbox daemon (Go). Runs as PID 1 inside every sandbox pod. |
| `daemon-e2e/` | Black-box HTTP/SSE conformance suite for whatever binary `DAEMON_E2E_CMD` names; defaults to `daemon-go/bin/daemon`. |
| `server/` | Host-side providers and the authenticated daemon client. |
| `dispatch/` | Versioned dispatch schemas and NATS relay helpers shared by both ends. |
| `orgfs/` | Org-filesystem client, WebDAV handler, and the privileged mounter sidecar image entrypoint. |
| `proxy/` | HTTP/WebSocket preview-proxy primitives used by Studio. |
| `image/` | Sandbox container image (Dockerfile + bundled skills). |
| `daemon-protocol.ts` | TypeScript view of the daemon's config wire contract. |

## Related documentation

- [Run attachment and dispatch lifecycle](./run-attachment.md)
- [Sandbox image skills and features](./image/skills-features.md)
- [Repository guidelines](../../AGENTS.md)
- [Testing strategy](../../TESTING.md)
