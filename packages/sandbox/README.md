# @decocms/sandbox

Runs Studio coding workloads through an isolated daemon with provider-neutral
lifecycle, filesystem, dispatch, and proxy contracts.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/sandbox` (`packages/sandbox`) |
| Kind | Private sandbox control-plane and daemon package |
| Runtime | Bun daemon; Node.js/Bun host providers |
| Distribution | Private workspace package; bundled daemon and container image |

## Overview

`@decocms/sandbox` owns the boundary between Studio and an execution environment
used by coding agents. A sandbox contains a project checkout and a Bun daemon that
performs filesystem, Git, process, dispatch, and preview-proxy operations.

Studio addresses a sandbox by logical identity and talks to it through the
`SandboxProvider` contract. Provider-specific transport and lifecycle behavior stay
behind that contract, so API code does not depend on Kubernetes or desktop-link
details.

Hosted agent sandboxes share one workspace for each project reference, while a
linked desktop keeps one workspace for each user and project reference. The
identity scope is explicit in `SandboxId`, so callers cannot accidentally include
an acting user in a shared hosted identity.

## Responsibilities

- Define stable shared and user-scoped sandbox identities, provider kinds,
  references, and lifecycle contracts.
- Provision or attach to isolated execution environments.
- Build and run the authenticated Bun daemon inside each environment.
- Expose asynchronous filesystem, Git, task, terminal, and preview operations.
- Carry agent dispatch streams between Studio, the daemon, and a harness.
- Proxy HTTP and WebSocket traffic to development servers inside a sandbox.
- Support organization filesystem mounts and cleanup.
- Version the desktop-link transport and reject incompatible peers.

## Usage

Resolve the configured provider kind from Studio server code:

```ts
import { resolveSandboxProviderKindFromEnv } from "@decocms/sandbox/provider";

const providerKind = resolveSandboxProviderKindFromEnv();
```

`STUDIO_SANDBOX_PROVIDER` accepts `user-desktop` or `agent-sandbox`. The legacy
value `cluster` is normalized to `agent-sandbox`. When the variable is absent, the
resolver defaults to `user-desktop`, which requires a compatible linked desktop
daemon.

Code that works with a provider should depend on its interface:

```ts
import type {
  SandboxId,
  SandboxProvider,
} from "@decocms/sandbox/provider";

export async function ensureSandbox(
  provider: SandboxProvider,
  id: SandboxId,
) {
  return provider.ensure(id);
}
```

Construct the identity that matches the selected provider:

```ts
import {
  sharedSandboxId,
  userSandboxId,
} from "@decocms/sandbox/provider";

const hostedId = sharedSandboxId(projectRef);
const desktopId = userSandboxId(userId, projectRef);
```

Dispatch producers and consumers share schemas from the package instead of
redeclaring wire objects:

```ts
import { harnessStreamInputSchema } from "@decocms/sandbox/dispatch";

