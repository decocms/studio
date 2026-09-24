# Sandbox controller and image variants

Status: proposal, revised 2026-09-24. Progress is tracked in
`controller-work.md`. Merges two documents:

- `image-variants-spec.md`, now deleted (#7461, #7469 — shipped: per-repository image,
  Android variant, Flutter moved off the base image);
- `sandbox-controller-spec.md` from #6187 (`origin/feat/sandbox-controller-go`,
  built and verified against k3s, closed unmerged as stale on 2026-08-31).

This document is the **open-source** half. The closed half is a feature of
the existing hosting control plane, `decocms/control-plane`, described in
`control-plane-variants-spec.md`. There is no separate
`decocms/sandbox-control-plane` repository.

## The line: claim path open, fleet management closed

> A self-hoster running Studio, the `sandbox-env` chart and the controller from
> this repo gets working sandboxes — variants included — with no deco service
> in the loop. And a control-plane outage on deco's clusters cannot block a
> claim.

That rule puts every component into one of two places:

| component | where | why |
|---|---|---|
| Studio: tools, handles, dispatch, preview edge, credential minting, `SandboxProvider`, `RemoteSandboxProvider` | studio (OSS) | tenant concepts |
| **Sandbox controller** (`packages/sandbox/controller-go/`): claims, `SandboxVariant` reconciliation, template resolution, daemon config + token, lifecycle, runtimes | studio (OSS) | on the claim path |
| **`SandboxVariant` CRD** — schema and reconciler | studio (OSS) | the one contract both sides write against |
| Daemon, base image, `daemon-go/pkg/protocol` | studio (OSS) | on the claim path |
| `sandbox-env` chart: operator RBAC, default template + pools, gateway, housekeeper; `imageVariants` values emitted as `SandboxVariant` objects | studio (OSS) | how a self-hoster declares everything, variants included |
| **Variants feature of `decocms/control-plane`**: desired variants per cluster, prewarming, CI entry point, console tab | `decocms/control-plane` (closed) | fleet management across clusters; off the claim path |
| Variant Dockerfiles + smoke tests + CI | `decocms/infra_applications` | customer-shaped toolchains |

The controller and the control plane never call each other. They meet in the
cluster, through two **open contracts** that this document owns:

