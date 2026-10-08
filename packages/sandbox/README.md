# @decocms/sandbox

Runs Studio coding workloads through AgentSandbox with lifecycle, filesystem,
dispatch, and proxy contracts.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/sandbox` (`packages/sandbox`) |
| Kind | Private sandbox control-plane and daemon package |
| Runtime | Go daemon (`daemon-go/`); Bun host-side provider |
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

- Define stable sandbox identities, references, and lifecycle
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
the package exposes the concrete AgentSandbox implementation and its shared
identity types.

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

1. **Provider layer** — `AgentSandboxProvider` owns lifecycle and proxy
   operations through the Kubernetes agent-sandbox operator.
2. **Daemon layer** — the Go daemon (`daemon-go/`) serves HTTP inside the sandbox
   on port `9000`. Authenticated routes perform project, process, Git,
   filesystem, and dispatch work.
3. **Dispatch contracts** — Zod schemas validate inline harness input and streamed
   output frames.
4. **Proxy and filesystem layer** — HTTP/WebSocket helpers expose development
   servers, while organization filesystem helpers manage mounted Studio content.

A logical sandbox is identified by `SandboxId`, which pairs a `userId` with an
opaque `projectRef`. AgentSandbox maps that identity to a deterministic, DNS-safe
handle. The handle and preview URL are bearer-like links
for the preview surface; daemon control requests still
require separate authentication.

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

- Studio callers use `AgentSandboxProvider`; Kubernetes clients and transport
  details must not leak into business logic.
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
- Side-effecting work must not be retried unless the operation is idempotent or
  protected by a claim/fence.

## Hosted provisioning

Production deployments enable AgentSandbox with
`STUDIO_AGENT_SANDBOX_ENABLED=true`. Hosted provisioning is disabled when the
flag is absent or false. Native Studio uses `local-api` as its persisted
runtime ownership marker and handles lifecycle locally.

Hosted routes run `AgentSandboxProvider` in-process by default. With
`STUDIO_SANDBOX_CONTROL_PLANE_URL` and `STUDIO_SANDBOX_CONTROL_PLANE_TOKEN`
set, they use `RemoteSandboxProvider` instead: the control plane runs the same
provider (published as `@decocms/sandbox-controller`) and serves the contract
in `server/provider/sandbox-api.ts`. Both satisfy `SandboxProvider`.

With `FREESTYLE_API_KEY` set, Studio also runs `FreestyleSandboxProvider`:
each sandbox is a [Freestyle](https://freestyle.sh) VM running the same image
under Docker, with the daemon published at `https://<handle>.style.dev`. The
VM's slug is the handle and its metadata holds the daemon bearer, so it needs
no state store. An idle VM is paused, and traffic resumes it; a VM paused for
three days is deleted, or sooner if the Freestyle plan caps it lower. The first
ensure for an image builds a base snapshot with the image pulled;
`STUDIO_SANDBOX_FREESTYLE_IMAGE` overrides the default image, which is the
release of this package's version. Org-fs runs there too, with the sidecar
as a second container in the VM; see [`orgfs/README.md`](orgfs/README.md).

`SandboxProviderRouter` sits in front of both. `SANDBOX_START`'s `provider`
input picks where a new sandbox runs, when that provider is configured and
serves the requested image. Without it, `STUDIO_SANDBOX_FREESTYLE_SHARE`
(0 to 1, default 0) of new sandboxes go to Freestyle, split by a hash of the
handle so a retry lands where the first try did; the rest run on Kubernetes
while it has capacity. Orgs with a tenant warm pool stay on Kubernetes. An
existing sandbox stays with its provider; Kubernetes is asked first, so a
Freestyle outage never touches Kubernetes sandboxes. When the chosen provider's
ensure fails, the other one gets a try, except on a daemon config error or an
image only Kubernetes runs. A resumed sandbox that moves this way has its old
copy deleted. Handle-only calls go to the provider that owns the handle:
Freestyle answers ownership by VM lookup, and every other handle is
Kubernetes'. If the Kubernetes provider cannot be
built, Studio runs Freestyle alone. A control plane can host the router
instead: the sandbox API carries `provider` on ensure, status and errors, and
`placement` (why the router chose it) on ensure.

