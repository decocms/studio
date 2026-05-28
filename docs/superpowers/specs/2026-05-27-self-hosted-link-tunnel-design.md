# Self-Hosted Link Tunnel — Design

**Date:** 2026-05-27
**Status:** Draft — awaiting implementation plan

## Problem

`deco link` today depends on a Cloudflare-hosted Warp tunnel server at `*.deco.host` to expose the user's desktop link daemon to the cluster. The tunnel is the carriage for two structurally different concerns: (a) the cluster → daemon control plane (HMAC-signed dispatches for sandbox lifecycle and harness runs, streamed as SSE), and (b) public preview URLs for sandbox dev servers.

The dependency on Cloudflare costs us a closed-source service we can't iterate on, an authentication shim (`LEGACY_TUNNEL_TOKEN`, a hardcoded shared key — see `apps/mesh/src/link-daemon/tunnel.ts:33`) that bypasses our user database, and a public-internet attack surface for what is in reality private developer infrastructure.

## Goals

- Remove the Cloudflare/Warp dependency entirely.
- Authenticate daemon connections against our own user database (Better Auth) using the existing OAuth session minted by `deco auth login`.
- Keep dev and production paths structurally identical — no more `MESH_ALLOW_LOCALHOST_LINKS` carve-out.
- Delete more code than we add.

## Non-Goals

- Cross-machine sharing of sandbox previews ("send a colleague your preview URL"). This was a side effect of the Cloudflare tunnel, not a feature we want to preserve. If sharing becomes a product requirement later, it returns as an explicit, opt-in "publish this preview" flow — not as the default for every sandbox.
- Backwards compatibility with the existing tunnel-based protocol. This feature is not yet used in production; we hard-cut.
- Multi-machine-per-user (we keep the current one-at-a-time semantics, last-link-wins).

## Architecture overview

Two halves of the old tunnel get solved separately.

### Control plane: cluster → daemon

Daemon opens a single authenticated WebSocket to mesh:

```
wss://studio.decocms.com/api/links/connect
Authorization: Bearer <Better Auth session token>
```

The mesh pod that accepts the upgrade (call it the **owner pod**) claims ownership in a NATS JetStream KV bucket and subscribes to two NATS subjects:

- `links.dispatch.<userSub>` — receives dispatch requests from any mesh pod
- `links.cancel.<userSub>` — receives cancellations for in-flight dispatches

Any mesh pod that wants to call into the daemon does a NATS request to `links.dispatch.<userSub>`. NATS routes it to whichever pod currently subscribes — the owner pod — which forwards over the WebSocket to the daemon and streams the response chunks back over a per-request NATS inbox.

No public hostname, no wildcard DNS, no wildcard TLS, no HMAC, no shared secret.

### Previews: browser → sandbox

The daemon runs a single local HTTP server on the user's machine (default port `5174`, configurable via `--port`). All sandbox previews are served from that one port, multiplexed by Host header:

```
http://<handle>.localhost:5174/
```

`*.localhost` resolves to `127.0.0.1` in every major browser by spec (RFC 6761). No DNS configuration, no certificates. Previews are local to the developer's machine; the cluster has nothing to do with serving them.

This collapses the user-desktop sandbox provider toward the same shape as the local-docker provider: both spawn sandboxes locally, both expose them at `<handle>.localhost:<port>`.

## Components

### Mesh-side: WS gateway (`apps/mesh/src/links/ws-gateway.ts`)

A new Hono route at `GET /api/links/connect` that:

1. Validates the bearer token via Better Auth, extracting `userSub`. Reject with 401 if absent/invalid.
2. Upgrades to WebSocket.
3. Awaits the daemon's `hello` frame (with a short timeout — 5s). The hello carries `previewPort`, `machineId`, `hostname`, `cliVersion`, `capabilities`.
4. Writes `studio_links/<userSub> = {podId, machineId, hostname, cliVersion, previewPort, connectedAt}` to the NATS JS KV bucket. `put()` semantics — last write wins, no compare-and-swap.
5. Subscribes the pod to `links.dispatch.<userSub>` and `links.cancel.<userSub>` (plain subscribe, **not** queue group).
6. Starts a JS KV `watch` on the entry. If the watch ever surfaces a value whose `podId` is not this pod's id, the pod has lost ownership — close the WS with code `4001 "superseded"`, unsubscribe.
7. Refreshes the KV entry every 20s (bucket `maxAge: 60s`).
8. On WS close from the daemon: delete the KV entry and unsubscribe.

