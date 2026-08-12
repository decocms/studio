---
name: self-host-studio
description: Install and self-host deco Studio (the open-source control plane) on the user's own infrastructure. Use when the user wants to install, run, self-host, or deploy Studio locally (Docker, Rancher Desktop, kind, minikube) or on Kubernetes (managed or self-managed), or asks to "install Studio", "self-host decocms", configure the Studio Helm chart, or troubleshoot a Studio install. Detects the environment, picks the right tier, configures the charts correctly, validates end-to-end, and fixes the common failure modes.
---

# Self-host deco Studio

Guide a user from nothing to a running, reachable Studio on their own infra.
Be interactive: detect what they have, pick ONE tier, configure the chart(s)
correctly, run it, then **verify it actually works** (pods Running + UI reachable
+ signup) — don't just report "installed".

Studio hard-needs **PostgreSQL** and an **S3-compatible object store**; NATS is
bundled; the sandbox (code-exec + previews) is an optional layer.

**What you produce is a directory, not a running pod.** Every install — laptop
or EKS — ends with an install directory the user owns and keeps: an umbrella
chart with pinned OCI dependencies plus the values you filled in. Installing is
then `helm upgrade --install` on that directory, and it behaves the same on
Rancher Desktop and on a managed cluster — see "The artifact" below. **Do not
clone this repo** and do not install from a checkout; the charts are public OCI
artifacts and need no credentials.

## 0. Detect the environment

Detect what the user has:

```bash
uname -m                                   # arm64 (Apple Silicon) or x86_64
docker version --format '{{.Server.Version}}' 2>/dev/null || echo "no docker"
kubectl config current-context 2>/dev/null || echo "no kube context"
kubectl get nodes -o custom-columns='ARCH:.status.nodeInfo.architecture' --no-headers 2>/dev/null
kubectl get storageclass 2>/dev/null       # note the (default) one
helm version --short 2>/dev/null || echo "no helm"
```

No managed Kubernetes? Any local cluster works (all core images are multi-arch,
Apple Silicon included): Rancher Desktop, Docker Desktop, k3d, kind, minikube,
Colima/OrbStack.

## Interview — ask, then fill a values file

Drive the install by ASKING, one question at a time; don't assume. Confirm the
detected environment, then walk these. Record answers into a values file you'll
`helm template`-validate and show the user before installing.

1. **Goal / tier** — "Trying it out, a POC on a real cluster, or production?"
   → *try-out* → Compose (no artifact), or the artifact with bundled dev deps.
   → *POC on a real cluster* → the artifact, deps you choose below, dev-grade secrets OK.
   → *production* → the artifact + external secrets + HPA.

2. **Each dependency — managed or in-cluster?** (ask per item)
   - **PostgreSQL** (required): managed URL (`database.url` / `DATABASE_URL`) OR
     their own in-cluster Postgres. The chart bundles none — for a local tier
     the artifact carries a throwaway one in `templates/`.
   - **Object storage** (required — else the API crashes self-provisioning MinIO):
     managed S3/GCS/R2 (`S3_FORCE_PATH_STYLE=false`) OR in-cluster MinIO/Ceph
     (`true`). Always set `S3_ENDPOINT`+`S3_BUCKET`+ keys.
   - **ClickHouse** (monitoring dashboard, optional): none / managed
     (`CLICKHOUSE_URL`) / in-cluster (chart's `clickhouse-operator`+`-cluster`
     subcharts → two-phase CRD; then provision the `studio_monitoring_logs` view).
   - **NATS**: bundled (default) OR their own (`nats.enabled=false` + `NATS_URL`).