1. **The controller HTTP API** — what Studio speaks ([API](#api)).
2. **The `SandboxVariant` resource** — a small, namespaced object that says
   "this cluster offers variant *v*, built from image *x*, scheduled like
   *y*" ([SandboxVariant](#sandboxvariant)). The chart writes it for
   self-hosters, `kubectl apply` writes it, and on deco's clusters the
   control plane's agent writes it. Only the controller reads it, and only
   the controller turns it into templates and pools.

Why a resource and not "the control plane imports the controller": the
control plane is TypeScript and the controller is Go, so no code is shared.
The CRD schema is the package both sides depend on, and it works across
languages and across a license boundary. It also puts the render — the part
that has to copy the default template exactly — in one open-source place,
instead of in both a Helm helper and a closed service.

This is the hosting stack's own shape, not a new one. There,
`decocms/control-plane` renders `deco.sites` CRs as pure functions, records
them per cluster, and a Go data-plane agent in each cluster applies them for
`decocms/operator` to reconcile. Here the control plane renders
`SandboxVariant`s, the same agent applies them, and the sandbox controller is
the operator. "The control plane uses the controller" means exactly that
relation.

**Typed package.** The studio repo publishes `@decocms/sandbox-controller-types`
from `packages/sandbox/controller-types/`: TypeScript types for
`SandboxVariant` (spec and status) and for the controller's HTTP API,
generated from the Go types so Go stays the source of truth. CI fails when
the generated file is stale. The control plane renders against these types,
so a schema change breaks its build instead of failing in a cluster.
`RemoteSandboxProvider` uses the same package for the API types.

Why not a `DecoSandbox` resource wrapping claims: `ensure` is a synchronous
call that must return a daemon token, the token has no safe home in a CR
(warm-pool claims already cannot carry `secretKeyRef`), and it would stack a
second custom resource and reconcile hop on top of `SandboxClaim` on every
start. Claims stay HTTP; cluster configuration becomes a resource.

The controller is **Go**: it shares `daemon-go/pkg/protocol` with the daemon
(one boot contract, a compile error on both ends), uses the upstream generated
clientsets, and is already built. The name question from #6187 is settled by
this document: the OSS process is the **sandbox controller**, and with a
`SandboxVariant` reconciler it is now a controller in the Kubernetes sense
too.

---

## What exists today

**In Studio, in-process:** `AgentSandboxProvider`
(`packages/sandbox/server/provider/agent-sandbox/`, ~5.6k non-test lines:
`runner.ts`, `client.ts`, `lifecycle-watcher.ts`, `tenant-pools.ts`,
`capacity.ts`, `credential-refresh.ts`). It creates/deletes `SandboxClaim`s and
per-claim `HTTPRoute`s with Studio's ServiceAccount, keeps an in-memory
`records` map over `sandbox_runner_state`, runs the reaper, credential
refresher and tenant-pool reconciler in the Studio pod, port-forwards to the
daemon for every control call, and POSTs `/_sandbox/config` + token rotation
before `ensure()` returns.

The caller surface is much smaller than the implementation:

| call | sites |
|---|---|
| `proxyDaemonRequest` | 10 (8 files; excludes tests) |
| `ensure` | 1 (`tools/sandbox/start.ts`) |
| `alive`, `getPreviewUrl`, `hasSchedulableCapacity`, `watchClaimLifecycle`, `forgetHandle`, `renewTtl`, `resolvePreviewUpstreamUrl`, `proxyPreviewRequest` | 1 each |

**Image variants, shipped (#7461, #7469):**

- `repositories.sandbox_image` (migration 224), `NULL` = default.
  `SandboxImageSchema` is a validated string (`/^[a-z][a-z0-9-]{0,31}$/`),
  not an enum; Studio never learns the word `android`.
- `EnsureOptions.sandboxImage`, persisted with the claim so a resurrected
  claim lands on the same image.
- Template name `<base>-<variant>[-medium]`, probed per name with the TTL
  cache, degrading to the base template with a warning when the cluster lacks
  it. A non-default image opts out of tenant pools.
- Chart 0.18/0.19: `imageVariants.<name>` renders both template sizes plus two
  size-0 `SandboxWarmPool`s, with per-variant `nodeSelector`, `tolerations`,
  `resources`, `volumeSizes`.
- `packages/sandbox/image-android/` and its release job; Flutter lives only
  there. `skills/flutter-app/SKILL.md` stays in the base skill folder: on the
  default image it is what tells the agent to ask for the Android image.

**Controller, built on #6187:** `controller-go/` (`agentsandbox/`,
`runtime/`, `protocol/`, `store/`, `server.go`), `controller-e2e/`,
`RemoteSandboxProvider` behind `STUDIO_SANDBOX_PROVIDER=remote`,
`daemon-go/pkg/protocol`. Verified on k3s end to end, including Service-DNS
reachability from inside a Studio pod. Its remote branch is deleted; the
code survives on the local ref `origin/feat/sandbox-controller-go`. It
predates ~28 runner changes on main and main's removal of
`STUDIO_SANDBOX_PROVIDER` (Studio now has one in-process provider gated by
`agentSandboxEnabled`), so its TypeScript side is a rewrite, not a rebase.
It is a reference for Phase 3, not a Phase 1 input; the port ledger is in
`controller-work.md`.

---

## SandboxVariant

```yaml
apiVersion: sandbox.deco.cx/v1alpha1
kind: SandboxVariant
metadata:
  name: studio-sandbox-prod-android   # <baseTemplate>-<variant>; the rendered template's name
  namespace: agent-sandbox-system     # same namespace as the templates
  labels:
    app.kubernetes.io/managed-by: deco-data-plane-agent   # or Helm, or unset
spec:
  baseTemplate: studio-sandbox-prod   # the default template it copies; -medium is implied
  image: { repository: ghcr.io/decocms/studio/studio-sandbox-android, tag: "1.40.2" }
  baseTag: "1.40.2"                   # base image tag the variant was built FROM
  nodeSelector: { decocms.com/nodepool: sandbox-android }   # replaces the default's
  tolerations: [ { key: decocms.com/sandbox-android, operator: Equal, value: "true", effect: NoSchedule } ]
  resources:                          # deep-merged over EACH size's own resources
    requests: { cpu: "2", memory: 8Gi }
    limits: { decocms.com/kvm: "1" }  # a device-plugin resource, not a hostPath
  volumeSizes: { home: 24Gi, workdir: 8Gi }   # merged over the default template's
  warmPool: { size: 0, mediumSize: 0 }
status:
  conditions:
    - type: ImageAvailable            # registry HEAD on repository:tag
    - type: Rendered                  # the 4 objects match the spec + default template
    - type: Ready
  observedGeneration: 3
  defaultTemplateTag: "1.41.0"        # so base-tag skew is readable from the object
  templates: [ studio-sandbox-prod-android, studio-sandbox-prod-android-medium ]
```

**Reconcile.** The controller watches `SandboxVariant`s and the default
`SandboxTemplate`. The name carries the base because stg and prod templates
share `agent-sandbox-system` and differ only by `envName`: a bare `android`
would collide across environments. The variant Studio stores in
`sandbox_image` is the part after `<baseTemplate>-`, validated by CEL
(`/^[a-z][a-z0-9-]{0,31}$/`, not `medium` or `*-medium`, which would collide
with `-medium` templates). For each variant the controller renders four objects —
`<base>-<v>`, `<base>-<v>-medium` and a `SandboxWarmPool` for each — copying
everything except image and scheduling from the **live** default template,
so a variant cannot drift in security context, mounts, env or ports. A change
to the default template re-renders every variant.

- Writes are Server-Side Apply under the controller's field manager, with
  `force: true`, and every rendered object carries an `ownerReference` to its
  `SandboxVariant`. Deleting the variant garbage-collects the four objects;
  nothing else has to clean up.
- Rendered objects keep the names the chart renders today
  (`<base>-<v>[-medium]`), so the in-process runner's name probe keeps
  working until the claim cutover. They also carry a new label,
  `sandbox.deco.cx/variant=<v>`, which the chart does not write today; it is
  what lets a lister find variants without knowing their names.
- **Image check before render.** A registry `HEAD` on `repository:tag`, using
  the default template's `imagePullSecrets`. Missing tag → `ImageAvailable=False`
  and the **previous** render stays in place: `Rendered=False`, `Ready`
  stays `True` while the old templates serve. A registry error is
  `ImageAvailable=Unknown`, retried in a minute, never "missing". A template whose image does not
  exist is `ImagePullBackOff` at claim time, not a clean degrade, so this is
  the one check worth making before writing. `latest` is rejected by schema.
- Size-0 pools are rendered rather than omitted, so prewarming is a field
  change.

**Writers.** Anyone may write a `SandboxVariant`; `managed-by` records who
(`Helm` for the chart, `deco-data-plane-agent` for the control plane, which
the agent stamps on everything it applies and is the only thing its prune
sweeps), and a writer does not touch an object another writer manages. That rule is
what lets a deco cluster move `android` from the chart to the control plane
(see [Rollout](#rollout)). The rendered templates always belong to the
controller.

**Scope.** Only the `agent-sandbox` runtime reads `SandboxVariant`s. The
`docker` runtime keeps a static `<name> → image` map in its config: there
are no nodes to select on one machine.

**The CRD** ships in the controller's chart (`crds/`), versioned with the
controller. `v1alpha1` until a second writer outside deco exists.

---

## Controller

### Control plane only

The controller answers *where* a sandbox's daemon is and *what token opens
it*. Studio's existing `proxyDaemonRequest` dials the pod; the controller
never carries daemon bytes. Preview traffic already bypasses Studio via the
per-claim `HTTPRoute`. This deletes streaming relay, SSE passthrough,
WebSocket upgrade and backpressure before they are written.

With a preview gateway (`previewUrlPattern` set) the daemon address is
in-cluster Service DNS: `http://<sandbox>.<ns>.svc.cluster.local:9000`.
Without one (kind), the controller holds a port-forward and returns
`http://127.0.0.1:<port>`, correct exactly when controller and Studio share
a host.

`ensureServicePort` is gated on `previewUrlPattern`, **not** on the gateway:
a ports-less Service routes nothing, through Envoy or kube-proxy, so Service
DNS needs the port whether or not a gateway exists. (The TS runner could
conflate the two because it only ever reached the daemon by port-forward.)

Killing Studio's production port-forward in `runner.ts` first — the
prerequisite in #6187 — is moot rather than done: under `remote` Studio has
no port-forward, and hardening the TS runner would harden code the cutover
deletes.

**Known exposure, not fixed here:** the per-claim `HTTPRoute` publishes port
9000, which also serves `/_sandbox/*`. Every mutating route is gated by the
per-claim bearer (audited). The real hardening is a second daemon port for
`/_sandbox/*` that the route does not publish, leaving 9000 for preview and
the four deliberately unauthenticated Fast-Preview routes
(`/_sandbox/{idle,events,scripts,decofile}`). That is a daemon change, tracked
separately.

### API

JSON over HTTP, ClusterIP-only. `net/http` + `encoding/json`; no framework,
no gRPC.

```
POST   /sandboxes                       ensure (idempotent by handle)
GET    /sandboxes/:handle               alive + preview + daemon address + last termination
DELETE /sandboxes/:handle               delete; bounded wait for gone
PATCH  /sandboxes/:handle/lifetime      { extendToIdleWindow } | { graceMs }
POST   /sandboxes/:handle/credentials   rotate the clone credential in place
GET    /sandboxes/:handle/events        SSE of ClaimPhase → watchClaimLifecycle
GET    /images                          variants this cluster renders, per runtime
GET    /runtimes                        runtimes, availability, capacity, capabilities
GET    /capacity                        { schedulable } — aggregate
GET    /healthz
```

`POST /sandboxes` takes `{ id: SandboxId, opts: EnsureOptions }` — the payload
`ensure()` takes today, `sandboxImage` included — plus `runtime`, `requires`,
`allowFallback` ([Placement](#placement)). It returns once the daemon is
healthy and configured:

```jsonc
{
  "handle": "myproj-1a2b3c",
  "workdir": "/app",
  "previewUrl": "https://myproj-1a2b3c.sandbox.example.com",
  "daemon": { "url": "http://…:9000", "token": "…" },
  "runtime": "agent-sandbox",
  "image": { "requested": "android", "served": "android" },
  "capabilities": ["preview", "lifecycle-phases", "termination-reason", "ttl-extend"]
}
```

- `daemon.token` is what Studio caches; on a 401 it re-GETs
  `/sandboxes/:handle` (the invalidate-and-retry `runner.ts` does inline).
- Handles stay Studio-derived and are passed in: `claim-handle.ts`
  recomputes them without a DB read to route preview traffic.
- `image.served` differing from `requested` is the degrade, made visible to
  Studio instead of only logged ([Images](#images)).
- `DELETE` waits, **bounded**: `204` once the claim is collected; `202
  { "state": "draining" }` past the deadline (stuck finalizer, a graceful
  push that hangs, a node going away). `202` means retry, not success; a
  caller mid-rebind must not `POST` on it. This changes today's
  fire-and-return `delete()`.
- `adoptLiveClaim` and `forgetHandle` disappear: both manipulate the runner's
  in-process cache, which becomes the controller's business.
  `forgetHandle`'s one caller (`cluster-sandbox-fs.ts`) becomes a no-op.

### Daemon protocol

The controller POSTs `/_sandbox/config` (payload + `rotateToken`) and polls
`/health`. Those types live in `daemon-go/pkg/protocol`, the daemon's first
exported package; `internal/config` aliases them. The controller imports it
via `replace ../daemon-go`. Retires the hand-written duplicate in
`server/daemon-client.ts` + `shared/build-config-payload.ts` for the config
path.

### Authentication

| credential | scope | lifetime | who sees it |
|---|---|---|---|
| Studio ↔ controller mTLS pair | one per installation | long-lived, rotated by hand | an operator, at install |
| daemon bearer | one per claim | rotated at first `/config` and on rehydrate/adopt | nobody; machine-to-machine |
| daemon sentinel | one per environment, baked into the template | until the first `/config` | chart / deploy only |

mTLS from the first commit of the contract: transport auth retrofitted is
transport auth never shipped. It is also what makes the callback below an
identity instead of a password. ClusterIP-only, plus a NetworkPolicy
allowing exactly one client, where the platform supports it.

**Studio ↔ daemon stays a per-claim bearer. No mTLS there.** The token
expires by construction: a recycled warm-pool pod stops honouring the
previous tenant's credential at rotation. A per-sandbox certificate trades
that for revocation, and cannot be mandatory on a port whose Fast-Preview
routes are unauthenticated by design. Per-sandbox key pairs were rejected
for the same reason: the private half would live in a pod recycled across
tenants.

The sentinel window (every warm pod in an environment shares a bearer until
its first `/config`) predates this document. The port must not widen it.

### Credentials: the one callback

`mintCloneUrl` needs Studio's DB + vault, so it stays in Studio. The
controller pulls:
`POST /api/_sandbox-controller/clone-url { connectionId, cloneUrl, bufferMs } → { cloneUrl }`,
hit by the credential refresher and the warm-pool reconciler.

Studio verifies the pair against a live sandbox row or a configured warm
pool before minting. That is the as-built deviation from the original
"name a handle" design: `withFreshCloneUrl` has five call sites, two of them
warm-pool paths with no handle. The verification closes the same oracle —
you can only refresh credentials for a repo a sandbox already has — without
which `buildCloneInfo` (no org check, correctly, for an in-process caller)
would mint a GitHub App token for any connection in the deployment.

Not under `/api/_admin`: that is the human admin surface with impersonation
and audit semantics. A machine peer gets its own namespace, authorized by
the mTLS identity.

### State

The controller owns `sandbox_runner_state` **exclusively**, over `pgx`, on
the same `DATABASE_URL`, with the table as the ownership boundary. Studio
stops reading it. Migrations stay in `apps/api/migrations/` while the shape
is unchanged (and must be registered in `migrations/index.ts`).

The row records the chosen **runtime** (widen `sandbox_provider_kind`'s
values, no new column), the **image served**, and its **writer**. A row whose
runtime this build does not know is left alone and reported unreachable,
never re-placed.

Stateless-over-CRs does not work here, unlike for templates: the per-claim
daemon token is not recoverable from a claim.

**The cutover is a drain, not a rolling deploy.** `STUDIO_SANDBOX_PROVIDER`
is per pod. During a rolling restart an old pod rehydrates a claim the
controller owns and rotates its token; the controller's retry rotates it
back; the two ping-pong across every live sandbox for the length of the
deploy. Defences, both: the in-process runner refuses (and logs) a row whose
writer is not itself, and the flip is drained.

### The housekeeper is a third writer

`sandbox-housekeeper.yaml` is a CronJob with its own ServiceAccount
(`sandboxclaims` get/list/patch/delete, `pods` list/delete, `httproutes`
list/delete). It stays in the chart. Consequences:

- Claims and routes vanish under the controller at any time. A lister miss is
  normal: reconcile the row to "gone", never treat it as corruption.
- Its orphan-route GC collects any route that is briefly parentless. Keep the
  ordering: claim first, route second.
- Idle TTL has three enforcers — operator `shutdownTime`, the housekeeper's
  sweep (can only shorten), the `docker` runtime's timer. One definition:
  a single controller config value that the housekeeper's chart value reads.
- The housekeeper reaps on `/idle` and can only shorten. It is not what
  renews a claim; renewal stays with the viewer and hosted-harness paths.

### Runtimes

A runtime implements a Go interface mirroring `SandboxProvider`. All
configured runtimes are live at once; the controller registers each at
boot, **probes** it (credentials resolve and the CRD is served / the Docker
socket answers), re-probes on a timer and on failure, and places per
request. The set of runtime *types* is compiled in.

- **`agent-sandbox`** — the port of today's runner, on generated clientsets
  and informers. Behaviour for behaviour: named claims, template resolution
  including `-medium` **and variants**, warm-pool sentinel + rotation, TTL
  patching, HTTPRoute minting, capacity probe, credential refresh. Two
  details that are cheap to lose in translation:
  - keep `LEGACY_SSA_FIELD_MANAGER` and `force: true` on both Server-Side
    Apply writes (HTTPRoute, the `spec.ports[name=daemon]` patch). Without
    `force` the first apply after cutover 409s, the route stays "Accepted"
    with no Envoy cluster behind it, and the browser reports the empty 500
    as CORS;
  - `previewUrlPattern` is the prod/dev discriminator, not a runtime
    identity.
- **`docker`** — one container per handle, daemon port published on a host
  port, `DAEMON_TOKEN` in env, idle TTL as `time.AfterFunc`. Shells out to
  the `docker` CLI (`DOCKER_HOST` covers Docker Desktop / OrbStack / colima /
  Podman). This is the self-hoster's single-machine runtime and the dev
  runtime; the deleted TS provider (`git show ace365099^:…`) is a behaviour
  reference.
- **Further runtimes** (e.g. a microVM backend) — not built. The seam exists
  for them: `daemon.url` accommodates a signed per-sandbox endpoint, the
  single-`ready`-phase degradation covers no `ClaimPhase`, capabilities cover
  no warm pool / no OOM verdict. See [Closed runtimes](#closed-runtimes).

`GET /runtimes`:

```jsonc
{ "runtimes": [
  { "name": "agent-sandbox", "available": true, "priority": 10,
    "capacity": { "schedulable": true, "observedAt": "…" },
    "capabilities": ["preview", "lifecycle-phases", "warm-pool", "termination-reason", "ttl-extend"] },
  { "name": "docker", "available": false, "reason": "no docker socket" }
] }
```

Capabilities are the optional methods `SandboxProvider` already has
(`lastTermination`, `renewTtl`, `releaseAfter`, `hasSchedulableCapacity`,
granular `watchClaimLifecycle`, a non-null `previewUrl`) declared as data.
A capability that does not correspond to one does not belong in the list.

### Images

`GET /images` → per runtime, the variants it can serve:

- `agent-sandbox`: `SandboxVariant`s with `Ready=True`, from the informer
  cache, each with `baseTag` next to `status.defaultTemplateTag` so skew is
  visible to anything that renders the list.
- `docker`: the variants configured for it.

**Image is a preference; runtime is a constraint.** A requested image the
chosen runtime cannot serve degrades to the default image (today's
behaviour, now reported as `image.served`) rather than failing: the agent can
still work, and on the default image the skill tells it what is missing.
During placement, a runtime that *can* serve the image beats one that
cannot, before priority. A runtime named on the request still wins over the
image.

Studio's Settings → Repositories picker lists `GET /images` for the runtime
the org places on. Empty list: the field is hidden. Today the picker is
hardcoded to `default` and `android`
(`apps/web/src/views/settings/repositories.tsx`). Until the claim cutover it
lists `SandboxTemplate`s labelled `sandbox.deco.cx/variant` through the
in-process runner (Phase 1, step 5). Either way the source of truth is the
cluster the claim will hit.

### Placement

Studio sends `runtime` (an opaque configured string, later an org flag),
optionally `requires` and `allowFallback`.

- A named runtime is a **hard constraint**: unavailable, missing a required
  capability, or full → `503` with the reason. Never silently elsewhere; an
  org pinned to a runtime is pinned for a reason.
- Unnamed (or fallback allowed): walk runtimes in priority order, skip
  unavailable / incapable / full, prefer one serving the requested image,
  take the first. No scoring, no bin-packing.
- Nothing qualifies → `503` with per-runtime reasons; the caller parks, as
  `hasSchedulableCapacity() === false` makes it park today.
- **Placement happens once.** The runtime is persisted with the handle and
  every later call routes on it, the same rule `SANDBOX_DELETE` already
  follows for `sandboxProviderKind`.
- A handle belongs to one runtime at a time. `ensure` for a live handle
  naming another runtime returns the live one with
  `"runtimeMismatch": "<name>"`. It does not switch.
- No failover after create: a half-failed create is deleted and surfaced,
  never retried elsewhere (two pods, one handle).

### Switching runtime or image

Durable state lives outside the sandbox (the repo, org-fs), so a rebind is
`DELETE` then `POST` — no new endpoint. It is a cold boot: the working tree
survives only if the graceful teardown publishes it; the install, dev
server, in-flight run, token and SSE consumers do not.

Rules: never implicit (a flipped flag or a full cluster must not kill a live
dev server); drain before create, never overlap (two daemons on one branch);
a failed push aborts the switch; no in-flight run; no rebind onto a runtime
lacking a capability in use.

**Changing a repository's `sandbox_image` is the same rebind.** Today it
takes effect on the next provision. With the controller, `REPOSITORY_UPDATE`
does not touch running sandboxes; Studio offers the rebind under the rules
above.

### Capacity

`GET /capacity` stays Studio's admission gate: `schedulable` if any runtime
that could serve the request has room. Per-runtime detail lives in
`/runtimes`. Short-TTL cache per runtime, never per request. `true` means
"nothing is currently unplaceable", never a reservation.

For a hardware-bound variant, the `agent-sandbox` probe must answer for the
variant's nodes, not the fleet. An `android` claim with KVM nodes full and
general nodes idle is unschedulable, and today's aggregate would say
otherwise.

### What Studio sees

Studio passes the runtime and image names as opaque configured strings and
never branches on them. Where it varies behaviour, it reads
`capabilities` (no preview tab without `preview`; no "why did it stop"
without `termination-reason`). Adding a runtime touches the controller and
whatever sets the org flag; adding a variant touches neither Studio nor the
controller.

### Closed runtimes

A closed runtime ships as a closed binary that imports the controller as a
library and registers an extra runtime; the registry is already an
interface. That needs the module to be importable from outside this repo:

- rename the module from `github.com/decocms/studio/sandbox-controller` to
  its path, `github.com/decocms/studio/packages/sandbox/controller-go`, and
  tag releases `packages/sandbox/controller-go/vX.Y.Z`;
- move `main.go` wiring into an exported `Run(Options{ Runtimes: … })` so
  `main` is ten lines in both binaries;
- resolve `daemon-go/pkg/protocol` without the `replace` directive, since
  `replace` does not apply to importers: tag `daemon-go` the same way.

Only the module path is settled now (Phase 1, step 1): it is cheap before
anyone imports the module and expensive after. The rest waits for a closed runtime.

---

## Dev and self-hosting

```
bun run dev
├─ postgres, nats                 (as today)
├─ apps/api                       (STUDIO_SANDBOX_PROVIDER=remote)
├─ apps/web
└─ go run ./packages/sandbox/controller-go
   └─ docker runtime (the only one whose probe passes locally)
```

The controller is one more child of `apps/api/src/cli.ts dev`; only the
sandboxes are containers. A contributor with a kubeconfig gets both runtimes
and can pin one with `runtime`.

One degradation rule for dev, with two triggers (no Go toolchain, or no
runtime probe passes): log one line, skip the controller, and answer sandbox
tools with a `503` saying what to install. No `dev:minimum` script.
Prebuilt controller binaries per platform are deferred until someone asks.

Self-hosting on Kubernetes: the `sandbox-env` chart plus a controller
Deployment in the sandbox namespace, with the RBAC Studio's ServiceAccount
holds today. Variants are `imageVariants` values. The controller must never
be internet-reachable: a caller holding its credential can start sandboxes
with arbitrary env.

---

## Rollout

The controller enters production **before it carries a single claim**: the
first job it does in prod is reconciling `SandboxVariant`s, which is off the
claim path, while Studio keeps its in-process runner. That bakes the
Deployment, RBAC, image and chart on work that cannot break a sandbox start.

**Done:** #7461 (per-repository image, string schema, template probe,
chart `imageVariants`), #7469 (Flutter off the base image).

### Phase 1 — controller in, reconciling variants only

1. **`controller-go/`, variants only**, under its final module path
   `github.com/decocms/studio/packages/sandbox/controller-go`
   ([Closed runtimes](#closed-runtimes)). No claim code: the claim runtime,
   `RemoteSandboxProvider`, the clone-url callback and
   `daemon-go/pkg/protocol` land in Phase 3, ported against main then.
   Landing them default-off now would leave claim-path code nothing runs,
   which is how #6187 went stale.
2. **`@decocms/sandbox-controller-types`**, generated from the Go types,
   with a CI staleness check. Phase 1 carries `SandboxVariant`; the HTTP API
   types join it in Phase 3.
3. **`SandboxVariant` CRD + reconciler.** Tests for: a missing image tag
   (previous render kept), a default-template change (every variant
   re-rendered), a deleted variant (objects collected), a name that fails
   the schema, a variant written by another manager (left alone), and
   adoption of existing chart-rendered templates.
4. **Controller chart + published image**, multi-arch, distroless, a
   workflow mirroring `release-studio-sandbox.yaml`. There is no claim API
   yet; RBAC at this stage is `sandboxvariants` (+ `/status`),
   templates, pools, and `get` on the default template's
   `imagePullSecrets` by name, which the image check needs.
5. **Chart, in two releases.** N: add `helm.sh/resource-policy: keep` to
   the chart's variant templates and pools, plus
   `argocd.argoproj.io/sync-options: Prune=false`, since Argo CD, not Helm,
   syncs the chart on deco's clusters. On adoption the controller strips
   Helm's and Argo's labels and annotations (`app.kubernetes.io/instance`,
   `meta.helm.sh/*`, the tracking id), or Argo would keep claiming the
   objects. N+1: stop rendering them, and
   render each `imageVariants` entry as a `SandboxVariant` instead, with an
   optional `keep: true` that adds `helm.sh/resource-policy: keep` to it
   (Phase 2 needs it). Between
   the two, the controller adopts the kept objects (SSA with `force`, adds
   the `ownerReference`). Without `keep`, the N+1 sync deletes the templates
   before anything has adopted them. N+1 requires the controller: without
   its CRD, `helm upgrade` fails on the unknown `SandboxVariant` kind and
   leaves the N release (and its kept templates) in place, so a self-hoster
   who skipped the controller gets a failed upgrade, not missing templates.
   N+1 maps the existing values one to one (`warmPoolSize` → `warmPool.size`,
   `warmPoolMediumSize` → `warmPool.mediumSize`, `tag` defaulting to
   `image.tag` → `image.tag` and `baseTag`), so deco-apps-cd values do not
   change. The same release has the picker list labelled templates instead
   of its hardcoded pair.
6. **Detection on link.** `REPOSITORY_LINK` sets `sandbox_image` from a
   detection table when the field is not given; `REPOSITORY_UPDATE` still
   overrides. First entry: root `pubspec.yaml` plus an `android/` project →
   `android`. One contents API call at link time; the result still goes
   through the probe.
7. **Release workflow:** after the base image is pushed, dispatch
   `sandbox-base-released { version }` to infra_applications alongside the
   deco-apps-cd bump. Absent token → no-op.

### Phase 2 — deco's variants move to the control plane

Closed work, detailed in `control-plane-variants-spec.md`. The OSS side
needs one chart field: `imageVariants.<name>.keep: true` adds
`helm.sh/resource-policy: keep` to that `SandboxVariant`, so deco's values
can drop the entry without Helm deleting the object. The object must
survive, because the rendered templates are owned by it and would be
garbage-collected with it. The control plane's agent then owns it, and the
controller re-renders nothing because the spec did not change. Then
**delete `packages/sandbox/image-android/`** and its release job. The chart
keeps `imageVariants`; `values.yaml` keeps the commented Android example,
pointing at the Dockerfile pattern.

### Phase 3 — the controller takes claims

7a. **Claim path in.** `daemon-go/pkg/protocol`; the claim runtime from
   #6187 ported against main, following the ledger in `controller-work.md`
   (#7471's progress-based wait first); `RemoteSandboxProvider` and the
   clone-url callback, with mTLS, wired into main's `lifecycle.ts` behind a
   new default-off flag.
8. **`docker` runtime.** Registry, probing, `/runtimes` and placement are
   already in with one member; this is one implementation behind an
   interface with tests. It gives `bun run dev` a sandbox again.
9. **Tenant pools in the Go runtime.** `STUDIO_SANDBOX_TENANT_POOLS` is
   ignored by the Go runtime today, so prod cannot cut over before this
   lands. Port `tenant-pools.ts` behaviour as is; `tenant-pools.test.ts` is
   the ledger.
10. **Claim API on, staging.** Add the claim RBAC, `sandboxImage` in
   template resolution, `image` on the response, `GET /images`, and a
   capacity probe scoped to a variant's nodes.
11. **Drained production cutover.** In the same PR that flips the flag:
    delete the in-process `agent-sandbox` case from `lifecycle.ts`,
    `@kubernetes/client-node`, and Studio's Role + RoleBinding in
    `sandbox-rbac.yaml`. Until that deletion lands there are two
    implementations, which is worse than one; do not leave it half done.
    The picker switches from the in-process probe to `GET /images` here.

### Testing

Black-box, like `daemon-e2e`: spawn the binary, drive HTTP, assert. With the
`docker` runtime that is a real sandbox provisioned in CI with no cluster.
Internal logic (claim building, template + variant resolution, pool
resolution, handle → Service) gets Go table tests; `fake.NewSimpleClientset`
covers the Kubernetes paths. The TS unit tests (`runner.test.ts`,
`client.test.ts`, `tenant-pools.test.ts`, `lifecycle-watcher.test.ts`) are
the behaviour ledger for the port. `RemoteSandboxProvider` gets one e2e
against a controller on the `docker` runtime.

---

## Explicitly not doing

- **A `DecoSandbox` (or any) resource for claims.** One CRD,
  `SandboxVariant`, for cluster configuration. Starting a sandbox stays a
  synchronous HTTP call.
- **Proxying daemon traffic** through the controller.
- **Any runtime call between the controller and the control plane.** They
  meet in `SandboxVariant` objects.
- **A variant catalog in Studio.** The cluster is the catalog.
- **The control plane deploying the controller.** The data-plane agent is
  deliberately restricted to one API group and cannot touch Deployments or
  RBAC, so a compromised control plane cannot run workloads. The controller
  ships the way `decocms/operator` does: its chart, through GitOps.
- **A per-repo Dockerfile built at boot** (devcontainer model). Too slow per
  boot, and the daemon's runtime contract is too wide to layer onto an
  arbitrary customer base. See [Later](#later).
- **Per-org or per-thread images.** The primary repository decides; one pod,
  one toolchain.
- **A scheduler**, live migration, mTLS to the daemon, its own database,
  gRPC.
- **Moving handle derivation, preview edge behaviour, or credential minting**
  out of Studio.

## Open questions

1. **`user-desktop`.** If any form survives #5570, it stays in Studio (bound
   per run to the acting user, no infrastructure API).
2. **Preview on `docker`.** `127.0.0.1:<port>` loses per-sandbox hostnames; the
   deleted tree had a `*.localhost` ingress. Ports until a cookie/CORS
   problem shows up.
3. **Operator API version.** Pin `v1alpha1` for the port (one variable at a
   time); `v1beta1` is a separate step. Confirm what `deploy/helm/sandbox-operator`
   serves before pinning the clientset.
4. **Variant image visibility.** Once variant Dockerfiles leave this repo, a
   self-hoster has the chart mechanism but no published Android image. Is
   a public reference image worth keeping, or is "build your own FROM the
   base" enough?

## Later

- **`FROM <customer image>` + our layer.** Feasible because the daemon is one
  static binary; blocked by the width of the base runtime contract (bun, node,
  chromium, python office tooling, skills, typegen, harness-runner). Shrinking
  that contract is the prerequisite.
- **Tenant pools as a resource.** The same shape as `SandboxVariant`: a
  `SandboxTenantPool` the controller reconciles into a warm pool, replacing
  `STUDIO_SANDBOX_TENANT_POOLS` parsed on both sides. The control plane then
  owns per-org pool desired state on deco's clusters, and a self-hoster writes
  the same objects with the chart. Only once one is actually needed.
- **Split the daemon's `/_sandbox/*` onto an unpublished port.**