### Mesh-side: dispatcher (`apps/mesh/src/links/dispatcher.ts`)

A single function used by every cluster-side site that today builds a `*.deco.host` URL:

```ts
function dispatchToDaemon(
  userSub: string,
  req: DispatchRequest,
  opts?: { signal?: AbortSignal }
): AsyncIterable<DispatchChunk>
```

Implementation:

1. NATS request to `links.dispatch.<userSub>` with the request payload, using a per-call reply inbox.
2. The owner pod streams back individual NATS messages on the inbox: `chunk`, then `end` or `error` as a terminator.
3. Consumer iterates over `chunk`s. On consumer abort, publish a `links.cancel.<userSub>` carrying the `reqId`.

`remoteDispatch` (`apps/mesh/src/harnesses/remote-dispatch.ts`) is rewritten to consume `dispatchToDaemon` directly. The SSE parser (`parseSSEStream`) and HMAC signing (`signRequest`) both go away — chunks arrive already structured.

### Daemon-side: cluster connection (`apps/mesh/src/link-daemon/cluster-connection.ts`)

Replaces `tunnel.ts` + `registration.ts`. Responsibilities:

1. Open WS to `${MESH_CLUSTER_URL}/api/links/connect` with `Authorization: Bearer <session.accessToken>`.
2. Send `hello` frame.
3. Demultiplex incoming `request` / `cancel` frames by `reqId`. For each `request`: dispatch into the local control-plane handler (the sandbox lifecycle code that today lives in `control-plane.ts`, now invoked in-process rather than via HTTP). Stream the handler's response back as `chunk` frames, terminating with `end` or `error`.
4. WebSocket ping/pong for heartbeat.
5. On disconnect, reconnect with exponential backoff (max 30s, jitter). Close code `4001 "superseded"` does **not** trigger reconnect — the user explicitly took over from another machine, and reconnecting would oscillate.

### Daemon-side: local ingress (`apps/mesh/src/link-daemon/local-ingress.ts`)

A separate Bun.serve listener on the configurable port. Reads from the existing sandbox handle → port map (already maintained by `createDesktopSandboxProvider`). For each request:

```ts
const host = req.headers.get("host") ?? "";
const handle = parseHandleFromHost(host); // e.g. "abc123" from "abc123.localhost:5174"
const sandboxPort = handles.get(handle);
if (!sandboxPort) return new Response("unknown handle", { status: 404 });
return fetch(`http://127.0.0.1:${sandboxPort}${url.pathname}${url.search}`, {
  method: req.method,
  headers: req.headers,
  body: req.body,
  redirect: "manual",
});
```

WebSocket upgrades are accepted via `server.upgrade()` and proxied to the sandbox port by bridging two WebSocket connections. This is required for Vite HMR, Next.js dev-server WS, and other framework HMR channels.

Unknown handles return 404. There is no fallback to a "default sandbox" — explicit-or-fail keeps debugging cheap.

The local port serves only preview traffic. It exposes no cluster-control-plane endpoints; those arrive over the WS to mesh and never touch a local listener.

### Wire protocol — dispatch frames

JSON over WebSocket text frames (binary frames are an option later for body-heavy paths):

```
// pod → daemon
{ type: "request", reqId, method, path, headers, body? }
{ type: "cancel",  reqId }

