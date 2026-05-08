# @decocms/sandbox

Isolated per-user sandboxes for MCP tool execution.

One sandbox per `(userId, projectRef)`: a container (or VM) holding a checked-out
repo plus an in-pod daemon that proxies exec, file ops, and the dev server.
Callers go through a single `SandboxRunner` interface; the runner decides how
the sandbox is provisioned and reached.

## Runners

Four runner backends live behind the common `SandboxRunner` interface
(`server/runner/types.ts`):

- **`host`** — local dev / single-tenant self-host. Spawns the same Bun-based
  daemon as the Docker runner but as a host child process, with a per-branch
  full git clone in `${DATA_DIR}/sandboxes/<handle>/`. The local
  `*.localhost:7070` ingress routes browser traffic to the per-branch daemon's
  host TCP port. No container; no hardening (the daemon runs in the user's
  trust boundary).
- **Docker** (`./runner`) — containerized sandboxes. Spawns containers via the
  local Docker CLI and routes browser traffic through an in-process ingress
  bound on `SANDBOX_INGRESS_PORT`.
- **Freestyle** (`./runner/freestyle`) — hosted VMs. Preview URL is a
  Freestyle-provided HTTPS domain; daemon traffic is base64-wrapped to clear
  Cloudflare WAF. SDKs are `optionalDependencies` and only pulled in when this
  runner is selected.
- **agent-sandbox** (`./runner/agent-sandbox`) — one `SandboxClaim` per sandbox
  against the [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
  operator. Studio talks to pods via apiserver port-forward in dev; in prod,
  `previewUrlPattern` switches the preview URL to real ingress and skips the
  dev forward.

### Selection

The host app calls `resolveRunnerKindFromEnv()` to pick the runner. Single rule:

1. `STUDIO_SANDBOX_RUNNER` is honored if set (one of `host`, `docker`,
   `freestyle`, `agent-sandbox`).
2. Otherwise the runner defaults to `host`.

Preconditions:

- `freestyle` requires `FREESTYLE_API_KEY` to be set; otherwise the call throws
  at startup.
- `agent-sandbox` is opt-in only — never auto-selected.

## URL shape

- **Prod**: `https://<handle>.<root>/*` → pod dev server on `:3000`
  and `/_daemon/*` → pod daemon on `:9000` (server-to-server bearer auth).
- **Local dev**: `http://<handle>.localhost:7070/*`.

Handles are `<branch-slug>-<hash5>` (or a bare 5-char hash when no branch is
set), DNS-label safe (RFC 1035 caps labels at 63). The hash portion is a
truncated SHA256 of `userId:projectRef`; collisions are bounded per-project.
The URL itself is the routing key, not a capability — daemon endpoints
require a bearer token.

## Local dev (Docker)

The local ingress forwarder binds both `127.0.0.1` and `::1` on
`SANDBOX_INGRESS_PORT` (default `7070`) and routes requests by `Host:` header.
macOS and Linux resolve `*.localhost` to loopback natively, so **no extra DNS
setup is required** — `http://<handle>.localhost:7070/` just works.

Port `7070` (not `7000`) because macOS's AirPlay Receiver binds port 7000 and
would intercept Chrome's IPv6 connection attempt.

If you previously configured `/etc/resolver/localhost` or `/etc/hosts` entries
for this, you can remove them — they're no longer needed.

## Environment

- `STUDIO_SANDBOX_RUNNER` — pin the runner: `host` (default), `docker`,
  `freestyle`, or `agent-sandbox`. Setting it explicitly is required for any
  non-host runner. Auto-detection of Docker has been removed.
- `FREESTYLE_API_KEY` — required for the Freestyle runner.
- `STUDIO_SANDBOX_IMAGE` — override the Docker runner image
  (default `studio-sandbox:local`, built from `image/Dockerfile`).
- `SANDBOX_INGRESS_PORT` (default `7070`) — local ingress bind port for the
  host/docker runners. Set to `0` to skip binding entirely (use this if a
  real reverse proxy fronts `*.localhost` traffic instead).
- `SANDBOX_ROOT_URL` — production template for the pod URL. Either a bare
  base (`https://sandboxes.example.com` → handle becomes leading subdomain)
  or a `{handle}` template (`https://{handle}.sandboxes.example.com`).