Two histograms compare the providers, both split by `runner_kind`
(`agent-sandbox` or `freestyle`): `studio.sandbox.provision.duration_ms`
(each ensure, by `outcome`, `start=fresh|resume`, and `fallback_from` after a
fallback) and `studio.sandbox.proxy.duration_ms` (`source=daemon` requests,
by `status_code`). The counter `studio.sandbox.placement` counts ensures by
`reason`: `existing`, `requested`, `split`, `capacity`, `fallback`, `image`,
`warm-pool`, or `freestyle-unavailable`.

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
root. AgentSandbox forwards those routes separately from the public preview
contract.

For v8 (Blocks) sites the daemon also serves the Deco content protocol over the
working tree, so the site editor edits a sandbox the way it edits a local
`deco serve`: `POST /_sandbox/rpc` (JSON-RPC: `describe`, `schema.get`,
`blocks.list`, `blocks.apply`) and `PUT /_sandbox/assets/<name>` (uploads into
`public/assets`). Both need the daemon token. Content lives in
`<app root>/.deco/blocks/*.json` and is committed and pushed like code; there is
no CDN draft in a sandbox. Commits take the worktree lock, so they serialize
with fs writes, publish, discard and autosave. The `.deco/.blocks.lock` and
`.deco/.tx-*/` files they use are listed in `.git/info/exclude`. The
implementation is a Go port of `@decocms/blocks/protocol`, and
`daemon-e2e/daemon.content-protocol.e2e.test.ts` runs the published conformance
suite and a byte-for-byte parity check against it. Bump the pinned
`@decocms/blocks` there when the protocol changes. `/_sandbox/decofile` (v7) is
unchanged and reflects protocol writes.

## Export surface

| Import | Purpose |
| --- | --- |
| `@decocms/sandbox/shared` | Constants, daemon event types, shell quoting, Git identity, and shared helpers |
| `@decocms/sandbox/provider` | Sandbox contracts, references, and filesystem hooks |
| `@decocms/sandbox/provider/agent-sandbox` | Kubernetes agent-sandbox provider implementation |
| `@decocms/sandbox/provider/freestyle` | Freestyle VM provider implementation |
| `@decocms/sandbox/provider/router` | Routes one `SandboxProvider` surface across providers |
| `@decocms/sandbox/daemon-client` | Authenticated daemon HTTP client |
| `@decocms/sandbox/org-fs` | Organization filesystem client and contracts |
| `@decocms/sandbox/dispatch` | Harness run schemas and fixtures namespace |
| `@decocms/sandbox/dispatch/*` | Schemas and error codes |
| `@decocms/sandbox/proxy/http` | HTTP preview proxy primitives |
| `@decocms/sandbox/proxy/websocket` | WebSocket preview proxy primitives |

These are the supported entry points. Do not import package internals by filesystem
path.

## Layout

| Path | What it is |
| --- | --- |
| `daemon-go/` | The sandbox daemon (Go). Runs as PID 1 inside every sandbox pod. |
| `daemon-e2e/` | Black-box HTTP/SSE conformance suite for whatever binary `DAEMON_E2E_CMD` names; defaults to `daemon-go/bin/daemon`. |
| `server/` | The host-side AgentSandbox implementation and authenticated daemon client. |
| `dispatch/` | Harness run schemas, error codes, and fixtures. |
| `orgfs/` | Org-filesystem client, WebDAV handler, and the privileged mounter sidecar image entrypoint. |
| `proxy/` | HTTP/WebSocket preview-proxy primitives used by Studio. |
| `image/` | Sandbox container image (Dockerfile + bundled skills). |
| `daemon-protocol.ts` | TypeScript view of the daemon's config wire contract. |

## Related documentation

- [Run attachment and dispatch lifecycle](./run-attachment.md)
- [Sandbox image skills and features](./image/skills-features.md)
- [Repository guidelines](../../AGENTS.md)
- [Testing strategy](../../TESTING.md)