// daemon → pod
{ type: "hello",   previewPort, machineId, hostname, cliVersion, capabilities }
{ type: "headers", reqId, status, headers }
{ type: "chunk",   reqId, data }
{ type: "end",     reqId }
{ type: "error",   reqId, code, message }
```

`reqId` is a daemon-side correlation id; the pod generates one per inbound NATS request.

### NATS subject design

| Subject | Pattern | Direction | Type |
|---|---|---|---|
| `links.dispatch.<userSub>` | plain subscribe (no queue group) | any pod → owner pod | request-reply with streamed inbox |
| `links.cancel.<userSub>` | plain subscribe (no queue group) | any pod → owner pod | fire-and-forget |
| KV `studio_links/<userSub>` | JetStream KV (bucket `studio_links`, `maxAge: 60s`) | owner pod writes, all pods may read | claim record |

**No queue groups.** The invariant is "at most one owner pod per userSub." A queue group would silently load-balance if two pods both believed they were the owner during a reconnect race, causing some dispatches to hit a stale WebSocket. With a plain subscribe, the second subscriber is detectable — and we enforce the invariant via the KV watch (see ownership section below).

### Ownership, eviction, reconnect

**Claim:** when a daemon connects to pod B, pod B writes the KV entry. This unconditionally overwrites any previous claim (last-link-wins is the product behavior we want).

**Eviction:** the old owner pod's KV watcher fires on the value change. The old pod sees a `podId` that isn't its own, closes the daemon's WebSocket with `4001 "superseded"`, and unsubscribes from the dispatch + cancel subjects. No explicit "evict" message is needed — the KV watch is the propagation channel, which works even across brief partitions.

**Crash recovery:** if the owner pod crashes, its KV entry expires within the bucket's `maxAge` (60s). The daemon's WS dies (TCP RST or our heartbeat ping timeout). The daemon reconnects via exponential backoff; the new connection lands on a healthy pod, which writes a fresh KV claim and subscribes.

**Reconnect window:** there's a sub-second gap during reconnect where neither pod owns the daemon. A dispatch arriving in that window times out at the NATS request layer (default a few seconds) and surfaces as a typed error to the consumer. Same failure mode as a Cloudflare DO cold start today.

### Authentication

- **Daemon → mesh:** `Authorization: Bearer <session.accessToken>` on the WS upgrade. Validated once by Better Auth at connect-time; trusted for the WS lifetime. If the session is later revoked, the user re-runs `deco auth login && deco link` — explicit and adequate for v1.
- **Mesh-pod ↔ mesh-pod:** NATS connection auth, same as the existing event bus. No additional layer.
- **Browser → local ingress:** none. Same posture as `local-docker` or `bun dev`; the port is `127.0.0.1`-only.

## Dev/prod parity

The new architecture eliminates the local-vs-remote special case:

| | Dev | Prod |
|---|---|---|
| Daemon WS endpoint | `ws://localhost:4000/api/links/connect` | `wss://studio.decocms.com/api/links/connect` |
| Auth | Better Auth bearer | Better Auth bearer |
| Dispatch transport | NATS subject | NATS subject |
| Local sandbox ingress | `http://<handle>.localhost:<port>` | `http://<handle>.localhost:<port>` |
| Mesh pod count | 1 | N |

Multi-instance dev is supported via the existing `--port` flag on `deco link`: each daemon picks its own local port, reports it in the `hello` frame, and the cluster builds preview URLs from the live KV value. There is no hardcoded port assumption anywhere.

Dev gets one bonus affordance for free: both Studio (`http://localhost:4000`) and the preview (`http://<handle>.localhost:<port>`) are HTTP, so dev can iframe previews without mixed-content blocking. Prod opens previews in a new tab.

## Deletions

This is a hard cut — no compatibility shim, no transition flag, no rollback path beyond reverting the PR. The following are removed:

**Daemon side:**
- `apps/mesh/src/link-daemon/tunnel.ts`
- `apps/mesh/src/link-daemon/registration.ts`
- `apps/mesh/src/link-daemon/control-plane.ts`. Its HMAC verification and HTTP-routing scaffolding go away; the underlying sandbox-lifecycle and dispatch handlers are invoked directly by `cluster-connection.ts` for incoming `request` frames.
- `openDaemonTunnel` in `user-desktop-provider.ts` and all per-sandbox tunnel calls
- `@deco-cx/warp-node` dependency
- `--no-tunnel` CLI flag

**Mesh side:**
- `apps/mesh/src/links/routes.ts` in its current form. The three write endpoints (`POST /api/links`, `POST /api/links/heartbeat`, `DELETE /api/links/me`) are removed entirely. `GET /api/links/me` survives as a small handler that reads the NATS KV claim directly — likely a few lines next to the WS gateway, not its own file.
- `apps/mesh/src/links/link-registry.ts`
- The `link_registry` Postgres table (dropped via forward-only migration)
- HMAC signing: `signRequest`, `X-Link-Secret` header, `linkSecret` on `LinkEntry`, `DAEMON_LINK_SECRET` env, all HMAC verification code
- `tunnelUrl` field on `LinkEntry` and any code that reads it
- `MESH_ALLOW_LOCALHOST_LINKS` env and all guards on it
- `expectedTunnelDomain`, `computeLinkSubDomain`, `isLocalhostUrl`
- Every `*.deco.host` literal in the codebase
- `parseSSEStream` in `remote-dispatch.ts` (chunks arrive structured now)

**CLI side:**
- The dual code path in `link-daemon/index.ts:67-78` for tunnel vs. no-tunnel

## Hard-cut compatibility

