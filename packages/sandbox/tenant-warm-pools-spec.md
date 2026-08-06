# Tenant warm pools — pods that are already running the dev server

Written 2026-08-06. A member of an opted-in org opens a project and the dev
server is **already up** — no clone, no install, no Vite boot. Immediate driver:
one tenant (Electrolux), hardcoded, for a demo.

The shape: a warm pool exists **per tenant**, pointed at a repo + branch. Its
pods bootstrap themselves the moment they exist (clone → install → `dev`) and
sit there running. A user's claim binds one of those pods to that user. Only
users of the owning org can be given one. When the sandbox is stopped or reaped,
the claim goes away and the pool refills back to N.

**Implemented** (phases 1 + 2). Where the code differs from the design below,
the code is right and the difference is called out inline under "As built".
"What exists today" is read from the tree as of writing. Unqualified `runner.ts` / `client.ts` refs are
`packages/sandbox/server/provider/agent-sandbox/`; unqualified daemon paths are
`packages/sandbox/daemon-go/`.

---

## What exists today

**The warm pool is generic, not per-tenant.** `AgentSandboxProviderOptions.sentinelToken`
flips the runner into warm-pool mode (`runner.ts:333`, `1164`): claims post
`warmpool: "default"` with empty `spec.env` (the operator rejects per-claim env
outside `warmpool: "none"`), the operator binds an already-running pool pod, and
Studio's first daemon call authenticates with the shared sentinel and rotates to
a per-claim token via `POST /_sandbox/config { rotateToken }` (`runner.ts:1333-1337`).
The claim type already allows a **named** pool — `warmpool?: "none" | "default" | string`
(`client.ts:75`), and the CRD's field is a free-form string defaulting to
`default`, so a new pool name needs no operator change — nobody passes one.

**A claim names a pool *and* a template.** `spec.sandboxTemplateRef` is required
alongside `spec.warmpool` (CRD `sandboxclaims`), and the runner hardcodes it to
`this.sandboxTemplateName` (`runner.ts:1194`) — one template per release.

A pool pod today is empty: no repo, no deps, no dev server. Everything expensive
still happens *after* the user's claim binds. That is the entire gap this closes.

**The pool is chart-level and sized globally.** `deploy/helm/sandbox-env/values.yaml:463-491`
(`warmPool.enabled/size`, optional HPA against the `SandboxWarmPool` scale
subresource). One pool per release, and it is **already on in prod at `size: 2`**
(`selfhost/production/values-sandbox-env-prod.yaml:63`) — a tenant pool is
additive to those two, not a replacement.

**The housekeeper already understands "not yet claimed."** `files/housekeeper-sweep.sh`
probes `/_sandbox/idle`; `claimed=false` → `skip … (warm-pool pod awaiting first
workload)`. It only sweeps pods that have a **SandboxClaim**, so an unbound pool
pod is invisible to it. Claimed sandboxes idle-reap at 15 min, renewed on every
`ensure()`.

**Identity is derived, and two places derive it independently.** `ensure()` computes
`handle = composeBranchHandle(id)` from `id` alone, and the claim's **name is the
handle** (`runner.ts:508`, `1180`); `apps/api/src/sandbox/claim-handle.ts` recomputes the same handle to
route preview traffic without a DB read. This was fixed deliberately — see
`claim-identity-and-cost-spec.md`, where a handle that could disagree with itself
produced duplicate claims and orphan pods. **A design that renames a running pod
breaks the proxy and reopens that bug.** This one doesn't: the claim keeps its
derived name, only the *pod* behind it comes from the tenant pool.

**The daemon already has the primitives.**
- `POST /_sandbox/setup/{clone,install,start}` — the three steps, individually
  triggerable (`daemon-go/main.go:382-384`).
- `POST /_sandbox/config` — classified into **exactly one** transition
  (`internal/config/classify.go`): `bootstrap`, `branch-change`, `runtime-change`,
  `pm-change`, `port-change`, `env-change`, `git-credential-refresh`, `no-op`, and
  `identity-conflict` when the clone URL's host/path changes. **A branch change on
  an already-installed tree is cheap** (fetch + checkout, deps survive). A repo
  change is refused outright.