3. **Reachability / ingress** — the public URL → `BASE_URL` + `BETTER_AUTH_URL`
   (`http://studio.localhost` locally; `https://studio.<domain>` real). The
   chart's Ingress is optional and OFF by default, so ask what they have:
   - **have an ingress controller** (nginx/Traefik/ALB)? → set `ingress.enabled=true`
     + `className` + `hosts[].host` with a `/` `Prefix` path, and `tls` (chart
     0.13.0+; it backs onto the release's own Service). Render fails if `hosts`
     is empty or a host has no paths.
   - **cloud, no controller?** → `service.type=LoadBalancer` + DNS/TLS at the LB.
   - **Istio/Gateway API?** → leave `ingress.enabled=false`, add Gateway + HTTPRoute.
   Locally it's just the `LoadBalancer:80` servicelb.
   Whatever they pick, `BASE_URL`/`BETTER_AUTH_URL` must equal the public URL —
   auth callbacks come from those, not from the request host.

4. **Secrets** — how do they manage secrets? (ask; never inline in git)
   - **External Secrets Operator?** → `externalSecret.enabled=true` + `secretPath`
     + `secretStoreName`.
   - **No ESO** (common) → they create a plain Secret and set `secret.secretName`;
     the chart injects every key. Give them the command:
     `kubectl -n <ns> create secret generic studio-secrets --from-literal=BETTER_AUTH_SECRET=… --from-literal=ENCRYPTION_KEY=… --from-literal=S3_ACCESS_KEY_ID=… --from-literal=S3_SECRET_ACCESS_KEY=… --from-literal=DATABASE_URL=… [--from-literal=STUDIO_SANDBOX_SENTINEL_TOKEN=…]`
   - **Local/dev** → fixed inline values are fine (chart-managed Secret).
   `BETTER_AUTH_SECRET` + `ENCRYPTION_KEY` MUST be stable across restarts.

5. **Sandbox (code-exec + previews)?** The sandbox is NOT part of the Studio
   chart — it's **two separate charts** installed into `agent-sandbox-system`:
   `sandbox-operator` (cluster-wide CRDs + controller) + `sandbox-env` (per-env
   template/RBAC/warm pool). So a full install = Studio chart + these two + they
   must agree. If yes, you MUST wire all three or claims fail (the usual blockers):
   - `serviceAccount.create: true` on Studio (runs as the SA the sandbox RBAC
     grants; `default` → 403 "cannot create sandboxclaims").
   - a **shared sentinel token**: the SAME value in `sandbox-env.sentinel.token`
     and Studio's `STUDIO_SANDBOX_SENTINEL_TOKEN` (generate one: `openssl rand -hex 32`).
     Missing → Studio cold-provisions and the template rejects `DAEMON_TOKEN`.
   - `STUDIO_SANDBOX_PROVIDER=agent-sandbox`, `STUDIO_ENV=<env>`,
     `STUDIO_SANDBOX_TEMPLATE_NAME=studio-sandbox-<env>`.
   All three live in ONE artifact, so the values file is the only place the
   handshake has to be right.
   Preview URLs need the preview Gateway (prod) or the in-process proxy (local).
   (In-cluster **ClickHouse** is likewise separate-ish — the Studio chart's
   `clickhouse-operator`/`-cluster` subcharts, opt-in, two-phase CRD.)

6. **Write the artifact → validate → confirm → install.** Generate the directory
   below, `helm dependency build`, `helm template` it, show the user the plan,
   then install and **verify** (§3). Never install before the template renders clean.

## The artifact — a directory the user owns

A full install spans **three charts** (Studio + sandbox-operator + sandbox-env)
that must agree on a service account and a shared token. Threading that by hand
across three `helm install` commands is where installs break. So always produce
one umbrella directory instead, whatever the tier:

```
<name>/                    # e.g. studio-local, studio-prod
├── Chart.yaml             # the three charts as OCI dependencies, versions PINNED
├── values.yaml            # every interview answer + the cross-chart handshake
├── templates/             # the user's own extras live here
├── secrets.sh             # commands that create the Secret — gitignored, never committed
├── .gitignore             # charts/  Chart.lock  secrets.sh
└── README.md              # install / upgrade / verify / uninstall, for whoever inherits this
```

This is the deliverable. It is portable — the same directory installs on Rancher
Desktop and on EKS, because nothing in it points at a local path — and it is
reviewable, diffable, and committable to *their* infra repo. It is also how
deco's own internal deploy works.

`<name>/Chart.yaml`:
```yaml
apiVersion: v2
name: <name>
version: 0.1.0
dependencies:
  # `repository` is the PARENT path — Helm appends the chart name. The Studio
  # chart and the sandbox charts publish under DIFFERENT parents; using
  # oci://ghcr.io/decocms for the sandbox ones 404s on `helm dependency build`.
  - { name: chart-deco-studio, version: "<pin>", repository: "oci://ghcr.io/decocms" }
  - { name: sandbox-operator,  version: "<pin>", repository: "oci://ghcr.io/decocms/studio/charts" }
  - { name: sandbox-env,       version: "<pin>", repository: "oci://ghcr.io/decocms/studio/charts" }
```

**Pin real versions, never `"*"` or a range.** Resolve the current ones first and
write those numbers in:

```bash
helm show chart oci://ghcr.io/decocms/chart-deco-studio            | grep '^version:'
helm show chart oci://ghcr.io/decocms/studio/charts/sandbox-operator | grep '^version:'
helm show chart oci://ghcr.io/decocms/studio/charts/sandbox-env      | grep '^version:'
helm dependency build <name>   # proves every path and pin before any values work
```

`<name>/values.yaml` — nest each subchart's config under its name, wiring the
interview answers AND the cross-chart handshake:
`chart-deco-studio.serviceAccount.create=true`, the shared sentinel token on both
`chart-deco-studio…STUDIO_SANDBOX_SENTINEL_TOKEN` and `sandbox-env.sentinel.token`,
and `sandbox-operator.allowForeignNamespace=true` (the operator self-pins to
`agent-sandbox-system` regardless).

`<name>/templates/` — the user's extras: ExternalSecrets, a CNPG Postgres, extra
config. For a **local** tier, also drop in throwaway Postgres + MinIO; the
reference copy is self-contained (it reads no values), so fetch it verbatim:

```bash
mkdir -p <name>/templates && curl -fsSL \
  https://raw.githubusercontent.com/decocms/studio/main/selfhost/examples/k8s-local/templates/dev-deps.yaml \
  -o <name>/templates/dev-deps.yaml
```

That gives fixed Services `studio-db` and `studio-minio` to point `database.url`
and the `S3_*` values at. **Local only** — say so in the README you generate, and
never suggest it for a real cluster.

`<name>/secrets.sh` — the `kubectl create secret` command with the generated
values, so a rerun is reproducible. Gitignore it; never inline secret material in
`values.yaml`. With ESO, skip it and set `externalSecret.*` instead.

For the value shapes (managed vs in-cluster deps, secrets with and without ESO,
ingress, sandbox posture, compute sizing) read
[`selfhost/production`](https://github.com/decocms/studio/tree/main/selfhost/production)
and the [Kubernetes guide](https://docs.decocms.com/deco-studio/en/studio/self-hosting/deploy/kubernetes).

## 1. Pick a tier

The tiers differ in what `values.yaml` says, not in how you install. Kubernetes
tiers produce the same artifact and the same command; only the dependency
choices and the secret handling change.

| Tier | Deps | Best for |
|------|------|----------|
| **Local — Compose** | all bundled, no Kubernetes | trying it out on one host |
| **Local — Kubernetes** | throwaway Postgres + MinIO in `templates/`, bundled NATS | testing on a laptop cluster |
| **Production — Kubernetes** | **external/managed** Postgres + S3, optional managed ClickHouse | staging / prod |

### 1a. Compose (bundled everything)

The only tier with no artifact — it is a single compose file, not Helm. Runs
Studio + Postgres + NATS + MinIO, all wired, no external services:

```bash
curl -fsSLO https://raw.githubusercontent.com/decocms/studio/main/deploy/docker-compose/docker-compose.postgres.yml
docker compose -f docker-compose.postgres.yml up
```

`open http://localhost:3000`, sign up (first user = org owner). Override the dev
defaults via a `.env` next to the compose file.

### 1b. Install the artifact (both Kubernetes tiers)

```bash
helm dependency build <name>
helm template deco-studio <name> -n deco-studio | less    # never skip
helm upgrade --install deco-studio <name> -n deco-studio --create-namespace
```

Use release name **`deco-studio`** (the Studio subchart derives Service/SA/NATS/
instance-label names from it; sandbox RBAC is granted to the `deco-studio` SA).
Re-running the same three commands is how upgrades work — see §5.

**Access — port-forward is the reliable path**, any cluster:
`kubectl -n deco-studio port-forward svc/deco-studio 8080:80` → `http://localhost:8080`.
If you set `service.type: LoadBalancer` locally, `http://studio.localhost` works
**iff** the LB actually claimed host :80 — on stock Rancher Desktop, k3s Traefik's
servicelb already owns :80, so Studio's LB stays `<pending>` and the URL hits
Traefik (404). Check `kubectl -n deco-studio get svc` before promising a URL. For
a real cluster, use the chart's `ingress` block (0.13.0+) instead.

**Observability** (ClickHouse monitoring dashboard + OTel collector) is opt-in via
the Studio chart's `clickhouse-operator`/`clickhouse-cluster` subcharts. Two
caveats: the operator ships its CRDs as templates rather than in `crds/`, so a
first install needs a two-phase (cluster CR off → CRD exists → CR on); and once
ClickHouse is running you must provision the `studio_monitoring_logs` view over
`otel_logs` or the dashboard 500s. Never flip `clickhouse-cluster.enabled=false`
on a live release — the operator deletes ClickHouse. On older k8s the operator's
version-probe races Job-pod GC and leaves the collector crashlooping; if that
happens, drop observability rather than fighting it.

### 1c. Production values

The chart is **lean**: it deploys Studio + NATS and expects **external** managed
services. Configure them (never inline secrets in prod — use `externalSecret` or
`secret.secretName`):

The chart still calls its Studio environment map `configMap.meshConfig` for
upgrade compatibility. Treat that name as deprecated; the values configure the
Studio API.

```yaml
database:
  url: "postgresql://user:pass@your-db:5432/studio"   # or via secret/externalSecret
configMap:
  meshConfig:
    S3_ENDPOINT: "https://s3.amazonaws.com"           # managed object storage
    S3_BUCKET: "your-bucket"
    S3_FORCE_PATH_STYLE: "false"                       # true for MinIO/Ceph
    CLICKHOUSE_URL: "https://…"                        # optional monitoring
    # NATS_URL: "nats://your-nats:4222"               # only if nats.enabled=false
# S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY, BETTER_AUTH_SECRET, ENCRYPTION_KEY →
# via externalSecret or an existing Secret (secret.secretName).
autoscaling: { enabled: true }        # API HPA
worker: { autoscaling: { enabled: true } }
externalSecret: { enabled: true, secretPath: "/prod/studio" }
```

Every dependency is a toggle: **bundled** (`postgresql.enabled` — dev only /
`nats.enabled`) OR **external** (a URL/secret). In prod, point at managed.

## 2. Configure the sandbox (code-execution + previews)

Optional layer: `sandbox-operator` (CRDs + controller) + `sandbox-env`
(SandboxTemplate/RBAC/NetworkPolicy) + Studio wiring. The local umbrella
belongs in the same artifact, wired in its `values.yaml`.
For a standalone/prod install, wire Studio with:

```yaml
configMap:
  meshConfig:
    STUDIO_SANDBOX_PROVIDER: "agent-sandbox"          # or "user-desktop" (laptop via NATS link)
    STUDIO_ENV: "<envName>"
    STUDIO_SANDBOX_TEMPLATE_NAME: "studio-sandbox-<envName>"
```

Production posture (see `selfhost/production/values-sandbox-env-prod.yaml`):
**egress lockdown** (`netinit` iptables: REJECT in-cluster CIDRs, allow 443+53),
dedicated tainted **NodePool**, zone spread, **warm pool**, sentinel token, and
wildcard **preview URLs** (Istio Gateway + cert-manager; needs Gateway API CRDs).

## 3. Verify (do not skip)

- All pods `Running`: app `deco-studio` (3/3), `deco-studio-worker`, `nats`,
  plus deps. K8s: `kubectl -n deco-studio get pods`.
- DB reachable, UI loads, **signup works** (first user = owner; no preset admin
  in the served `--no-local-mode`).
- Access: `kubectl -n deco-studio port-forward svc/deco-studio 8080:80`; a
  LoadBalancer/Ingress URL only after checking `kubectl -n deco-studio get svc`.

## 4. Troubleshooting (real failure modes)

| Symptom | Cause → Fix |
|---------|-------------|
| App pod `Pending`, PVC "no storage class is set" | chart set `storageClassName: ""` (disables provisioning) → set `persistence.storageClass` or use a chart that omits it when empty |
| Pods `Pending` on Apple Silicon | `nodeSelector` pinned to amd64 → `nodeSelector: {}` (core images are multi-arch) |
| App `CrashLoop` with AWS-SDK `ECONNREFUSED` at boot | no S3 configured → the app tries to self-provision MinIO and fails; set `S3_ENDPOINT`+`S3_BUCKET`+`S3_ACCESS_KEY_ID`+`S3_SECRET_ACCESS_KEY` (bundled MinIO locally, managed S3 in prod) |
| App/worker restarts early with `ECONNREFUSED :5432` | started before Postgres ready — benign, self-heals |
| `insufficient storage resources` (NATS JetStream) | file store too small → raise `nats.config.jetstream.fileStore.pvc.size` (non-fatal) |
| Sandbox pod `ImagePullBackOff` (manifest unknown, or "no matching manifest for linux/arm64") | overrode `sandbox-env.image.tag` with a stale/nonexistent tag — the daemon image is `studio-sandbox-go` and old `studio-sandbox` tags don't exist in it → drop the override and use the chart's own pin (multi-arch) |
| `SandboxClaim` create → `403 Forbidden ... serviceaccount:deco-studio:default cannot create` | Studio ran as SA `default` but sandbox RBAC is granted to SA `deco-studio` → set `serviceAccount.create: true` so Studio runs as `deco-studio` (set it in the artifact's values) |
| `SandboxClaim` stuck, condition `ReconcilerError: environment variable override is not allowed ... "DAEMON_TOKEN"` | Studio has no sentinel token → it cold-provisions (`warmpool: none`) and injects `DAEMON_TOKEN`, which the template rejects → set the SAME token on both sides: `sandbox-env.sentinel.token` and `STUDIO_SANDBOX_SENTINEL_TOKEN` (flips Studio to warm-pool mode; the artifact must set both) |
| Monitoring dashboard 500 / `UNKNOWN_TABLE: studio_monitoring_logs` | ClickHouse connects fine but the view isn't provisioned → apply the DDL from `apps/api/src/monitoring/clickhouse-setup.md` once ClickHouse is up and `otel_logs` exists |
| ClickHouse torn down / `UPGRADE FAILED` after a re-run with observability | disabling the `clickhouse-cluster` CR on a running release makes the operator delete ClickHouse → only two-phase when the CRD is ABSENT (first install) — never do `--set clickhouse-cluster.enabled=false` on a live release |
| `helm install` fails "must be installed into the 'agent-sandbox-system' namespace" | installing `sandbox-operator` as a subchart under another release namespace → set `sandbox-operator.allowForeignNamespace=true` (operator resources are pinned to agent-sandbox-system regardless); the umbrella does this |
| `kind: SandboxTemplate` / CRD not found on install | operator's CRDs must exist before the CR → the operator ships them in `crds/` (installed before templates), so a single umbrella release works; if you installed the charts separately, install the operator and wait for the CRD first |
| Namespace stuck / "object has been deleted" on re-install | previous `uninstall` still Terminating → wait for it to clear before recreating |

Always show real evidence (`kubectl get pods`, `logs`, `get events
--sort-by=.lastTimestamp`) before concluding.

## 5. Updates (re-running / upgrading)

Edit the artifact, then run the same three commands:

```bash
helm dependency build <name>          # only needed after changing a pin
helm template deco-studio <name> -n deco-studio | less
helm upgrade --install deco-studio <name> -n deco-studio
```

The artifact is the source of truth, so an upgrade is a diff someone can review:

- **New chart version** → bump the pin in `Chart.yaml`, re-run `helm dependency
  build`, re-render, upgrade. Because the pins are explicit, nothing moves
  underneath the user between two installs of the same directory.
- **New Studio image** → set `chart-deco-studio.image.tag` (and
  `nginx.image.tag`) and upgrade. Leaving them unset resolves to the chart's
  appVersion, which is `latest` — fine locally, wrong for anything real.
- **Toggle change** (warm pool, sandbox, observability) → edit `values.yaml`.
  Never `--set` a toggle straight onto a live release; the change would not
  exist in the artifact and the next upgrade would silently revert it.
- **ClickHouse**: on re-runs leave the cluster CR enabled. Disabling it makes the
  operator delete ClickHouse. The `studio_monitoring_logs` view survives, but
  re-apply it (`CREATE OR REPLACE`) if you rebuilt the database.
- Sandbox pool pods that stay not-ready after a values change are picking up a
  stale secret/template — delete them and let the pool respawn.

One caveat NOT auto-caught: if a new chart version **renames or removes** a
values key the artifact sets, nothing errors — the wiring silently no-ops. After
bumping a pin across several versions, `helm template` and skim for values that
stopped appearing in the render before trusting the upgrade.

## 6. Teardown

```bash
helm uninstall deco-studio -n deco-studio
kubectl delete ns deco-studio agent-sandbox-system
docker compose -f docker-compose.postgres.yml down -v   # compose tier
```

That leaves the cluster-scoped CRDs (agent-sandbox + clickhouse.com). For a truly
clean slate:

```bash
kubectl get crd -o name | grep -E 'agents.x-k8s.io|clickhouse.com' | xargs -r kubectl delete
```

## Hand the artifact over

Finish by telling the user what they now own, because the directory outlives this
session and probably outlives them in the role:

- The directory is the install. Commit it to their infra repo — minus
  `secrets.sh`, `charts/`, and `Chart.lock`.
- Reinstalling anywhere is `helm dependency build` → `helm template` →
  `helm upgrade --install`. Nothing else is required, and no clone of this repo.
- Every pin is explicit, so a rebuild months from now produces the same thing.
- The generated `README.md` should state: the release name, the namespaces, which
  values are dev-only, where the secrets come from, and how to upgrade.

## Notes

- Bundled Postgres/MinIO are dev-only; production points at managed services.
- The official chart stays lean — no bundled DB/object store. Batteries-included
  lives in Compose and in the artifact's own `templates/`.
- A clone of `decocms/studio` is only for people changing the charts themselves.
  For that dev loop the repo has `selfhost/scripts/local-k8s.sh` and
  `selfhost/examples/k8s-local`, whose `file://` dependencies deliberately track
  the working tree. That is the wrong property for an install someone must
  reproduce — never point a user at them.
- Full reference: https://docs.decocms.com (Studio → Self-hosting) and
  [`selfhost/`](https://github.com/decocms/studio/tree/main/selfhost).
