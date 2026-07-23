# @decocms/sandbox

Isolated sandboxes for MCP tool execution.

Hosted agent sandboxes use one workspace per `projectRef`; user-desktop keeps
one workspace per `(userId, projectRef)`. A sandbox is a container (or VM)
holding a checked-out repo plus an in-pod daemon that proxies exec, file ops,
and the dev server.
Callers go through a single `SandboxProvider` interface; the provider decides how
the sandbox is provisioned and reached.

## Providers

Two provider backends live behind the common `SandboxProvider` interface
(`server/provider/types.ts`):

- **agent-sandbox** (`./provider/agent-sandbox`) — one `SandboxClaim` per sandbox
  against the [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
  operator. Studio talks to pods via apiserver port-forward in dev; in prod,
  `previewUrlPattern` switches the preview URL to real ingress and skips the
  dev forward. Selected with `STUDIO_SANDBOX_PROVIDER=agent-sandbox`.
- **user-desktop** (`./provider/desktop`) — forwards every `SandboxProvider` call to
  the acting user's local `deco link` daemon over NATS. Constructed per-run from
  the user's link entry. Selected with `STUDIO_SANDBOX_PROVIDER=user-desktop`
  (the default).

### Selection

The host app calls `resolveSandboxProviderKindFromEnv()` to pick the provider. Single rule:

1. `STUDIO_SANDBOX_PROVIDER` is honored if set (one of `agent-sandbox`,
   `user-desktop`).
2. Otherwise the provider defaults to `user-desktop` (the desktop-side
   `deco link` daemon — auto-spawned by `bun run dev --local-sandbox-provider`
   in local dev, and the supported topology for single-machine self-hosts
   running the link side-by-side).

Preconditions:

- `agent-sandbox` is opt-in only — never auto-selected.
- The retired `host` and `local-docker` provider kinds are rejected. Local dev
  now exercises `user-desktop` against the auto-spawned link binary, matching
  the production code path.

## URL shape

- **Prod (agent-sandbox)**: `https://<handle>.<root>/*` → pod dev server on `:3000`
  and `/_daemon/*` → pod daemon on `:9000` (server-to-server bearer auth).
- **user-desktop**: previews are served by the user's link daemon at its own
  reachable URL.

Handles are `<branch-slug>-<hash>` (or a bare hash when no branch is set),
DNS-label safe (RFC 1035 caps labels at 63). The hash portion is a truncated
SHA256 of `projectRef` for shared hosted sandboxes and `userId:projectRef` for
user-desktop.
The URL itself is the routing key, not a capability — daemon endpoints
require a bearer token.

## Environment

- `STUDIO_SANDBOX_PROVIDER` — pin the provider: `agent-sandbox` or `user-desktop`.
  Defaults to `user-desktop`. Setting it explicitly is required for production
  deploys.
- `SHARED_AGENT_SANDBOXES_ENABLED` — default-off rollout flag. When `true`,
  agent-sandbox uses the org-scoped session registry and shares a branch across
  authorized collaborators. It does not change user-desktop identity. Enabling
  it does not migrate a running per-user hosted workspace, so drain those
  sandboxes (and commit any working-tree changes) before rollout. Shared claims
  remain cleanup-capable if the flag is later disabled.
- `SANDBOX_ROOT_URL` — production template for the pod URL. Either a bare
  base (`https://sandboxes.example.com` → handle becomes leading subdomain)
  or a `{handle}` template (`https://{handle}.sandboxes.example.com`).

## Design follow-ups

- [First-class run attachment](./run-attachment.md) records the lifecycle and
  concurrency questions exposed by run-specific tool catalogs and workspace
  links.