- **Only some transitions run a step.** `transitionToStep`
  (`internal/setup/orchestrator.go:719-726`) maps `bootstrap`/`branch-change` →
  clone, `runtime-change`/`pm-change` → install, `port-change` → start. `env-change`
  maps to **nothing** — it updates stored config and no more. Env reaches the dev
  server only when some *other* transition restarts it (`BuildDevEnv(cfg, …)` reads
  the merged store, `orchestrator.go:505-511`). See "Claiming" for why that matters.
- **`claimed` flips on any config, not on identity.** `activity.MarkClaimed()` runs
  unconditionally after every applied patch (`internal/routes/config.go:115`).
- Golden deps cache (`internal/setup/golden.go`) already removes most of install.
  Per the boot-cost work, **Vite boot is what's left** — which is exactly what a
  pod already running `dev` removes.

**Consequences that shape everything below:** a pod prewarmed on repo A can never
serve a claim for repo B (`identity-conflict`), but it can serve any *branch* of A.
So a pool is keyed `(org, repo)` and carries a base branch.

**No GitHub webhook receiver exists.** Only Stripe (`apps/api/src/billing/stripe-webhook.ts`,
dormant without `STRIPE_WEBHOOK_SECRET`) and per-automation webhook triggers.

---

## Design

```
Phase 1  the pool          one hardcoded tenant pool; pods self-bootstrap; claims bind them
Phase 2  freshness         GitHub push webhook → refresh idle pods; hourly poller fallback
Phase 3  generalize        config moves from env to a table; second tenant costs a row
```

### As built — where the code differs

| | |
|---|---|
| **Pool name is explicit, not derived** | A pool carries `name`; the chart's `tenantPools:` list renders a `SandboxWarmPool` with the same string. Deriving `tenant-<orgSlug>-<repoSlug>` on both sides is a mismatch waiting to happen. |
| **One template, not two** | The claim swaps `warmpool` only; `sandboxTemplateRef` stays the shared template. The second template exists solely to carry per-pool node placement (`onDemand` / `do-not-disrupt`), which v1 dropped — and rendering a second copy of a 300-line pod spec to carry two fields isn't worth it. Reinstate both together. |
| **No leader election, no annotation CAS** | Every replica reconciles. Safe because the daemon classifies each config post itself (bootstrap vs credential refresh) and its setup queue collapses concurrent step requests into one: duplicated effort, never duplicated clones. |
| **One refresh mechanism covers freshness AND credential expiry** | The periodic refresh (default 30 min, under the ~1h token life) re-posts a freshly minted clone URL and re-runs `setup/clone`. That is both the "poll fallback" and the `startCredentialRefresher` extension the failure table asks for — no hourly GitHub API poller, no HEAD comparison. The webhook only makes it immediate. |
| **A first sight is not a refresh** | A replica that restarts under an already-warm pool posts config (rotating a stale credential) but does NOT re-run setup. Every replica bouncing every pod's dev server on boot is a self-inflicted outage. |
| **`connectionId` is optional** | Omitted → the pods clone anonymously, which only works for a public repo. It's what makes the local end-to-end test hermetic. |
| **Env var is `STUDIO_SANDBOX_TENANT_POOLS`** | Matches its neighbors (`STUDIO_SANDBOX_*`), not the `SANDBOX_TENANT_POOLS` named below. |
| **The webhook is optional everywhere** | 503 without `GITHUB_WEBHOOK_SECRET`; pools still refresh on their own schedule. Nothing about this feature needs a webhook configured. |

### Pool definition

One entry per pool:

| field | notes |
|---|---|
| `orgId` | **the only org whose members may be given one of these pods** |
| `repo` + `connectionId` | credential minted fresh per bootstrap, never stored |
| `branch` | what idle pods sit on. Default `main` |
| `size` | how many warm pods to keep ready |
| `workload` | runtime / packageManager / packageManagerPath / devPort |
| `onDemand` | keep the pods off spot (see Node placement) |