const input = harnessStreamInputSchema.parse(untrustedInput);
```

## Architecture

The package has four major layers:

1. **Provider layer** — `SandboxProvider` defines lifecycle and proxy operations.
   The `agent-sandbox` implementation uses the Kubernetes agent-sandbox operator;
   the `desktop` implementation reaches a user-linked daemon through NATS.
2. **Daemon layer** — a Bun HTTP server runs inside the sandbox on port `9000`.
   Authenticated routes perform project, process, Git, filesystem, and dispatch
   work.
3. **Dispatch layer** — versioned Zod schemas and relay helpers carry harness input,
   output, control frames, and task state.
4. **Proxy and filesystem layer** — HTTP/WebSocket helpers expose development
   servers, while organization filesystem helpers manage mounted Studio content.

A logical sandbox uses a discriminated `SandboxId`. Hosted agent sandboxes use a
shared identity containing only `projectRef`; linked desktops use a user-scoped
identity containing both `userId` and `projectRef`. Providers map that identity to
a deterministic, DNS-safe handle. The handle and preview URL are bearer-like links
for the preview surface in current providers; daemon control requests still
require separate authentication.

The normal request path is:

```text
Studio API -> SandboxProvider -> authenticated daemon -> process/filesystem/harness
```

For a linked desktop, the middle transport crosses NATS. For `agent-sandbox`, the
provider resolves the Kubernetes workload and its routed daemon URL.

## Development

Run package checks from the repository root:

```bash
bun run --cwd=packages/sandbox check
bun run --cwd=packages/sandbox test
```

Build the daemon and package the type generator used inside sandbox images:

```bash
bun run --cwd=packages/sandbox build
```

Run the daemon in watch mode:

```bash
bun run --cwd=packages/sandbox dev:daemon
```

Run focused daemon or dispatch tests while iterating:

```bash
bun test packages/sandbox/daemon
bun test packages/sandbox/dispatch
```

Format and lint repository changes before committing:

```bash
bun run fmt
bun run lint
```

## Boundaries

- All Studio callers depend on `SandboxProvider`; provider-specific clients and
  transports must not leak into business logic.
- Use `sharedSandboxId()` for hosted agent sandboxes and `userSandboxId()` for
  linked desktops. Do not add the acting user to a shared hosted identity.
- The daemon runs on one Bun event loop. Never use synchronous filesystem or
  crypto APIs, blocking child processes, large unchunked serialization, or
  unbounded CPU work in `packages/sandbox/daemon`.
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
- Daemon wire changes must remain compatible with the supported desktop-link
  protocol or ship with a protocol-version change and an upgrade path.

## Provider selection

| Provider | Use case | Transport |
| --- | --- | --- |
| `user-desktop` | Local development and linked user machines | Versioned NATS desktop-link protocol |
| `agent-sandbox` | Isolated Kubernetes workloads | Agent-sandbox operator and routed daemon HTTP/WebSocket |

Production deployments must set `STUDIO_SANDBOX_PROVIDER` explicitly. Use
`agent-sandbox` for the Kubernetes topology. The old `host` and `local-docker`
provider modes are not supported.

## Shared hosted sessions

The Studio API keeps agent-sandbox lifecycle state in an organization-scoped
session registry keyed by organization, virtual MCP, and branch. Authorized
collaborators on the same branch join the same lifecycle generation and
`SandboxClaim`; linked desktops remain user-scoped.

Shared-session transitions use generation fences so a stale provisioning or
teardown completion cannot overwrite a newer start. Keep provider operations
outside the short database lifecycle lock to avoid lock-ordering and connection
pool hazards.

Upgrading does not migrate an already-running, per-user hosted workspace. Commit
any work in those claims and drain them before deploying the shared-session
behavior.

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
branch slug). The hash is derived from `projectRef` for shared hosted sandboxes
and from `userId:projectRef` for linked desktops.

Daemon control endpoints use the `/_sandbox/*` namespace, with `/health` at the
root. Providers decide how those routes travel; they are separate from the public
preview contract.

## Export surface

| Import | Purpose |
| --- | --- |
| `@decocms/sandbox/shared` | Constants, daemon event types, shell quoting, Git identity, and shared helpers |
| `@decocms/sandbox/provider` | Provider contracts, provider-kind resolution, sandbox references, and filesystem hooks |
| `@decocms/sandbox/provider/agent-sandbox` | Kubernetes agent-sandbox provider implementation |
| `@decocms/sandbox/provider/desktop` | Linked-desktop provider implementation |
| `@decocms/sandbox/daemon-spawn` | Host-side daemon process spawning |
| `@decocms/sandbox/daemon-client` | Authenticated daemon HTTP client |
| `@decocms/sandbox/daemon/routes/dispatch` | Daemon dispatch route integration |
| `@decocms/sandbox/org-fs` | Organization filesystem client and contracts |
| `@decocms/sandbox/org-fs/detach-mount` | Daemon-side mount detachment |
| `@decocms/sandbox/dispatch` | Dispatch schemas, relay, versioning, and fixtures namespace |
| `@decocms/sandbox/dispatch/*` | Individual dispatch modules |
| `@decocms/sandbox/proxy/http` | HTTP preview proxy primitives |
| `@decocms/sandbox/proxy/websocket` | WebSocket preview proxy primitives |

These are the supported entry points. Do not import package internals by filesystem
path.

## Desktop-link protocol compatibility

The current link protocol is version `3`, and version `3` is the minimum supported
version. Requests carry the version in the `x-link-protocol` header. A peer below
the minimum is rejected with an actionable upgrade message.

Any breaking dispatch schema or transport change requires a protocol-version bump.
Maintain backward compatibility when practical; otherwise update both ends and
the minimum supported version together. Users update an incompatible link with:

```bash
bunx decocms@latest link
```

## Related documentation

- [Run attachment and dispatch lifecycle](./run-attachment.md)
- [Sandbox image skills and features](./image/skills-features.md)
- [Repository guidelines](../../AGENTS.md)
- [Testing strategy](../../TESTING.md)
