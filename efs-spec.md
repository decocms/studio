# Design: cross-node golden dependency cache (EFS L2)

Status: RFC — ready to implement · Owner: sandbox · Last updated: 2026-07-28
Related: `instant-branches-snapshot-restore.md` (orthogonal — that RFC attacks
the ~13–16s dev-boot floor; this one makes dependency install fast on *every*
node, which it lists as "already addressed by caches").

## TL;DR

The golden `node_modules` cache **works in prod** (`GOLDEN_CACHE_ENABLED=1`): a
fresh pod reflink-restores a cached `node_modules` for its `(repo, lockfile)` in
~1s and skips `bun install`. Its one limit is that the golden is **node-local**
— it only hits when the pod lands on a node that already warmed that repo. With
the sandbox pool churning **~170 nodes/day across 3 AZs** (§2), a large share of
boots land on a node that isn't warm for their repo and fall back to a full
install.

Add a second tier that removes the same-node dependency:

- **L1 — node-local reflink golden** (exists, on): ~1s, same-node only.
- **L2 — EFS archive** (new): a per-`(repo, lockfile)` `tar.zst` on a shared EFS
  volume, restored on **any** node in **any** zone. Filesystem-agnostic
  (extracts to local disk — no reflink dependency).

One hard rule: **store a tarball on EFS; never mount the `node_modules` tree on
EFS.** EFS cost is per-op metadata latency — fatal for a ~100k-file tree, a
non-issue for one large sequential blob.

Plan: **P0** add cache hit/miss + install-ms metrics (untracked today) to size
the same-node miss rate. **P1** build L2 (needs the EFS CSI driver — **not
installed today**). **P2** pre-seed each node's local cache from EFS via a warmer
DaemonSet, so pods hit ~1s L1 and (for the hot set) never touch EFS — if the data
says eager warming pays.

## 1. Goal & non-goals

**Goal:** a dependency-install fast path whose hit rate does **not** depend on
which node/zone a sandbox pod is scheduled onto, so cold installs stop being a
function of spot churn.

**Non-goals:**
- The ~13–16s dev-boot floor — that's the snapshot/warm-spare RFCs.
- Making sandboxes stateful or persistent. Work stays git-backed and pods stay
  ephemeral. This caches only *derivable* artifacts (`node_modules`), never user
  state.
- Per-pod block storage (EBS). It's zonal and per-pod-costed — the opposite of
  what a shared cross-zone cache needs.

## 2. Evidence (production, 2026-07-14)

Grafana `vm-main` + read-only `kubectl`, prod `eks-serverless`, us-west-2.

| Signal | Value | Source |
|---|---|---|
| `ensure` outcomes, 7d | **fresh 27,362 · resume 6,762** → 80% new-pod | `studio_sandbox_ensure_outcome_total` |
| Zone spread of live sandboxes | us-west-2 **a · b · c** (all 3 AZs) | `kube_pod_labels` |
| Sandbox nodepool `workloads-environments` | **176 nodes**, **167 created/day**, 4,885 lifetime | `karpenter_nodeclaims_created_total` |
| Mean node lifetime (derived) | ≈ **~25h** | Little's law |
| New pods per node per day (derived) | ≈ **~22** | above |
| Live co-location (spot check) | one node ran **5 sandbox pods** at once | `kubectl -o wide` |
| Golden cache | **`GOLDEN_CACHE_ENABLED=1`, working** (`studio-sandbox:1.24.2`) | pod env |
| Grace period | `terminationGracePeriodSeconds: 30` on the live pod — the chart's `90` (#4561) never reached prod, see below | pod spec |
| Chart drift | prod pins `sandbox-env` **0.9.5**; the tree is at **0.9.33**. Any chart change needs a `targetRevision` bump in `deco-apps-cd` to land | `deco-apps-cd/values.yaml:110` |
| EFS CSI driver | **absent** — only `ebs-csi` in kube-system | `kubectl get pods -A` |
| Sandbox node disk | Bottlerocket, **~40 GiB (some 60) xfs** EBS gp3 data vol (`/var`), ~25–44 GiB free | `node_filesystem_*` |
| Node scoping | `nodeSelector decocms.com/nodepool=sandbox`, taint `decocms.com/sandbox`; warmPool size 2; podAffinity packing | `deco-apps-cd/apps/studio-sandbox-prod` |
| Daemon metrics pipeline | **no `MeterProvider` in `packages/sandbox`** — `@opentelemetry/api` only, so `getMeter("link-daemon")` is the no-op | `package.json`, grep |
| Sandbox egress | netinit iptables (not a NetworkPolicy): `blockCIDRs` REJECT fires **before** the port ACCEPTs; allowed TCP = 53, 443 | `sandbox-template.yaml`, `values.yaml` |
| OTLP collector | `gateway-otlp` ClusterIP **172.20.146.131** (inside blocked `172.16/12`); `gateway-otlp-ingest` LB exposes `443` | `kubectl get svc -n opentelemetry-collector` |