Phase 1 reads this from a Studio deploy-config env var (`SANDBOX_TENANT_POOLS`,
JSON array, empty by default). One tenant, one hand-edited value, no migration,
wrong values are a rollback not a down-migration. Phase 3 promotes it to a
`sandbox_warm_pools` table with the same shape. It is **not** an org flag —
`OrgFlagsSchema` is booleans only (CLAUDE.md).

Cluster side: one `SandboxTemplate` + one `SandboxWarmPool` named
`tenant-<orgSlug>-<repoSlug>`, rendered from a `tenantPools:` list in the
sandbox-env chart, reusing the existing warm-pool templates and sized `size`.

### Bootstrapping an idle pod

The operator gives us running-but-empty pods. A Studio reconciler
(`apps/api/src/sandbox/tenant-pool-reconciler.ts`, ~60s tick, no-op when no pools
are configured) lists each pool's pods by label and, for every one that is
unbound and not yet bootstrapped, port-forwards
and `POST /_sandbox/config` with the pool's repo (freshly minted clone URL) +
workload — the same `buildConfigPayload` the provision path uses, authenticated
with the sentinel. The daemon runs `bootstrap`: clone → install (golden cache) →
`dev`. The pod is now warm and still unbound.

**There is no leader election to lean on.** Studio has none: periodic singletons
are either per-pod `setInterval` (`review-sweeper.ts:42` — "per pod … 3 replicas")
or DBOS scheduled workflows (`dbos-public-sets-sync.ts`, `dbos-retention-workflow.ts`).
Three replicas ticking naively means three concurrent clone+installs on the same
pod. Two acceptable answers:

- **DBOS scheduled workflow** — matches the existing pattern and dedupes globally
  for free. Preferred if a ~60s schedule is comfortable there.
- **Per-pod tick + a CAS claim on the pod itself** — patch
  `studio.deco.cx/prewarm: bootstrapping|ready|failed` (plus an attempt count)
  with a `resourceVersion` precondition; k8s optimistic concurrency *is* the
  mutex, loser skips. Survives replica restarts (the state is on the pod, not in
  memory) and is the same annotation the `prewarm-failed` cap below needs.

Either way this needs **new RBAC**: Studio holds `pods: get,list,watch` +
`pods/portforward` and `sandboxes: get,list,watch` (`sandbox-rbac.yaml:46-59`) —
no `patch` on either. Add exactly the one verb the chosen mechanism uses.

**Why Studio pushes rather than the pod pulling its own config:** the clone
credential is a ~1h GitHub App token. It can't live in the template's env, and
letting a pod fetch org-scoped config while authenticated only by the *shared*
sentinel would hand any pod in the cluster a tenant's repo credential. Studio
already holds kube access, the port-forward, and the minter.

**Daemon change: gate `MarkClaimed` on user identity.** Today *any* applied config
sets `claimed:true` (`routes/config.go:115`), so the moment we bootstrap a pool pod
the housekeeper starts counting it as an idle claim and reaps it 15 min later. That
gate — `claimed` flips only for a config carrying a **user identity** — is the whole
change; `prewarmed: true` alongside `claimed:false` in `activity.IdleStatus` is just
observability, so a warm pod is distinguishable from a never-configured one. The
housekeeper needs no change: it already skips `claimed=false` and treats an *absent*
`claimed` as `true` (`housekeeper-sweep.sh:108-115`), so adding a field is safe in
either rollout order.

### Claiming — and tenant isolation

`buildClaim` resolves a pool from `(claiming user's org, repo)` and swaps **two**
fields: `warmpool: "tenant-…"` instead of `"default"` (`runner.ts:1209`) *and*
`sandboxTemplateRef` to the tenant template (`runner.ts:1194`, today a single
instance-wide name). Both, or the operator binds a pool pod built from one template
to a claim asking for another. No pool for this org+repo → `"default"` + the shared
template → today's behavior.

