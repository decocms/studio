Written 2026-08-14. Revised 2026-08-18 against a read of the running code and
charts. Status: **built** — Go controller, `agent-sandbox` runtime,
`RemoteSandboxProvider` in studio.

> ## Implementation status — 2026-08-18
>
> `packages/sandbox/controller-go/` is the controller: its own Go module,
> `net/http` + the upstream generated clientsets, sibling to `daemon-go/`.
> Studio speaks to it through `RemoteSandboxProvider`
> (`STUDIO_SANDBOX_PROVIDER=remote`) and holds no kubeconfig, no CRD verbs and
> no `pods/portforward` of its own.
>
> **Control plane only, as specified.** The controller answers *where* a
> sandbox's daemon is and *what token opens it*; studio's existing
> `proxyDaemonRequest` dials the pod. Nothing is relayed. In a cluster with a
> preview gateway that address is in-cluster Service DNS; without one it is a
> controller-held port-forward returning `http://127.0.0.1:<port>`, which is
> correct exactly when controller and studio share a host.
>
> **One definition of the daemon's boot contract.** `daemon-go/pkg/protocol` is
> the daemon's first exported package; `internal/config` now aliases those
> types rather than owning them, so a shape change is a compile error on both
> ends. That retires the hand-written duplicate in `server/daemon-client.ts` +
> `shared/build-config-payload.ts` for the config path.
>
> Verified end-to-end against a k3s cluster running the agent-sandbox operator:
> a real sandbox provisioned through the HTTP contract, lifecycle streamed to
> `ready`, daemon reached directly at the returned address (and rejecting a
> wrong token), TTL patched both directions, deleted with a real drain.
> `packages/sandbox/controller-e2e/` is the black-box suite
> (`CONTROLLER_E2E_URL`).
>
> The Service-DNS path was verified separately, because a controller running
> outside the cluster cannot resolve the name it correctly emits: with
> `previewUrlPattern` set the controller returned
> `http://<sandbox>.agent-sandbox-system.svc.cluster.local:9000`, and a `fetch`
> from inside the studio pod got `200` off the daemon's `/health`. That is the
> path this document called an unproven future hardening pass.
>
> Doing it surfaced a real coupling: `ensureServicePort` was gated on the
> preview **gateway**, but a ports-less Service routes nothing at all — not
> through Envoy and not through kube-proxy — so Service DNS to the daemon
> needs the port whether or not a gateway exists. The Go runtime gates it on
> `previewUrlPattern` alone. The TypeScript runner could conflate the two
> because it only ever reached the daemon by port-forward, so the Service
> mattered for preview and nothing else.
>
> **One deliberate deviation.** The clone-credential callback names
> `{connectionId, cloneUrl}`, not a handle, and studio verifies the pair
> against a live sandbox row or a configured warm pool before minting. A
> handle could not be threaded through `withFreshCloneUrl`'s five call sites —
> two are warm-pool paths with no handle at all. The verification closes the
> same oracle: you can only refresh credentials for repos a sandbox already
> has, which is what the caller could read off the persisted clone URL anyway.
>
> **Not built, in rollout order:**
>
> - [Rollout](#rollout) step 1, killing studio's production port-forward, is
>   **moot rather than done**: the controller reaches the daemon over Service
>   DNS itself, and studio under `remote` has no port-forward to kill. Making
>   the change in `runner.ts` too would harden an implementation step 5
>   deletes.
> - Tenant warm **pools** (`tenant-pools.ts`). Warm-pool *mode* — the sentinel
>   bearer and its rotation to a per-claim token — is ported and exercised;
>   per-org pools are not, so `STUDIO_SANDBOX_TENANT_POOLS` is ignored by the
>   Go runtime today.
> - The `docker` runtime. The registry, probing, `/runtimes` and placement all
>   landed with `agent-sandbox` as the only member, so adding it is one
>   implementation behind an interface that already has tests.
> - Helm chart + published image for the controller, and the deletion of
>   studio's `sandbox-rbac.yaml` Role. That deletion is step 5 and must land in
>   the same PR that flips the flag, or this has made things worse rather than
>   better.
---

## What exists today

`AgentSandboxProvider` (`agent-sandbox/runner.ts`, 3097 lines, plus
`client.ts` 1123, `lifecycle-watcher.ts` 802, `tenant-pools.ts`, `capacity.ts`,
`credential-refresh.ts` — ~7k lines with tests) runs **inside the Studio API
process**. It:

- creates/deletes `SandboxClaim` CRs and per-claim `HTTPRoute`s against the
  cluster's API server, using Studio's ServiceAccount;
- keeps an in-memory `records` map and persists to `sandbox_runner_state` in
  Studio's Postgres;
- runs three background loops in the Studio pod: the claim-deletion reaper, the
  git-credential refresher, and the tenant-warm-pool reconciler;
- opens `127.0.0.1` port-forwarders through the apiserver for **every**
  Studio→daemon control-plane call, in production as well as kind — see
  [Prerequisite](#prerequisite-studio-must-stop-port-forwarding);
- POSTs `/_sandbox/config` to the daemon and rotates the sentinel token to a
  per-claim one before `ensure()` returns;
- proxies daemon and preview HTTP.

Studio constructs it in `apps/api/src/sandbox/lifecycle.ts:160`. The only other
provider kind is `user-desktop`, built per-run from the acting user's link
claim — and the link is being deleted (#5570), which is what leaves local dev
with no sandbox at all and forces this to also answer the dev question.

**The caller surface is much smaller than the implementation.** Across
`apps/api` the whole thing is reached through:

| call | sites |
|---|---|
| `proxyDaemonRequest` | 10 (8 files; excludes tests) |
| `ensure` | 1 (`tools/sandbox/start.ts`) |
| `alive`, `getPreviewUrl`, `hasSchedulableCapacity`, `watchClaimLifecycle`, `forgetHandle`, `renewTtl`, `resolvePreviewUpstreamUrl`, `proxyPreviewRequest` | 1 each |

That table is the actual API to design against, not `SandboxProvider`'s 15
methods.

**A Docker provider already existed and was deleted** in `ace365099` (#3591,
2026-06-01): 684 lines of runner + 207 of local ingress + ~1k of tests. It was
removed because `user-desktop` covered local dev. That premise is expiring, and
the deleted tree is a free reference for behavior (`git show ace365099^:<path>`)
even though the port is now to Go.

---

## Why Go

Verified against `sigs.k8s.io/agent-sandbox@v0.5.5` (latest; the module publishes
`v0.1.0-rc.0` … `v0.5.5`).

**Our CRD types are upstream, typed, and generated.** We target
`extensions.agents.x-k8s.io/v1alpha1` (`agent-sandbox/constants.ts:9`), which is
`extensions/api/v1alpha1/sandboxclaim_types.go` upstream — and every field we
write is a struct field there: `sandboxTemplateRef`, `env`, `warmpool`,
`lifecycle.shutdownTime`, `additionalPodMetadata`, `status.sandbox.name`,
`status.sandbox.podIPs`. There are generated clientsets and informers for both
groups:

```go
sigs.k8s.io/agent-sandbox/extensions/api/v1alpha1                      // types
sigs.k8s.io/agent-sandbox/clients/k8s/extensions/clientset/versioned   // SandboxClaims(ns).Create/Get/Delete/Patch/Watch
sigs.k8s.io/agent-sandbox/clients/k8s/clientset/versioned              // Sandboxes(ns)
sigs.k8s.io/agent-sandbox/clients/k8s/extensions/informers             // shared cache
```

That is a direct replacement for `client.ts` — 1123 lines of hand-written
resource JSON and raw `fetch` against the API server, pinned by hand and
re-verified by hand on every operator bump. Informers likewise replace the
hand-rolled watch/resync/restart plumbing in `lifecycle-watcher.ts` (802 lines)
and make the `records` map a lister rather than a cache we invalidate ourselves.

**The port-forward hack goes away.** `clients/go/sandbox/tunnel.go` +
`ip.go` + `gateway.go` are maintained connection strategies (direct pod IP,
apiserver tunnel, gateway) covering what `runner.ts` hand-builds with a
`net.Server` and `@kubernetes/client-node`'s `PortForward` — including the
library wart that forced `errMsg()` (`runner.ts:119`) to dig a message out of a
WebSocket `ErrorEvent`.

**We already run Go in this subsystem.** The daemon is Go
(`daemon-go/`, one static binary), the operator is Go, `client-go` is Go. The
controller is the third Go process in a Go neighborhood, and it can share the
daemon's config/health structs instead of re-deriving them (see
[Daemon protocol](#daemon-protocol)).

### What Go does *not* give us

**The high-level SDK client is not usable as-is.** `clients/go/sandbox.Client`
hardcodes `GenerateName: "sandbox-claim-"` (`clients/go/sandbox/k8s.go:155`) and
sets only `WarmPoolRef` — no template, no env, no TTL — and its request surface
(`Run`/`Read`/`Write` on port 8888) is upstream's own sandbox runtime, not our
daemon. Our claims are **named** (the handle *is* the claim name, deliberately),
templated, env-injected and TTL-patched.
So: use the **generated clientsets + API types**, read `clients/go/sandbox` as
reference for the connect strategies, don't build on its `Client`.

**This is a rewrite, not a move.** ~7k lines of TypeScript with tests get
re-implemented: claim building, tenant pools, capacity probe, credential
refresher, HTTPRoute minting, state store, preview resolution. Weeks, not days,
and for part of it two implementations exist at once. The sequencing in
[Rollout](#rollout) exists to keep that window short and always-rollback-able.
If that price isn't worth paying, the alternative is honest and cheap: move the
TypeScript as-is into a Bun service and keep the same HTTP contract — the
contract is what buys the Lambda backend, not the language.

---

## The cut

One new deployable, `packages/sandbox/controller-go/` — its own Go module,
sibling to `daemon-go/`, same release shape (static binary in a distroless
image, multi-arch, published by a workflow mirroring
`release-studio-sandbox.yaml`). It owns everything that touches an
infrastructure API.

**Moves out of Studio:** the K8s client, `SandboxClaim`/`HTTPRoute` writes,
warm pools, the capacity probe, the claim reaper, the credential refresher, the
port-forwarder, the daemon config POST + token rotation,
`sandbox_runner_state`, and the `@kubernetes/client-node` dependency + RBAC.

**Stays in Studio:** everything a *tenant* concept touches — handle derivation
(`sandbox-ref.ts`, `apps/api/src/sandbox/claim-handle.ts`), the sandbox tools,
dispatch, `sandbox-fs-hooks`, the preview edge proxy and its "connecting" page,
git credential *minting* (needs the DB + vault), and the decision of *when* a
sandbox is wanted.

**Studio keeps implementing `SandboxProvider`** — a new
`RemoteSandboxProvider` (~200 lines of TS) that speaks HTTP to the controller.
No caller in `apps/api` changes. `provider/types.ts` stays where it is and stays
the source of truth for the wire shape; the Go structs mirror it and a contract
test asserts they agree.

### Key decision: the controller is control plane only

**Studio keeps talking to the daemon directly.** The controller never carries
daemon bytes: it returns *where the daemon is and what token opens it*, and
Studio's existing fetch code is unchanged. Preview traffic already bypasses
Studio entirely via per-claim `HTTPRoute`.

An earlier draft of this document claimed production already reaches the daemon
over in-cluster Service DNS, citing `runner.ts:711`. **That is wrong** — 711 is
the rehydrate-failed fallback, and the primary path is a port-forward. Correcting
it is what the next section is about, and it is load-bearing for reason (a).

This deletes the hardest part of the service (streaming request/response relay,
SSE passthrough, WebSocket upgrade, backpressure) before it is written — and
deletes it from the side that would otherwise have to reimplement Bun's
`fetch`-to-`Response` streaming in Go.

One exception: **when Studio runs outside the sandbox network** (today's kind
setup), someone must tunnel. The k8s backend keeps a port-forward — via the
SDK's tunnel strategy — and returns `http://127.0.0.1:<port>`, correct only when
controller and Studio share a host, which is exactly the kind-local-dev case.
The Docker backend makes that case obsolete for most contributors anyway.

### Prerequisite: Studio must stop port-forwarding

**This is the one change that actually drops the RBAC, and it is not part of the
split.** Ship it in TypeScript, against today's runner, before anything else
here.

Studio's control-plane path to the daemon is a port-forward through the
apiserver, **unconditionally** — not only in kind. `openForwarder` builds
`http://127.0.0.1:<port>` at `runner.ts:1449` (ensure), `runner.ts:1795` (pool
reconciler) and `runner.ts:2293` (rehydrate/adopt), and none of those are gated
on `previewUrlPattern`. The in-cluster Service URL at `runner.ts:711` is the
fallback taken when rehydrate misses; `runner.ts:881` uses it only to resolve
the *preview* upstream. The chart says the same thing in as many words:

> "Studio runner → sandbox daemon (control plane): … This path uses portforward
> **unconditionally** — see runner.ts:openForwarder. … In production we *could*
> switch path 2 to in-cluster Service DNS and drop portforward from this Role;
> that's tracked as a future hardening pass."
> — `deploy/helm/sandbox-env/templates/sandbox-rbac.yaml`

So a controller that leaves daemon traffic to Studio, without this change, keeps
`pods/portforward` and `pods get/list/watch` in Studio's Role. The CRD verbs go
and the dangerous ones stay — reason (a) unmet.

**The change:** when `previewUrlPattern` is set (production), record
`http://<adoptedSandboxName>.<ns>.svc.cluster.local:9000` as `daemonUrl` instead
of opening a forwarder — the URL `runner.ts:881` already builds, via the same
`resolveServiceNameForHandle`. Keep the forwarder only when `previewUrlPattern`
is unset (kind), where it is the whole point. The warm-pool reconciler is the
same change. The daemon already enforces its own bearer on every mutating route,
so nothing is being opened that was closed.

Do this first, on the implementation we already trust: if in-cluster routing to
port 9000 is going to break, learning that from a 40-line TS diff beats learning
it from a Go rewrite.

#### Related finding: the daemon's control plane is already internet-reachable

The per-claim `HTTPRoute` publishes the daemon's port 9000 at
`<handle>.<preview-domain>` — that is why `ensureServicePort` exists — and 9000
is the same port that serves `/_sandbox/*`: `daemon-go/main.go:562-569` routes
`/_sandbox/*` to the daemon mux and everything else to the dev-server proxy. So
`POST https://<handle>.sandbox.deco.host/_sandbox/dispatch` is reachable from the
internet today, gated by the per-claim bearer (`internal/auth`, constant-time
compare; `dispatch.go:274` checks before any work). Audited: no mutating route
is ungated.

Two consequences worth recording:

- Studio *could* reach the daemon over that public hostname instead of Service
  DNS, dropping the RBAC with no in-cluster networking work at all. Rejected as
  the default — it puts dispatch and config on the public Gateway, making it a
  critical path for execution and not just for preview. Keep it as the fallback
  if Service DNS turns out to be blocked.
- The real hardening is **not** stronger auth, it is a **second port**: serve
  `/_sandbox/*` on a port the `HTTPRoute` does not publish, leaving 9000 for
  preview and the four deliberately-unauthenticated Fast-Preview routes
  (`/_sandbox/{idle,events,scripts,decofile}` — the fetcher is an arbitrary
  production server that can carry no credential, see `routes/decofile.go`).
  Out of scope here — it is a daemon change — but it is the follow-up that makes
  the public surface only what has to be public.

---

## API

JSON over HTTP, bearer-authenticated, ClusterIP-only. `net/http` +
`encoding/json`; no framework, no gRPC, no generated SDK.

```
POST   /sandboxes                       ensure (idempotent by handle)
GET    /sandboxes/:handle               alive + preview + daemon address + last termination
DELETE /sandboxes/:handle               delete; returns once the sandbox is gone
PATCH  /sandboxes/:handle/lifetime      { extendToIdleWindow } | { graceMs }   → renewTtl / releaseAfter
POST   /sandboxes/:handle/credentials   rotate the clone credential in place
GET    /sandboxes/:handle/events        SSE stream of ClaimPhase → watchClaimLifecycle
GET    /runtimes                        available runtimes, capacity, capabilities
GET    /capacity                        { schedulable: boolean } — aggregate
GET    /healthz
```

`POST /sandboxes` takes `{ id: SandboxId, opts: EnsureOptions }` — the same
payload `ensure()` takes today — plus the placement fields from
[Placement](#placement) (`runtime`, `requires`, `allowFallback`), and returns:

```jsonc
{
  "handle": "myproj-1a2b3c",
  "workdir": "/app",
  "previewUrl": "https://myproj-1a2b3c.sandbox.deco.host",
  "daemon": { "url": "http://…:9000", "token": "…" },
  "runtime": "agent-sandbox",
  "capabilities": ["preview", "lifecycle-phases", "termination-reason", "ttl-extend"]
}
```

It returns only once the daemon is healthy and configured — same contract
`ensure()` has today, and the reason the config POST moves into the controller
rather than being left to Studio.

`daemon.token` is the piece Studio caches. On a 401 it re-GETs
`/sandboxes/:handle` — precisely the invalidate-and-retry the runner already
does inline (`runner.ts:761`).

Handles stay Studio-derived and are passed in, not minted by the controller:
`claim-handle.ts` recomputes them without a DB read to route preview traffic,
and a handle that can disagree with itself is a bug we already paid for.

`DELETE` blocking until the sandbox is actually gone is a **change from today**
— `runner.ts`'s `delete()` fires the claim deletion and returns, and callers
that need the resource fully collected call `waitForSandboxClaimGone`
separately. The rebind sequence depends on it (drain before create), and every
other caller either doesn't care or is already waiting.

The wait is **bounded**. `204` once the claim is collected; `202
{ "state": "draining" }` if the deadline passes with the claim still present —
a stuck finalizer, an unresponsive graceful push, a node going away. Never an
open-ended hold: this is called on a request path, and an unbounded `DELETE`
turns one stuck claim into a hung Studio request and a burnt DBOS step. `202`
means retry; it is **not** success, and a caller mid-rebind must not proceed to
`POST` on it — that is exactly the two-daemons-one-branch case the drain rule
exists to prevent.

`adoptLiveClaim` and `forgetHandle` do **not** appear: both manipulate the
runner's in-process cache, which after the split lives inside the controller and
is its own business. `forgetHandle`'s one caller
(`built-in-tools/cluster-sandbox-fs.ts:181`) becomes a no-op or a `DELETE`.

### Authentication

**Studio ↔ controller: mutual TLS.** Two long-lived peers, few of them, both
installed by the same deploy — the shape a key pair per side actually fits (the
SSH / GitHub-deploy-key model: each end is configured with its own key and the
other's public half at install, and revocation is deleting one entry). Strictly
better than one shared bearer, and it is what turns the callback below into an
*identity* rather than a password. ClusterIP-only on top, plus a network policy
where the platform allows one — the controller has exactly one client, so the
allowlist is trivial and worth having.

**Scope, since it is the first thing anyone asks** — three credentials, three
lifetimes, and only the first is global:

| credential | scope | lifetime | who ever sees it |
|---|---|---|---|
| Studio ↔ controller mTLS pair | one per **installation** | long-lived, rotated by hand | an operator, at install / in the UI |
| daemon bearer | one per **claim** (per sandbox) | ephemeral — rotated at first `/config` and on rehydrate/adopt | nobody; machine-to-machine only |
| daemon **sentinel** | one per **environment** (`studio-sandbox-sentinel-<env>`, baked into the SandboxTemplate) | until the first `/config` rotates it away, per pod | chart / deploy only |

The mTLS pair is global because its peers are the two *services*, not the
sandboxes — holding it lets you talk to the controller, never to a sandbox. The
sentinel is the weakest of the three and predates this document: every warm-pool
pod in an environment boots with the same bearer until its first `/config`.
Shortening that window is a warm-pool concern, not a controller one, but the
port must not widen it.

Per-sandbox *key pairs* were considered and rejected: the private half would
have to live inside the pod, and a warm-pool pod is recycled across tenants — so
the key would have to be reissued at claim time, which is the per-claim token
with a PKI bolted on.

**Studio ↔ daemon: unchanged, per-claim bearer. Do not extend mTLS there.** The
daemon token is deliberately *ephemeral*: the pod boots on the SandboxTemplate
sentinel, the first `/config` rotates it to the per-claim token, and
rehydrate/adopt rotate again — which is what stops a recycled warm-pool pod from
honouring the previous tenant's credential. A per-sandbox certificate swaps a
credential that expires by construction for one that needs CRL/OCSP or very
short lifetimes: the refresh problem back, with a PKI attached. It also cannot
be mandatory on that port, because `/_sandbox/{idle,events,scripts,decofile}` are
unauthenticated by design for callers that can carry no credential. Per-route
mTLS gives up the property that made it attractive in the first place.

### Daemon protocol

The controller POSTs `/_sandbox/config` (payload + `rotateToken`) and polls
`/health` during provision. Those structs live in the daemon today under
`daemon-go/internal/`. Promote the config/health/auth request+response types to
an exported `daemon-go/pkg/protocol` and have the controller import them via a
`replace` directive to `../daemon-go`.

One definition of the daemon's boot contract, compiler-checked on both ends —
this is the concrete payoff of both services being Go, and it retires the
duplicate hand-written shapes in `server/daemon-client.ts` +
`shared/build-config-payload.ts` for that path.

### Credentials, and the one callback

`mintCloneUrl` (`lifecycle.ts:173`) needs Studio's DB + vault, so it cannot move.
Two directions were available; take the pull one:

**The controller calls back to Studio.** One authenticated endpoint,
`POST /api/_sandbox-controller/clone-url { handle, bufferMs } → { cloneUrl }`,
hit by the credential refresher and the warm-pool reconciler. ~30 lines on each
side and the refresh loops keep working unmodified.

**The request names a handle, never a repo.** `mintCloneUrl`
(`lifecycle.ts:173`) dispatches on `repo.connectionId` into
`buildCloneInfo(connectionId, owner, name, db, vault)`, which carries no org
check — correctly, because its only caller today is in-process and already
scoped. A `{ repo, connectionId }` parameter would make this a credential
oracle: whoever reaches the endpoint mints a live GitHub App token for **any
connection in the deployment**, across orgs. So Studio resolves handle → recorded
repo/connection from the row it owns, and the controller never chooses. The
warm-pool path is the same rule keyed by pool name, resolved against the pool
config Studio holds.

**Not under `/api/_admin`.** That prefix is the human deployment-admin surface,
with impersonation and audit semantics (`admin.ts:38`). A machine peer on a
different auth model does not belong behind the same middleware — its own
namespace, its own credential, and the mTLS peer identity above is what
authorizes it.

Push-based (Studio proactively rotating every live sandbox on a timer) was the
alternative; it needs Studio to enumerate the controller's sandboxes and
duplicates the scheduling the controller already does. Not worth it.

The deployment cycle (Studio → controller → Studio) is fine; it is two HTTP
calls, not a startup dependency.

### State

The controller owns `sandbox_runner_state` **exclusively** and Studio stops
reading it (`KyselySandboxProviderStateStore` is reimplemented in Go over
`pgx`). No data migration, no new database: point the controller at the same
`DATABASE_URL`, with the table as the ownership boundary. If it ever needs its
own database, the table travels with it.

The row records the **chosen runtime** (`sandbox_provider_kind` already exists
and already carries a runner kind — widen its accepted values rather than adding
a column) and is what every post-create call routes on. A row whose runtime
string is unknown to this build is left alone and reported as unreachable, never
re-placed: an unrecognized runtime means a rollback or a config change, and the
sandbox it points at is still out there.

Schema migrations for that table stay in `apps/api/migrations/` for now — one
migration runner, and the table is not changing shape. Move them only if the
controller starts evolving it.

Do not make the controller stateless-and-reconstruct-from-k8s: the per-claim
daemon token is not recoverable from a claim.

**The cutover is a drain, not a rolling deploy.** `STUDIO_SANDBOX_PROVIDER` is
per-pod, so a rolling restart runs both implementations side by side for
minutes. Handles are deterministic, so an old-code pod *will* `rehydrate`/`adopt`
a claim the controller owns and rotate its daemon token; the controller's cached
token then 401s, its retry rotates back, and the two ping-pong across every live
sandbox for the length of the deploy. Two defences, take both:

- the row records its **writer**, and the in-process runner refuses (and logs) a
  row it does not own — cheap now, miserable to diagnose in prod later;
- the flip is a drained cutover.

### The housekeeper is a third writer

`deploy/helm/sandbox-env/templates/sandbox-housekeeper.yaml` is a CronJob with
its **own** ServiceAccount holding `sandboxclaims: get,list,patch,delete`,
`pods: list,delete` and `httproutes: list,delete` in the same namespace. It is
not part of Studio, it does not move, and it is not optional to reason about:

- **Claims and HTTPRoutes vanish underneath the controller**, patched or deleted
  by someone else, at any time. Today's runner tolerates that; the
  informer-backed version must too. A lister miss is normal, not an invariant
  violation — reconcile the state-store row to "gone", never treat it as
  corruption.
- **Its orphan-HTTPRoute GC will collect routes the controller mints** if they
  are ever briefly parentless. Keep today's ordering: claim first, route second.
- **Idle TTL has three enforcers**, not two — the operator's
  `spec.lifecycle.shutdownTime`, the housekeeper's idle sweep (which can only
  shorten), and the controller's in-process timer under `docker`. Three
  implementations of one policy is survivable; three *definitions* is not. The
  window is a single controller-level config value and the housekeeper's chart
  value reads the same number.

---

## Runtimes

A runtime is one implementation of a Go interface mirroring `SandboxProvider`.
**All configured runtimes are live at once.** The controller registers each one
at boot, probes whether it is actually usable, and picks one per `POST
/sandboxes`. Selection is a runtime decision, not a deployment decision:
`agent-sandbox` full and Lambda healthy is a placement outcome, not a redeploy.

### Available today / planned

**`agent-sandbox`** — the port of today's runner, on the generated clientsets +
informers. Behavior-for-behavior with the TS version: named claims, template
resolution incl. the `-medium` probe, warm-pool sentinel + token rotation,
tenant pools, TTL patching, HTTPRoute minting (`sigs.k8s.io/gateway-api` typed
client), capacity probe, credential refresh.

Two details cheap to lose in translation and expensive to find again:

- **Keep `LEGACY_SSA_FIELD_MANAGER` and `force: true`** on both Server-Side
  Apply writes (`client.ts:802` HTTPRoute, `client.ts:932` the
  `spec.ports[name=daemon]` patch). `force` is the reason a fresh field-manager
  name would not break the first apply after cutover; drop it and the apply
  409s, the HTTPRoute stays "Accepted" with no Envoy cluster behind it, and the
  browser misreports the resulting empty 500 as CORS.
- **`previewUrlPattern` is today's prod/dev discriminator inside the runner, not
  a runtime identity.** "Am I in a cluster with a preview gateway" and "which
  runtime am I" are separate questions; the registry answers only the second.
  Conflating them is how the port quietly loses the kind path — see
  [Prerequisite](#prerequisite-studio-must-stop-port-forwarding), where that
  same flag becomes the port-forward gate.

**`docker`** — a container per handle from the published `studio-sandbox`
image, daemon port 9000 published on a host port, `DAEMON_TOKEN` in env,
`previewUrl = http://127.0.0.1:<port>`. No operator, no warm pools, no
port-forward, no HTTPRoute; idle TTL is a `time.AfterFunc`. Shell out to the
`docker` CLI via `os/exec` — that is what the deleted TS provider did
(`docker-cli.ts`), it is ~150 lines and zero dependencies, and `DOCKER_HOST`
makes Docker Desktop / OrbStack / colima / Podman all work. Upgrade to the
Engine API over the socket only if we need events or stats.

This is a *runtime*, not a "dev mode" — dev is simply the deployment where it
is the only one whose probe passes.

**`lambda-microvm`** — not built. It is the reason the seam is where it is: it
needs a signed per-sandbox endpoint instead of a cluster DNS name (the
`daemon.url` field already accommodates that), it has no `ClaimPhase` equivalent
(the single-`ready`-phase degradation already covers that), and it has no warm
pool and no OOM verdict — which is what the capability flags below are for.

### Declaration

```
GET /runtimes
```

```jsonc
{
  "runtimes": [
    {
      "name": "agent-sandbox",
      "available": true,                  // probe passed
      "capacity": { "schedulable": true, "observedAt": "…" },
      "capabilities": ["preview", "lifecycle-phases", "warm-pool",
                       "termination-reason", "ttl-extend"],
      "priority": 10
    },
    { "name": "lambda-microvm", "available": false, "reason": "not configured" }
  ]
}
```

**Capabilities are not a new taxonomy** — they are the optional methods
`SandboxProvider` already has (`lastTermination`, `renewTtl`, `releaseAfter`,
`hasSchedulableCapacity`, granular `watchClaimLifecycle`, a non-null
`previewUrl`), declared as data instead of discovered by calling and getting
`undefined`. Adding a capability means adding an optional method; if it doesn't
correspond to one, it doesn't belong in the list.

`available` is *probed*, not configured: kubeconfig/in-cluster credentials
resolve and the CRD is served; the Docker socket answers; the Lambda credentials
are present. Re-probed on a timer and on failure, so a runtime coming back
doesn't need a restart. The set of runtime *types* is compiled in — adding one
is new code either way, so hot-reloading the set is YAGNI.

### Placement

**Studio sends `runtime` on the request.** It is an opaque string Studio carries
from config (today) or an org flag (when per-org pinning lands) — Studio chooses
*which* runtime, the controller decides whether that is currently possible.
`requires` (capability names) may accompany it.

**A named runtime is a hard constraint, not a preference**: if it is
unavailable, lacks a required capability, or is full, the answer is `503` with
the reason — never a silent placement somewhere else. An org pinned to a runtime
is usually pinned for a reason (data residency, cost, isolation), and quietly
honoring the opposite is worse than not serving. Fallback is opt-in per request
(`allowFallback: true`) and is what an unpinned request gets by default.

When no runtime is named (or fallback is allowed):

> Walk the configured runtimes in priority order. Skip any that is unavailable,
> lacks a required capability, or reports no capacity. Take the first that
> remains.

That is the whole policy. No scoring, no bin-packing, no cost model — a static
priority list plus the capacity probe that already exists gives the behavior
actually being asked for (cluster full → spill to Lambda; Lambda-only org →
pin), and anything cleverer can't be tuned without data we don't collect yet.

`503` with the per-runtime reasons when nothing qualifies — the caller parks,
exactly as `hasSchedulableCapacity() === false` makes it park today.

**Placement happens once.** The chosen runtime is persisted with the handle, and
every later call (`GET`, `DELETE`, `/lifetime`, `/credentials`, `/events`)
routes by the stored value — never re-decides, never re-probes. This is the same
rule Studio already follows for teardown: *"SANDBOX_DELETE dispatches on the
entry's recorded `sandboxProviderKind` (not env), so a pod that flipped
`STUDIO_SANDBOX_PROVIDER` between start and stop still tears down the right kind
of sandbox"* (`apps/api/src/sandbox/lifecycle.ts:1`). A handle whose runtime can
be re-decided is a leaked sandbox on the runtime nobody looks at any more.

Corollaries:

- **A handle belongs to exactly one runtime at a time.** `ensure` is idempotent
  by handle: if the handle exists on runtime A and the request names B, it
  returns the live A sandbox with `"runtimeMismatch": "lambda-microvm"` so the
  caller can offer the switch. It does **not** switch on its own — see below.
- **No failover after create.** Fall through to the next runtime only *before*
  anything has been provisioned. A create that fails half-way is deleted and
  surfaced, not retried elsewhere — retrying a partial create is how you get two
  pods for one handle, which is a bug this codebase has already paid for.

### Switching a handle's runtime

A sandbox's durable state lives **outside** the sandbox — the repo in GitHub and
the org-fs volumes — so a handle is not married to the runtime it was first
placed on. Switching is supported, and it needs no new endpoint: it is
`DELETE /sandboxes/:handle` followed by `POST /sandboxes` naming the new
runtime. Both already exist and both already have the right semantics.

**What survives** is what was already outside: committed and pushed git state —
`DELETE` is a graceful teardown, and the graceful path is the one where the
daemon publishes the working tree to git (`daemon-go/internal/gitx`) — plus the
org-fs mounts, which the new sandbox reattaches.

**What does not** is everything the pod was: the working tree that failed to
push, the dependency install, the running dev server, any in-flight harness run,
the daemon token, and open SSE consumers. A switch is a **cold boot**, priced
like a first provision. Call it a rebind, not a migration; nothing moves.

Rules that make it safe:

- **Never implicit.** A placement input changing — an org flag flipped, the
  cluster momentarily full, a runtime's probe blinking — must not move a running
  sandbox. It would kill a live dev server and an in-flight run to save a
  routine `ensure`. The switch happens because a caller asked for it in as many
  words, which is what makes `DELETE` + `POST` the right shape: the caller
  cannot get there by accident.
- **Drain before create, never overlap.** Two daemons alive on one handle would
  both hold the same git branch — the double-writer case the daemon's dispatch
  invariant exists to prevent ("two `claude` processes never share one
  checkout", `daemon-go/README.md`). `DELETE` returns only once the old sandbox
  is gone.
- **A failed push aborts the switch.** If the graceful teardown cannot publish,
  the work is only in that pod; deleting it anyway is data loss. Surface it and
  let the caller decide.
- **No in-flight run.** Studio checks before offering the switch; the run would
  die at the teardown either way, and a `done`-less stream is the one thing
  consumers are told means "the connection died, not the run".
- **Capability check.** Don't rebind onto a runtime lacking a capability this
  sandbox is using — a preview-less runtime for a sandbox with a live preview.

The window between `DELETE` and `POST` is a handle that does not exist, which is
not a new state: it is exactly what an idle-TTL eviction leaves behind, and
Studio's existing reprovision path already covers it.

### Capacity

`GET /capacity` stays, and stays what Studio's admission gate reads: an
aggregate — `schedulable: true` if *any* runtime that could serve the request
has room. Per-runtime detail lives in `/runtimes`.

Capacity is read from each runtime with a short-TTL cache (seconds), never
per-request-per-backend: the `agent-sandbox` probe is a K8s read
(`capacity.ts` — "nothing is currently unschedulable", the scheduler's own
verdict, not a forecast from node capacity) and `docker`'s is local. Keep the
same semantics for any new runtime: `true` is "nothing is currently
unplaceable", never a reservation.

### What Studio sees

Studio **names** the runtime and reads back which one was used
(`"runtime": "agent-sandbox"`) — but it treats the name as an opaque string it
carries from configuration, never as a value to branch on. Passing through a
configured string is not the same as `if (runtime === "lambda-microvm")`; the
first keeps the seam, the second means the next runtime is a Studio change
again.

Where Studio legitimately varies behavior, it reads `capabilities`, not the
name: don't render a preview tab for a runtime without `preview`, don't offer
"why did it stop" without `termination-reason`. That way a runtime we haven't
written yet gets correct UI for free.

Adding a runtime should touch: the controller (new implementation), and
whatever sets the org flag. Nothing else.

---

## Dev

```
bun run dev
├─ postgres, nats                 (as today)
├─ apps/api                       (as today, STUDIO_SANDBOX_PROVIDER=remote)
├─ apps/web                       (as today)
└─ go run ./packages/sandbox/controller-go
   └─ docker runtime (the only one whose probe passes here):
      one studio-sandbox container per sandbox
```

No docker-compose: the controller is one more child process of
`apps/api/src/cli.ts dev`, and only the *sandboxes* are containers. A
contributor needs a container runtime only to run a sandbox.

Nothing is set to "docker mode": the k8s runtime's probe fails (no kubeconfig,
no CRD), the docker runtime's passes, and placement has exactly one candidate.
A contributor who *does* have a cluster kubeconfig gets both, and can pin with
`runtime` while testing.

**No `dev:minimum` script.** One degradation rule, two triggers — **no Go
toolchain, or no runtime whose probe passes**: the dev runner logs one line,
skips the controller, and Studio answers every sandbox tool with a 503 carrying
"sandbox backend unavailable — install Docker/OrbStack (and Go), or ignore this
if you're only working on the UI". Someone working on the web app never notices;
someone who needs a sandbox is told exactly what to do. A second command is a
second thing to know about and to keep working.

Go being a new prerequisite is the one real dev-experience cost of this
decision. Shipping a prebuilt controller binary per platform from the release
workflow would remove it — deferred until someone actually asks, because
`go run` from source is what you want while iterating on the controller anyway.

Prod: one Deployment in the same cluster and namespace pattern as Studio, with
the RBAC that Studio's ServiceAccount currently holds — and Studio's is dropped
in the same PR that flips the flag off. It must never be internet-reachable: a
caller with the bearer token can start containers with arbitrary env.

---

## Rollout

Sequenced so the new-code risk lands before the port risk, and prod keeps its
current path until the Go one has earned it.

1. **Kill the production port-forward** — TypeScript, in today's `runner.ts`.
   See [Prerequisite](#prerequisite-studio-must-stop-port-forwarding). This is
   the change that earns reason (a); it is independent of everything below and
   separately revertable. Land and bake it first, against the implementation we
   already trust.
2. **Contract + `RemoteSandboxProvider`.** Define the HTTP shape, implement the
   TS client in Studio behind `STUDIO_SANDBOX_PROVIDER=remote`, with mTLS on the
   wire from the first commit — transport auth retrofitted is transport auth
   never shipped. Default stays `agent-sandbox` in-process. Nothing in prod
   changes.
3. **Go controller with the `docker` runtime as its only registered one.** All
   new code, no port, immediately useful: it is what makes `bun run dev` grow a
   sandbox again after #5570, and it gives the black-box e2e a real runtime to
   run against with no cluster. The registry, probing, `/runtimes` and placement
   land here — with one runtime, where they are trivial to get right — not later
   under the pressure of a second one.
4. **Port the `agent-sandbox` runtime.** The long pole. Validate against the
   same e2e suite plus the existing TS unit tests read as a specification —
   `runner.test.ts`, `client.test.ts`, `tenant-pools.test.ts`,
   `lifecycle-watcher.test.ts` are the behavior ledger.
5. **Staging, then a drained production cutover** — not a rolling deploy, see
   [State](#state) — then delete the in-process `agent-sandbox` case from
   `lifecycle.ts`, the `@kubernetes/client-node` dependency, and the Studio Role
   + RoleBinding in `sandbox-env`. Until that deletion lands this has made things
   *worse* (two implementations) — do not leave it half-done.
6. **Lambda microVM backend**, when someone actually needs it.

### Testing

Same black-box contract shape as `packages/sandbox/daemon-e2e/`: spawn the built
binary, drive it over HTTP, assert on responses — with `SANDBOX_BACKEND=docker`
that is a real sandbox provisioned in CI with no cluster, which does not exist
today. Backend-internal logic (claim building, pool resolution, template probe,
handle-to-service resolution) gets ordinary Go table tests; `client-go`'s
`fake.NewSimpleClientset` covers the K8s paths without a cluster.

Studio's `RemoteSandboxProvider` gets one e2e against a controller running the
docker backend.

---

## Explicitly not doing

- **A generic multi-tenant sandbox platform.** One client (Studio), one bearer
  token, tenant identity passed through as data. Authorization stays in Studio,
  where the org model lives.
- **gRPC / protobuf / a generated SDK.** JSON over HTTP; the two sides are one
  repo and one team.
- **A real Kubernetes controller.** No CRD of our own, no reconcile loop, no
  controller-runtime manager. It is an HTTP service that happens to use
  informers as a cache. The name is aspirational; see open question 1.
- **Building on `clients/go/sandbox.Client`.** Generated clientsets + API types
  only — see [What Go does not give us](#what-go-does-not-give-us).
- **A scheduler.** Placement is a priority list filtered by availability,
  capability and capacity. No bin-packing, no cost model, no per-tenant quota,
  no automatic rebalancing.
- **Live migration.** Switching a handle's runtime is a graceful teardown and a
  cold boot around durable external state (see
  [Switching a handle's runtime](#switching-a-handles-runtime)). Nothing is
  moved, and no snapshot/restore of a running pod is in scope.
- **Proxying daemon traffic through the controller.** Revisit only if a runtime
  appears whose daemon Studio genuinely cannot reach.
- **mTLS to the daemon**, and any PKI. The per-claim bearer is the stronger
  model there; see [Authentication](#authentication).
- **Splitting the daemon's control-plane port from 9000.** The right follow-up,
  but a daemon change, tracked separately.
- **Moving handle derivation, preview edge behavior, or credential minting.**
- **Its own database.** Same Postgres, one owned table.

---

## Open questions

1. **Name.** `sandbox-controller` matches how we talk about it but implies a K8s
   reconcile loop we are explicitly not building. `sandbox-broker`?
2. **Does `user-desktop` survive #5570?** If any form of it remains, it stays in
   Studio (bound per-run to the acting user's claim, no infrastructure API) —
   the controller is not the right home for it.
3. **Preview in the docker backend.** `http://127.0.0.1:<port>` works but loses
   per-sandbox hostnames; the deleted tree had a `*.localhost:7070` local
   ingress (`local-ingress.ts`) for exactly this. Ports until someone hits a
   cookie/CORS problem.
4. ~~**Idle TTL ownership.**~~ Resolved — it is three enforcers, not two, and
   the rule is one definition in one config value. See
   [The housekeeper is a third writer](#the-housekeeper-is-a-third-writer).
5. **Operator API version.** We pin `v1alpha1`; upstream v0.5.x also ships
   `v1beta1` with a conversion (`extensions/api/v1beta1/sandboxclaim_conversion.go`).
   Port against `v1alpha1` to keep the change one-variable, then move in a
   separate step. Confirm which version the operator we deploy
   (`deploy/helm/sandbox-operator`, chart 0.1.4) actually serves before pinning
   the clientset.