What each decides:

1. **80% new-pod + 3-AZ spread + ~170 nodes/day → the same-node hit is
   fleet-limited.** L1 works, but a fresh pod frequently lands on a node not warm
   for its repo (new node, or a node warm for other repos), and cross-zone a
   node-local cache can't help at all. That miss is what L2 covers.
2. **~22 pods/node/day + 5-pod co-location → L1's same-node reuse is real** and
   worth keeping; L2 complements it, it doesn't replace it.
3. **The miss rate itself is unmeasured, and the pod has no way to say.** No
   cache hit/miss metric exists (`studio_sandbox_*` = ensure/proxy/active only);
   the daemon can't collect one (no `MeterProvider`) and couldn't ship it if it
   did (the collector's ClusterIP is inside the netinit block list). P0 is
   therefore "give the daemon a telemetry channel", not "add a counter" — see
   §6 P0. The stdout→VictoriaLogs path *does* work for install data today
   (`setup/dep-metrics.ts`, after #4271/#4273/#4275 taught it the pipeline's
   ~600B line cap and burst sampling) — that's the fallback, not the plan.

## 3. How the cache works today (anchors)

- **Key**: `repoCacheKey()` = sha256 of the credential-stripped cloneUrl
  (`daemon/setup/install.ts`); golden path `goldenNodeModulesPath()` =
  `<DEPS_CACHE_ROOT>/golden/<repoHash>/<pm>-<lockHash>/node_modules`
  (`golden-cache.ts:107`).
- **Restore** (`golden-cache.ts:196` `tryRestoreGolden`), called from the
  install step (`setup/orchestrator.ts:372`): `cp -a --reflink=always` golden →
  `/app`; on hit, `markInstallSucceeded` and skip `bun install`
  (`orchestrator.ts:362-384`); on miss/failure, fall through to `spawnInstall`.
- **Publish** (`golden-cache.ts:242` `publishGolden`), from `orchestrator.ts:151`
  and deferred to the healthy `running` transition
  (`entry.ts:290` `publishPendingGolden`): snapshot a healthy `node_modules`,
  strip pod-local caches (`.vite`, `.cache`), atomic-rename into the golden dir.
- **GC**: `pruneGoldens()` (`golden-cache.ts:298`) — TTL 7d, max 5 per repo.
- **Store**: node-local `hostPath` `/var/cache/studio-sandbox-deps`
  (`values.yaml depsCache`), `DEPS_CACHE_ROOT=/deps-cache`
  (`sandbox-template.yaml`).
- **Security boundary today**: per-repo key. Same-cloneUrl sandboxes share a
  cache (one trust domain — sandbox access implies repo write); bun does **not**
  re-verify cache content, so cross-repo sharing would be an install-as-is RCE
  surface. `values.yaml` already warns: *"Do NOT widen to a shared cache without
  making it read-only to tenant pods."* §7 honors this.

L2 reuses all of the above — key, GC, publish-when-healthy, the trust boundary —
and changes only the **store** (node-local → shared) and the **transport**
(reflink tree → tarball).

## 4. Design principle: blob, not tree

EFS (NFS) charges per-operation metadata latency:
- **Tree on EFS** (`node_modules`/`BUN_INSTALL_CACHE_DIR` mounted) → thousands
  of small-file ops over the wire; bun's linker degrades to `copyfile`. Slow.
  **Never.**
- **One compressed archive on EFS** → a single large sequential read/write —
  NFS's best case. The per-file cost is paid on the *local* extract, on fast
  local disk.

## 5. Architecture

- **L1** (unchanged): node-local reflink golden, ~1s, same-node.
- **L2** (new): `<GOLDEN_CACHE_REMOTE>/golden/<repoHash>/<pm>-<lockHash>.tar.zst`
  on a shared EFS volume.

**Restore order** (in `orchestrator.ts` around the current `tryRestoreGolden`):
1. L1 reflink → hit: skip install (~1s). Today's behavior.
2. L1 miss → **L2**: stream-extract the archive to `/app/node_modules`
   (fs-agnostic). (P2: also seed the local golden dir so the next pod on this
   node gets L1.)
3. L2 miss → `bun install`, then publish to L1 and (via the trusted writer, §7)
   to L2.

**Publish**: only on the healthy `running` transition (unchanged), keyed
identically. Write to a temp path on EFS then atomic rename — safe under
concurrent publishers across nodes.

**Warm-pool interaction** (load-bearing): warm pods have **no repo at boot**
(claims reject per-claim env), so the EFS mount must be **repo-agnostic** — the
whole volume, not a per-repo subPath. The repo is known only post-bind (config
POST), which is exactly when restore already runs. So per-repo scoping happens
in the daemon/writer path (§7), not at the K8s mount.

## 6. Implementation

### P0 — measure the same-node miss rate (days, zero new infra)

The daemon already knows, at `orchestrator.ts:362-396`, whether install was an
L1 hit or a fall-through install, and can time the install. Getting that number
out of the pod is the whole of P0.

**Why nothing exists today.** The daemon holds a meter handle
(`metrics.getMeter("link-daemon")`, `entry.ts:470`) but the sandbox package
depends on **`@opentelemetry/api` only — there is no `MeterProvider` anywhere in
`packages/sandbox`**. So that meter is the API's *no-op*: daemon metrics aren't
merely unscraped, they are never collected. Two constraints shape the fix:

- **Push, not scrape** (Nicácio): sandbox pods are too ephemeral to scrape —
  you lose the windows. Push lets the daemon flush on SIGTERM and guarantees
  the last install's numbers ship. OTLP acks `202` on both HTTP and gRPC, so the
  flush is fire-and-forget; nothing blocks on the collector.
- **Egress is closed to the collector** — and *not* in the way the "just open a
  port" fix assumes. See below.

**The egress hole is CIDR-shaped, not port-shaped.** Enforcement is the netinit
iptables init container (`sandbox-template.yaml`, not a NetworkPolicy), and it
appends rules in this order:

```
-o lo ACCEPT → conntrack ESTABLISHED ACCEPT → blockCIDRs REJECT
  → allowedUDPPorts ACCEPT → allowedTCPPorts ACCEPT → default REJECT
```

`gateway-otlp` is ClusterIP **172.20.146.131**, inside `blockCIDRs`'
`172.16.0.0/12`. It is REJECTed at step 3, *before* any port ACCEPT at step 5 —
so adding `4317` to `netinit.allowedTCPPorts` (however high the port) changes
nothing. Three ways out, in preference order:

1. **Use the existing LoadBalancer** — `gateway-otlp-ingest` exposes
   `443:32184/TCP`. Its ELB address is public, so it clears the CIDR REJECT and
   lands on the already-allowed 443. **Zero netinit change, zero new hole into
   the cluster, TLS by default.** Costs a hairpin out to the ELB and back —
   noise for a handful of points per pod lifetime. Confirm what auth that
   listener expects (the `8443` port suggests a separate authed/mTLS path).
2. **A destination-scoped ACCEPT before the block rules** — a new
   `netinit.allowedDestinations` knob rendering
   `iptables -I OUTPUT -d <ip>/32 -p tcp --dport 4317 -j ACCEPT` ahead of the
   `blockCIDRs` loop. Needs the ClusterIP pinned in values (Helm can't resolve
   DNS), so it's cluster-specific and breaks if the Service is recreated.
3. **Widen `blockCIDRs` by port** — rejected: it would let user code reach *any*
   in-cluster service listening on that port.

Whichever lands, opening a path from untrusted user-code pods to the collector
is a **metric-injection / cardinality-bomb surface** — a compromised sandbox can
emit arbitrary series. Bound it: fixed instrument names, `repo_hash` as the only
unbounded-ish label (it's a sha256 prefix, so cap the emitted length), and no
tenant-controlled strings in attributes.

**Wiring:**

1. **Daemon** gains `@opentelemetry/sdk-metrics` + an OTLP exporter (gRPC
   preferred — binary and compressed; falls back to HTTP/protobuf on 4318) and a
   real `MeterProvider` behind the existing `link-daemon` meter. Instruments,
   recorded next to `markInstallSucceeded`:
   - `studio.sandbox.deps.restore` — Counter, labels `{source: "l1"|"l2"|"miss",
     repo_hash}` (repo hash → also reveals repo-concentration-per-node).
   - `studio.sandbox.deps.install_ms` — Histogram (the cold cost we shave).
   - `studio.sandbox.deps.restore_ms` — Histogram, label `{source}`.
2. **SIGTERM flush ordering is load-bearing.** `shutdown()` (`entry.ts:924`)
   already commits and pushes the user's work, bounded at 30s inside a 30s grace
   period — that push is the only durable copy of their work. So: **dispatch the
   metric flush first and never await it**, then run the git sync. Awaiting the
   exporter ahead of the push would trade user data for telemetry; running it
   after means SIGKILL eats it.

*Rejected alternative — the stdout log channel.* `setup/dep-metrics.ts` already
ships install data as byte-bounded JSON lines to VictoriaLogs, and one more line
per install would work (well under its ~600B cap, no burst → no sampling). It's
the cheaper diff, but it's logs-as-metrics: no histograms, no SIGTERM guarantee,
and a Grafana panel that has to sum `sample_rate` to undo collector sampling.
Take it only if the egress decision stalls; it is not the destination.

Exit criterion: same-node hit/miss rate and install-ms visible in Grafana. Miss
rate sizes P1; install-ms is the per-boot saving L2 buys on a miss.

### P1 — EFS L2 archive (the cross-node win)

**Infra prerequisite (§2: not present today).** In the cluster terraform
(eks-setup, where the sandbox NodePool lives):
- install `aws-efs-csi-driver`;
- provision an EFS filesystem (General Purpose, **Elastic throughput** — restore
  is latency-sensitive under a cold-node herd);
- a **mount target per AZ** (us-west-2 a/b/c — the driver mounts the AZ-local
  target; this is what makes it multi-zone);
- a static PV + `StorageClass` for the RWX claim.

**Daemon transport** — a remote backend beside the reflink one in
`golden-cache.ts` (or a new `remote-golden.ts`), gated by `GOLDEN_CACHE_REMOTE`
(mount path; absent → L1-only, today's behavior):
- restore: `zstd -dc <archive> | tar -C <installRoot> -xf -`
- publish: `tar -C <installRoot> -cf - node_modules | zstd -T0 -o <tmp>` then
  atomic rename.
- **Streamed/async only** — this is the boot path and CONTRIBUTING rule #1 bans
  blocking the daemon event loop: `node:stream` pipelines + spawned `tar`/`zstd`,
  `await`, no `*Sync`. (`tar` comes with the base image; `zstd` does not — see
  "Image dependency" below.)

**Chart** (`deploy/helm/sandbox-env`):
- values: `depsCache.remote.enabled`, `depsCache.remote.mountPath`
  (`/golden-cache`), `depsCache.remote.pvcName`.
- EFS RWX volume mounted **read-only** into the sandbox container at the mount
  path; sets `GOLDEN_CACHE_REMOTE`. Whole volume (repo-agnostic, per §5); daemon
  reads only its `<repoHash>/` prefix.
- Writes go through the trusted writer (§7), never the tenant mount.

**Image dependency**: the sandbox image (`studio-sandbox:local`) ships `tar`,
`gzip`, `xz`, `bash` but **not `zstd`** (the golden path uses coreutils `cp`, no
compressor). Add `zstd` to the image Dockerfile — it's the right
speed/ratio/decompress trade. Fallback `gzip` works but is slower and
single-threaded.

#### Benchmark (2026-07-14, measured)

Real tree: this repo's `node_modules` — **2.3 GB, 168k files** (≈3× a typical
deco-site, so a pessimistic upper bound). `studio-sandbox:local` under Docker,
extract to the container's internal disk.

| Step | 2.3 GB / 168k files (measured) | ~700 MB / ~55k files (linear projection) |
|---|---|---|
| Archive size, `zstd -3` / `-19` | 450 MB / 332 MB | ~140 MB / ~100 MB |
| Publish `tar\|zstd -3` (off critical path) | 26s (`-19`: 85s) | ~8s |
| zstd decompress (pipelined) | 1.6s | ~0.5s |
| **Untar-write, `--cpus=2`** (the dominant, critical-path cost) | **10–14s** (`--cpus=1`: 12s) | **~3–5s** |
| **Est. total L2 restore** (decompress ‖ untar + EFS read of the blob) | **~12–16s** | **~4–7s** |

Findings:
- **The estimate holds.** A typical deco-site restore lands ~4–7s; only a
  monorepo-scale tree reaches the top of the 5–15s range.
- **It's fs-write-bound, not CPU-bound** (`cpu=1 ≈ cpu=2`; `sys` time dominates).
  So the lever is the target disk's small-file write speed, not cores. Node disk
  is known (§11): **EBS gp3 xfs (~40 GiB)** — IOPS-limited, so a real-node
  direct-untar could exceed this Docker-VM number. This matters for the
  **P1b-interim** (tenant untars directly); it does **not** matter for the **P2
  end state**, where the tenant does a ~1s reflink (metadata CoW on xfs) and the
  warmer eats the gp3-bound untar off-path at node boot.
- L2 (~4–7s) is far below a cold registry install of a 700 MB tree (tens of
  seconds — hundreds of packages fetched + extracted + linked; see the
  instant-branches RFC's cold-boot figures), which is exactly the case L2 covers
  (fresh node, no bun cache). It does **not** beat L1 reflink (~1s) — so L1 stays
  the fast path and L2 fills its misses, as designed.

Exit criterion: re-run on a real sandbox node (P0's `install_ms` gives the cold
install to beat); ship if p50 L2 restore < that. The laptop proxy says the
margin is comfortable for typical projects.

### P2 — node-warmer DaemonSet (eager per-node seeding)

Instead of the first sandbox pod on a node paying the L2 untar and seeding L1 as
a side effect (lazy, per-pod), a **DaemonSet** pre-seeds each sandbox node's
local golden dir at node boot (eager, per-node). Sandbox pods then hit L1
reflink (~1s) and — for the warmed hot set — **never touch EFS at all**.

- **Placement**: one pod per node, scoped to the sandbox pool by the **existing**
  `nodeSelector: decocms.com/nodepool: sandbox` + toleration of
  `decocms.com/sandbox=true:NoSchedule` (from `deco-apps-cd`
  `apps/studio-sandbox-prod/values.yaml`) — reuses node config, no new NodePool.
  A **PriorityClass** lets it schedule and survive ahead of tenant workloads on a
  fresh node. DaemonSet + PriorityClass are the infra track, **bundled into the
  warmPool provisioning** (Nicácio's call — confirmed), PR'd in terraform/eks-setup
  when we implement.
- **This directly lifts the current ceiling.** Prod already tries to raise the
  node-local hit rate with a **`podAffinity` packing** heuristic
  (`values.yaml`: pack sandbox pods onto fewer nodes so the hostPath golden is
  warm for more repos/node) — and the config comment names its own ceiling:
  *"warm-pool pods are scheduled before they know their repo, so this raises hit
  probability by packing; it can't target a specific repo's node."* The EFS
  warmer is exactly what targets a repo's node — it seeds the golden **before**
  any pod lands, which packing can't.
- **The warmer** (a small tool/script in the DaemonSet pod): mount EFS → read a
  **hot-set manifest** → `zstd -dc | tar -x` each golden into the node's
  `/var/cache/studio-sandbox-deps/golden/<key>/` → stay resident and refresh
  periodically. It pays the untar cost (§6 benchmark, a few s/repo) **once per
  node, off the tenant critical path**.
- **Hot set, not everything**: the warmer can't pre-seed every repo onto every
  node (long tail = fills node disk; the `values.yaml` DiskPressure caveat). It
  seeds the **top-N hottest repos**, identified by P0's `repo_hash` metric.
  Bounded to fit the node's disk budget (open Q — infra).
- **Gating**: use Karpenter **`startupTaints`** on the sandbox NodePool (e.g.
  `decocms.com/warming=true:NoSchedule`) — a taint present at node registration
  that only the warmer tolerates; the warmer removes it once seeded, and only
  then do sandbox pods schedule. Idiomatic (CNIs use this). Cost: adds the
  warmup time to node scale-up. Mitigation: remove the taint after a **minimal**
  hot set (top 1–2 repos) is ready and keep warming the rest in the background,
  so scale-up waits on ~one golden, not the whole set. (The `startupTaints` line
  is a terraform NodePool change — bundled with the warmPool provisioning.)

**Coverage of the long tail** — two models, decided by P0's concentration data:
- **Warmer-only** (cleanest): repos outside the hot set fall back to a normal
  install; **tenant pods never mount EFS** (see §7). Great if concentration is
  high.
- **Warmer + tenant fallback**: the warmer covers the head; tenant pods also
  mount EFS read-only (P1b) for the tail. Full coverage, but tenants touch EFS.

Build P2 only if P0's miss rate × §2's ~22 pods/node shows eager warming beats
letting L1 warm itself lazily. Keep L1's code path intact so it slots in without
rework.

## 7. Security — the part that gets *worse* on a shared store

**The cleanest posture (P2 warmer-only model): keep untrusted pods off EFS
entirely.** If the node-warmer DaemonSet (§6 P2) is the only EFS reader on a node
and the publish path is the only writer, then no user-code pod ever mounts the
shared store — tenants only reflink from the node-local golden the warmer seeded.
That removes the whole class of risk below. The controls here apply to the P1b
interim (and the "tenant EFS fallback" tail model), where tenant pods do mount
EFS.

A single RWX EFS volume in untrusted, user-code pods **widens the "bun installs
cached content as-is" RCE surface from node-local to cluster-wide**: a
compromised pod with write access could poison another repo's archive, which
then installs into other tenants across the fleet. Controls, all required:

1. **Tenant mount is read-only.** The sandbox container mounts EFS `readOnly:
   true`. A compromised pod can *restore* (read) but cannot *poison* (write).
   This is the load-bearing control and it directly satisfies the existing
   `values.yaml` rule ("read-only to tenant pods").
2. **Writes go through a trusted writer — reuse the org-fs sidecar.** Every
   sandbox already runs a privileged, trusted org-fs sidecar; it (not the tenant
   container) mounts EFS read-write and performs the publish when the daemon
   signals "healthy, publish `<repoHash>/<key>`". No new infra, and it matches
   the existing trust split (only the sidecar is privileged). *Alternative:* an
   out-of-band golden builder (clone+install+publish in a trusted job, à la the
   snapshot RFC) if we want zero tenant-adjacent writes — cleaner, more infra;
   pick at P1 design.
3. **Per-repo key stays the boundary, plus verify-on-restore.** Cross-repo
   *read* exposure (a tenant reading another repo's tarball) leaks only a
   dependency set, not source or secrets — acceptable for v1 under the same
   same-trust-domain argument as today. If that's later unacceptable, EFS access
   points per repo (fights warm pods — revisit). Publish records a content hash;
   restore verifies it against a trusted-side manifest, so even a mount
   misconfiguration can't silently install tampered content.

Same-repo sharing stays fine (one trust domain). Cross-repo never shares a
writer.

## 8. Cost

- `tar.zst` golden ≈ 100–250MB vs the ~700MB tree — cheaper to store and move;
  one per `(repo, lockfile)`, GC'd (TTL 7d / max 5, already implemented, applied
  to both stores).
- EFS bills per-GB + throughput; a bounded, compressed, GC'd set is small.
  Pricier per-GB than instance-store, bought against a full registry install on
  the same-node misses out of ~4,900 boots/day. Passed through to the customer.
- **S3 alternative**: cheaper per-GB, purpose-built for blobs; the daemon already
  speaks a WebDAV/rclone client (org-fs). But EFS is a mount path (near-zero new
  code) with RWX sharing free. **EFS first**; S3 if the bill later justifies the
  plumbing. Nothing in the daemon transport (tar/zstd to a path) is
  EFS-specific, so the backend is swappable.

## 9. Testing & rollout

- **Unit** (`golden-cache` remote backend): key derivation, temp+atomic-rename,
  GC over the remote store, verify-on-restore hash mismatch → fall back to
  install (never install tampered content). Pure-fs, no network.
- **e2e** (`daemon.git.e2e`-style, real files): publish → new "node" (fresh temp
  `DEPS_CACHE_ROOT`, `GOLDEN_CACHE_REMOTE` pointing at a shared temp dir) →
  restore hits L2, `node_modules` present, `bun install` skipped. Discriminating:
  with `GOLDEN_CACHE_REMOTE` unset, the same case falls through to install.
- **Rollout**: `GOLDEN_CACHE_REMOTE` unset = today's behavior, so P1 ships dark;
  enable per-env via the chart value, watch `deps.restore{source}` and
  `restore_ms`. Rollback = unset the env (no redeploy of the image needed).
- **Validation before "done"** (per repo norm): tail a bound pod through
  clone→install on a fresh node and confirm an L2 hit in the daemon setup stream
  + the mesh metric increment — not just a green unit test.

## 10. Phased plan & acceptance

| Phase | Scope | Ships alone? | Gate |
|---|---|---|---|
| **P0a** | Daemon telemetry channel: `MeterProvider` + OTLP push exporter, non-blocking SIGTERM flush, egress path to the collector (§6 P0) | prerequisite | a daemon-emitted point lands in Grafana |
| **P0b** | Metrics on the working cache: `deps.restore{source,repo_hash}`, `install_ms`, `restore_ms` | after P0a — sizes the cross-node opportunity | metrics visible in Grafana |
| **P1a** | Infra: EFS CSI driver + filesystem (Elastic) + per-AZ mount targets + PV/SC | prerequisite | PVC binds RWX across AZs |
| **P1b** | Daemon remote transport + read-only tenant mount + trusted-writer publish (org-fs sidecar) | after P1a | L2 restore p50 < cold install (P0) |
| **P2** | Node-warmer DaemonSet: pre-seed node-local golden hot set from EFS; PriorityClass; (infra: DaemonSet + taint) | Yes | P0 shows eager warm beats lazy L1 + concentration supports a hot set |

Watch across phases: `deps.restore{source}` split (L1/L2/miss), `install_ms`,
`restore_ms{source}`, EFS throughput headroom, repo-concentration per node (from
`repo_hash`).

## 11. Open questions

0. **Sandbox → collector egress path** (blocks P0a). Preference: reuse the
   `gateway-otlp-ingest` LoadBalancer on 443, which already clears netinit with
   no rule change — pending confirmation of what auth that listener expects.
   Otherwise a destination-scoped ACCEPT inserted before `blockCIDRs` (§6 P0).
   Either way, decide the attribute allowlist that bounds metric-injection from
   user-code pods.
1. **L2 restore latency** — *answered* (§6 P1b benchmark): ~4–7s for a typical
   deco-site, fs-write-bound. Node disk is now known: EBS gp3 xfs (~40 GiB). So
   the P1b tenant untar is gp3-IOPS-bound (could exceed the Docker-VM number) —
   **but with the P2 warmer the tenant path is a reflink (metadata CoW on xfs,
   ~1s regardless of gp3), and the slow untar is the warmer's, paid off-path at
   node boot.** So the gp3 floor matters only for the P1b-interim direct-untar,
   not the P2 end state. Confirm the P1b-interim number on a real node.
2. **Trusted writer**: org-fs sidecar (reuse, less isolation) vs out-of-band
   builder (more infra, zero tenant-adjacent writes). Decide at P1 design.
3. **Layer A (bun download cache)** — worth the archive treatment too, or does
   golden-only (skips install entirely on a hit) capture enough? Start
   golden-only; the metric will show residual install cost on L2 hits (none
   expected — golden hits skip install).
4. **EFS throughput mode** under a thundering herd of cold nodes pulling
   archives at once — does Elastic hold restore latency? Confirm in the P1b
   benchmark.

### P2 node-warmer — all resolved (config + cluster)

Mostly answered by `deco-apps-cd/apps/studio-sandbox-prod/values.yaml` +
`values.yaml`:
- **Provisioning** (Q7): terraform/eks-setup, PR'd when we implement, **bundled
  into the warmPool provisioning**. Decided.
- **Gating** (Q6): Karpenter `startupTaints` + warmer-removes (§6 P2). Feasible;
  the `startupTaints` line rides the same terraform NodePool change.
- **Node scoping**: existing `decocms.com/nodepool: sandbox` +
  `decocms.com/sandbox=true:NoSchedule` — the warmer reuses them.
- **Per-pod disk**: prod `ephemeral-storage` limit is **8 Gi**, `/app` emptyDir
  4 Gi — a golden extracts into `/app` and fits (a 700 MB tree easily; even the
  2.3 GB pessimist is under 4 Gi). The **node** golden store is a separate
  hostPath (`/var/cache/studio-sandbox-deps`), node-level, already in use today
  (golden is on in prod) — so goldens already accrue per node.

- **Node disk** (found via node-exporter, no need to ask): sandbox nodes are
  **Bottlerocket** with a **~40 GiB (some 60 GiB) `xfs` data volume**
  (`/dev/nvme1n1p1`, EBS gp3) mounted at `/var` — where the golden hostPath
  lives. **~25–44 GiB free** in steady state today. So the golden store shares
  ~40 GiB with images + all pods' ephemeral storage, GC-bounded (TTL 7d, max 5/
  repo) as it already is in prod. Budget: at ~0.7–2.3 GB per *extracted* golden,
  a hot set of N≈3–5 repos fits comfortably in the free headroom; if we want
  more, bump the gp3 data-volume size in the NodePool's EC2NodeClass (terraform,
  trivial for gp3 — some nodes are already 60 GiB). **`xfs` also confirms reflink
  works** (matches golden being live in prod).

Nothing left to ask — all resolved from cluster + charts.

Owned by me (Claudio), not questions: the warmer tool, hot-set selection (from
P0's metric), daemon metrics + transport, refresh/GC in the warmer (coexists
with the existing housekeeper, `idleTtlSeconds: 600`). Not open: reflink
viability — golden runs in prod, so reflink works on the current nodes.