The second template is the price of per-pool node placement (`nodeSelector` /
`do-not-disrupt` live in the template's pod spec, so they can't be per-claim). It
duplicates the shared template's image and sentinel wiring — render both from one
partial in the chart. Warm-pool mode sends no claim env, so there is no env to keep
in sync; if that ever changes, drop `onDemand` and reuse the single template rather
than diverge two.

The pool name is derived from **the org of the user being served**, never from a
request field. That is the isolation boundary: Studio is the only writer of
SandboxClaims in the namespace (RBAC), the claim is built server-side from the
authenticated principal's org, and there is no input anywhere that lets a caller
name a pool. Worth stating in the code as a comment, because the operator itself
will happily bind any pool named in a claim — it has no notion of a tenant.

Post-bind, Studio's existing `POST /_sandbox/config` carries the same clone URL
(→ **not** an identity conflict), the user's git identity, and the thread's
branch: a `branch-change` on a tree that already has deps and a live dev server.
Handle, claim name, HTTPRoute, and proxy routing are untouched.

**That works only because the branch differs.** Classification picks one
transition, and the post-bind payload changes branch *and* per-claim env *and* the
credential at once; `branch-change` wins and its restart happens to pick up the new
env from the merged store. Thread branches are synthetic
(`thread:<id>/<connId>`), so they effectively always differ from a pool sitting on
`main` — but "effectively always" is not a guarantee, and if the branches ever
match, classification yields `env-change`, which restarts nothing: the user's
sandbox would keep serving the pool's env under a live claim. Close it in the
daemon, not by hoping: map `env-change` → `StepStart` in `transitionToStep`. It is
correct on its own terms anyway (an env change that never reaches the dev server is
a silent no-op today), and it's a one-line change with a daemon e2e test.

Pool empty → the operator falls back to a cold pod, i.e. today. **The pool is an
optimization, never a dependency** — every path must still work at size 0.

### Release: the slot comes back, the pod does not

When the user stops the sandbox (or it idle-reaps, or the claim is deleted), the
claim goes away and the reconciler brings the pool back to N.

**It must be a fresh pod, not the used one.** A pod that served a user holds that
user's git credential on `origin`, their identity in `.gitconfig`, a dirty working
tree on their branch, mutated `node_modules`, their per-claim daemon token, and
whatever processes their agent left running. Handing that pod to the next member
of the org is a cross-user data leak with no upside — the expensive state
(golden deps cache) is *node-local and shared*, so a replacement pod re-warms
without paying a real install. Destroy and refill.

Practically: the operator's existing teardown deletes the pod with the claim; the
pool controller schedules a replacement; the reconciler bootstraps it on its next
tick. The user-visible effect is that pool depth dips by one for as long as a
bootstrap takes, which is why `size` must exceed expected concurrent starts.
Emit a gauge (`sandbox_pool_ready_pods{pool}`) and alert on sustained 0 — a pool
that is always empty is a pool that is silently doing nothing while costing N
pods' worth of thrash.

### Phase 2 — freshness

**Push.** `POST /api/_webhooks/github` (instance-level, mounted beside the Stripe
route, before the `/api/:org` catch-all). HMAC-SHA256 against `GITHUB_WEBHOOK_SECRET`;
dormant without it. Handle `push` only; 200-and-ignore everything else. When
`ref == refs/heads/<pool branch>` and the repo matches a pool, refresh that pool's
**unbound** pods one at a time (a whole pool reinstalling at once is a thundering
herd on the registry and the node):

```
POST /_sandbox/setup/clone     # fetch + hard reset to origin/<branch>
POST /_sandbox/setup/install   # no-op when the lockfile is unchanged
POST /_sandbox/setup/start     # restart dev
```

**Claimed pods are never touched** — a user has a working tree, and a hard reset
under them is data loss. They pull when they choose to.

Coalesce per pool: at most one refresh in flight; a push arriving during one
collapses into a single follow-up run.

**Poll (fallback).** Hourly, per pool: `GET /repos/{o}/{r}/commits/{branch}`,
compare to each unbound pod's HEAD, refresh on mismatch. Covers a missing or
misconfigured webhook, a delivery dropped while Studio was down, and repos outside
the App installation. Hourly on purpose: the webhook is the mechanism, the poller
is the smoke alarm.