An old CLI binary that hits the new cluster will fail when its `POST /api/links` registration call returns 404. The CLI's error handler is updated to recognize this and print:

```
deco link: this CLI version is incompatible with the cluster.
Run `bunx decocms@latest link` to upgrade.
```

(For completeness: the new CLI hitting an old cluster will also fail, because the cluster won't have `/api/links/connect` mounted. Same upgrade instruction surfaces.)

This feature is not in production use, so the blast radius of the hard cut is acceptable.

## Commit ordering inside the PR

Reviewability matters even for a single-PR migration. Suggested commit order:

1. NATS KV bucket + WS gateway + claim/eviction state machine. No callers yet; mesh accepts WS connections that immediately have nothing to do.
2. Cluster-side `dispatchToDaemon` and its protocol-level tests.
3. Rewrite of `remoteDispatch` and all sandbox-lifecycle/decopilot dispatch sites to call `dispatchToDaemon` instead of building tunnel URLs.
4. Daemon rewrite: new `cluster-connection.ts` replaces `tunnel.ts` + `registration.ts`; HMAC and `linkSecret` plumbing comes out.
5. Daemon local ingress (`local-ingress.ts`); `openDaemonTunnel` and per-sandbox tunnels deleted.
6. Removal of the old surface: HTTP routes, `LinkRegistry`, HMAC infra, env flags, dead constants. Postgres migration to drop `link_registry`.
7. New tests per the testing section; deletion of tests covering removed code.

## Testing

Two tiers per repo convention (`TESTING.md`).

### Unit (co-located `*.test.ts`)

- **Dispatch frame codec:** round-trip every frame type; reject frames with unknown `type` or missing `reqId`.
- **Host header parser:** `<handle>.localhost:<port>` → `<handle>`; `<handle>.localhost` (no port) → `<handle>`; non-localhost host → `null`; bare `localhost` → `null`. Edge cases: trailing dot, uppercase, IPv6 brackets.
- **WS reconnect logic:** exponential backoff with jitter, cap at 30s. Close code 4001 (superseded) does not reconnect; other close codes do.
- **Claim watcher state machine:** given a sequence of KV watch events, assert the correct close-decision behavior.
- **Hello frame validation:** `previewPort` in `1..65535`, `cliVersion` semver-shaped, non-empty `machineId`.

No mocks, no NATS, no WS — pure data-in/data-out.

### E2E (`apps/mesh/e2e/tests/`)

- **Happy path:** real mesh + NATS + Postgres + in-process daemon. Drive a harness via the existing API; assert chunks arrive end-to-end.
- **Eviction:** two daemons same `userSub`; second connect closes the first's WS with code 4001; next dispatch lands on the second.
- **Auth rejection:** WS upgrade without bearer → 401; malformed → 401; revoked session → 401.
- **Local ingress proxy:** spawn a sandbox, daemon's local ingress proxies HTTP to it, and a WebSocket upgrade is forwarded through. Unknown handle → 404.
- **`GET /api/links/me`:** returns the live KV claim; empty when no daemon connected.

### Multi-pod e2e

Scale mesh in the e2e docker-compose to `replicas: 2`. Daemon WS lands on whichever pod the LB picks; the test issues the dispatch via a request pinned to the *other* pod (via direct service hostname) to cover the cross-pod NATS hop deterministically.

### Resilience (`tests/resilience/scenarios/`)

- **NATS disconnection mid-dispatch:** Toxiproxy severs NATS, in-flight dispatch fails fast with a typed error (not a hang), daemon WS stays open (NATS is mesh↔mesh, not daemon↔mesh), next dispatch after recovery succeeds.
- **Owner pod crash:** kill the owner pod, in-flight request errors cleanly, daemon's WS closes, daemon reconnects, KV claim moves to a new pod, next dispatch routes correctly.

## Open questions deferred to implementation

- Exact Better Auth API for "validate this bearer token in a WebSocket upgrade handler" — depends on which Better Auth helper exposes session resolution outside the typical request middleware. To be resolved during commit 1.
- Whether to use `nats.js`'s `Subscription` API directly or wrap it for the per-reply-inbox streaming pattern. Library ergonomics decide — both are viable.
- Bun's WS reverse-proxy of upgrade requests: confirm that `server.upgrade()` plus a parallel `WebSocket` to the sandbox port behaves cleanly under backpressure. Build a focused spike in commit 5 if needed.

None of these change the architecture; they're library/API details that surface during implementation.