### Node placement

Pool pods are long-lived and their eviction is user-visible:

- **Off spot:** `nodeSelector: { karpenter.sh/capacity-type: on-demand }` on the
  tenant template's pod spec, opt-in per pool (`onDemand`). No new NodePool — the
  existing sandbox NodePool offers both capacity types; this constrains the pod.
  (`karpenter.sh/capacity-type` is Karpenter's well-known label;
  `node.kubernetes.io/lifecycle` is the legacy cluster-autoscaler convention and
  is not what this cluster sets.)
- **No consolidation eviction:** annotate pool pods `karpenter.sh/do-not-disrupt: "true"`.
- Spot interruption handling is then out of scope. If a pool ever goes back on
  spot, the reconciler already notices a missing pod and re-warms it — just not
  instantly, and this spec promises nothing faster.

---

## Failure modes worth stating

| | |
|---|---|
| A pod prewarmed on the wrong repo | Can't be misused silently: the daemon answers `identity-conflict` and the claim falls back to a cold pod. Pools are keyed `(org, repo)` for exactly this. |
| Bootstrap never completes (bad lockfile, private submodule, no `dev` script) | The pod sits unbound and useless while the reconciler retries forever, and the pool *looks* full. Cap at 3 attempts, then label `prewarm-failed`, drop it from the pool selector, emit an event. |
| Credential expiry on a warm pod that waits hours | `startCredentialRefresher` handles claimed sandboxes today (`git-credential-refresh`, no reclone). It must be extended to unbound pool pods, or a pod that idles past ~55 min hands the user a dead `origin`. |
| A user's claim binds a pod mid-refresh | Refresh only unbound pods, and re-check unbound immediately before each step. Worst case the user gets one extra restart, not a reset tree. |
| Pool exhausted at peak | Falls back to cold start (today's behavior), plus the depth gauge above. Fixed `size` until someone has a number. |
| Cost | Every slot is a permanently billed pod — on-demand *and* `do-not-disrupt`, so Karpenter can never consolidate the node under it (the same trap Sandbox CRs already set). This is **additive to the two generic warm pods prod already runs**, per-org opt-in, no pool configured by default. Label pool pods distinctly so they're separable in the fleet-cost read from `claim-identity-and-cost-spec.md`. |
| Reconciler runs on 3 replicas | Concurrent bootstraps of the same pod. DBOS schedule or a `resourceVersion`-guarded annotation CAS — see "Bootstrapping". Not optional. |

## Deliberately not in v1

- **No per-user warmth.** A pool pod serves whoever claims first within the org.
  Per-user pods mean identity-bearing warm state; the win over branch-switch on
  warm deps is small.
- **No pod reuse after release.** See above — leak risk, no real saving.
- **No autoscaling.** The chart's HPA hook exists if a pool ever needs it.
- **No UI.** Env config, then a table. Ship a UI when a second org asks.
- **No pod rebinding / renaming.** See "Identity is derived".

## Tests

- **Unit** — pool resolution from `(orgId, repo)`, including "user of another org
  never resolves this pool" and "no pool → `default`"; that a resolved pool sets
  **both** `warmpool` and `sandboxTemplateRef` (and neither when unresolved);
  webhook `ref`/repo matching and HMAC verification; refresh coalescing.
- **Daemon e2e** (`packages/sandbox/daemon-e2e/`, black-box over HTTP) — a
  bootstrap config with no user identity leaves `claimed:false, prewarmed:true`;
  a later identity-bearing config flips `claimed:true`; a same-repo branch change
  after bootstrap does not reinstall; an env-only change after bootstrap restarts
  dev with the new env; a different-repo config is refused.
- **Housekeeper** — a bootstrapped, unbound pod (`prewarmed:true, claimed:false`)
  past the idle TTL is skipped, not reaped. Write this one first; without it,
  warming a pool is what kills it.
- Invert, don't append: whatever asserts "idle past TTL is reaped" gets the
  prewarmed case added next to it.
