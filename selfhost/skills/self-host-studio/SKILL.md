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
bundled; the sandbox (code-exec + previews) is an optional layer. Full details
and ready-made files live in the repo under `selfhost/` and `deploy/`.

## 0. Detect the environment

First, make sure the repo is present — the install uses its Helm charts +
scripts. If `selfhost/` isn't in the working dir, offer to clone it and `cd` in:

```bash
test -d selfhost/examples/k8s-local || \
  git clone https://github.com/decocms/studio.git && cd studio
```

Then detect what the user has:

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
   → *try-out* → Compose or the local umbrella (fixed dev values, bundled deps).
   → *POC on a real cluster* → the chart with deps you choose below, dev-grade secrets OK.
   → *production* → the chart + external secrets + HPA (start from `selfhost/production/`).

2. **Each dependency — managed or in-cluster?** (ask per item)
   - **PostgreSQL** (required): managed URL (`database.url` / `DATABASE_URL`) OR
     their own in-cluster Postgres. The chart bundles none for prod (local
     umbrella has a throwaway one).
   - **Object storage** (required — else the API crashes self-provisioning MinIO):
     managed S3/GCS/R2 (`S3_FORCE_PATH_STYLE=false`) OR in-cluster MinIO/Ceph
     (`true`). Always set `S3_ENDPOINT`+`S3_BUCKET`+ keys.
   - **ClickHouse** (monitoring dashboard, optional): none / managed
     (`CLICKHOUSE_URL`) / in-cluster (chart's `clickhouse-operator`+`-cluster`
     subcharts → two-phase CRD; then provision the `studio_monitoring_logs` view).
   - **NATS**: bundled (default) OR their own (`nats.enabled=false` + `NATS_URL`).

3. **Reachability / ingress** — the public URL → `BASE_URL` + `BETTER_AUTH_URL`
   (`http://studio.localhost` locally; `https://studio.<domain>` real). The chart
   renders NO Ingress, so ask what they have and expose accordingly:
   - **have an ingress controller** (nginx/Traefik/ALB)? → they create an Ingress
     to Service `<release>`:80 with their ingressClassName + TLS.
   - **cloud, no controller?** → `service.type=LoadBalancer` + DNS/TLS at the LB.
   - **Istio/Gateway API?** → Gateway + HTTPRoute.
   Locally it's just the `LoadBalancer:80` servicelb.

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
   Preview URLs need the preview Gateway (prod) or the in-process proxy (local).
   (In-cluster **ClickHouse** is likewise separate-ish — the Studio chart's
   `clickhouse-operator`/`-cluster` subcharts, opt-in, two-phase CRD.)

6. **Render → validate → confirm → install.** Write the answers to a values
   file, `helm template … | less` (or grep the wiring), show the user the plan,
   then install and **verify** (§3). Never install before the template renders clean.

The local umbrella (`selfhost/examples/k8s-local`) already encodes all of §5 and
bundled deps — for *try-out*/*POC-local* just use it. For real clusters, start
from `selfhost/production/` and fill the answers above.

## Recommend (and generate) an umbrella chart for real installs

Because a full install spans **multiple charts** (Studio + sandbox-operator +
sandbox-env, plus their extras) that must share values, offer to generate a small
**umbrella chart the user owns** — one `helm install`, everything wired, and a
place for THEIR extras (ExternalSecrets, Ingress, a CNPG Postgres, config). This
is how `examples/k8s-local` and deco's own internal deploy work. Generate:

`<name>/Chart.yaml`:
```yaml
apiVersion: v2
name: <name>
version: 0.1.0
dependencies:
  - { name: chart-deco-studio, version: "<pin>", repository: "oci://ghcr.io/decocms" }
  - { name: sandbox-operator,  version: "<pin>", repository: "oci://ghcr.io/decocms" }
  - { name: sandbox-env,       version: "<pin>", repository: "oci://ghcr.io/decocms" }
```
`<name>/values.yaml` — nest each subchart's config under its name, wiring the
interview answers AND the cross-chart handshake: `chart-deco-studio.serviceAccount.create=true`,
the shared sentinel token on both `chart-deco-studio…STUDIO_SANDBOX_SENTINEL_TOKEN`
and `sandbox-env.sentinel.token`, `sandbox-operator.allowForeignNamespace=true`
(operator self-pins to agent-sandbox-system), and compute from `selfhost/production/`.
`<name>/templates/` — the user's extras. Then `helm dependency build` → template →
install. Copy `selfhost/examples/k8s-local` as the working reference.

If the user prefers not to wrap, install the charts separately (§2 + the chart
directly) — but flag that threading the shared values by hand is the error-prone
path.

## 1. Pick a tier

| Tier | How | Deps | Best for |
|------|-----|------|----------|
| **Local — Compose** | `docker compose -f deploy/docker-compose/docker-compose.postgres.yml up` | all bundled | trying it out, one host |
| **Local — Kubernetes** | one `helm install` of the umbrella `selfhost/examples/k8s-local` (or `./selfhost/scripts/local-k8s.sh`) | all bundled (dev Postgres+MinIO+NATS+sandbox) | testing on a real cluster |
| **Production — Kubernetes** | `helm install` the chart (`deploy/helm/studio`) directly | **external/managed** Postgres + S3 + NATS + ClickHouse | staging / prod |

### 1a. Compose (bundled everything)

Runs Studio + Postgres + NATS + MinIO, all wired — no external services.
`open http://localhost:3000`, sign up (first user = org owner). Override secrets
via a `.env` next to the compose file.

### 1b. Local Kubernetes (umbrella chart)

The umbrella `selfhost/examples/k8s-local` declares the lean Studio chart, the
sandbox operator, and `sandbox-env` as Helm `dependencies` and adds throwaway
Postgres + MinIO as its own templates.

**Recommended path — the script** (installs core + sandbox + warm pool by
default; observability is opt-in):

```bash
./selfhost/scripts/local-k8s.sh                  # install / upgrade (core + sandbox + warm pool)
OBSERVABILITY=1 ./selfhost/scripts/local-k8s.sh  # + in-cluster ClickHouse + OTel collector + monitoring view
WARMPOOL=0 ./selfhost/scripts/local-k8s.sh       # skip the warm pool
./selfhost/scripts/local-k8s.sh uninstall        # remove everything
```

It is **idempotent** — re-run any time to update (see §5). It resolves deps,
`helm upgrade --install`s, waits for rollout, bounces stuck sandbox pods, and
(with observability) provisions the `studio_monitoring_logs` view.

**Raw helm** (leaner — core + sandbox, no observability; observability via helm
needs the overlay + a one-time two-phase, which the script handles for you):

```bash
helm dependency build selfhost/examples/k8s-local
helm install deco-studio selfhost/examples/k8s-local -n deco-studio --create-namespace
```

Use release name **`deco-studio`** (the Studio subchart derives Service/SA/NATS/
instance-label names from it; sandbox RBAC is granted to the `deco-studio` SA).

**Access — port-forward is the reliable path**, any cluster:
`kubectl -n deco-studio port-forward svc/deco-studio 8080:80` → `http://localhost:8080`.
The Service is `LoadBalancer:80`, so `http://studio.localhost` ALSO works **iff**
the LB claimed host :80 — but on stock Rancher Desktop k3s Traefik's servicelb
already owns :80, so Studio's LB stays `<pending>` and `studio.localhost` hits
Traefik (404). The script detects this and prints the right path; don't promise
the URL blindly. To use the URL: disable Traefik or front Studio with an ingress.

**Observability** (ClickHouse monitoring dashboard + OTel collector) is **opt-in**
(`OBSERVABILITY=1`) — OFF by default. The clickhouse.com operator's version-probe
races Job-pod GC on older k8s (e.g. RD's 1.25), leaving the collector crashlooping
and no ClickHouse, so it's not in the default path. When enabled: the operator
ships CRDs as templates (not `crds/`), so the script does a one-time two-phase
(CR off → wait for CRD → CR on) only when the CRD is absent, and provisions the
`studio_monitoring_logs` view over `otel_logs` once ClickHouse is ready.

### 1c. Production Kubernetes — configure the chart

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
installs it by default (wired inline in `selfhost/examples/k8s-local/values.yaml`).
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
- Access: LoadBalancer → `http://localhost` (k3s/Rancher servicelb); or
  `kubectl -n deco-studio port-forward svc/deco-studio 8080:80`.

## 4. Troubleshooting (real failure modes)

| Symptom | Cause → Fix |
|---------|-------------|
| App pod `Pending`, PVC "no storage class is set" | chart set `storageClassName: ""` (disables provisioning) → set `persistence.storageClass` or use a chart that omits it when empty |
| Pods `Pending` on Apple Silicon | `nodeSelector` pinned to amd64 → `nodeSelector: {}` (core images are multi-arch) |
| App `CrashLoop` with AWS-SDK `ECONNREFUSED` at boot | no S3 configured → the app tries to self-provision MinIO and fails; set `S3_ENDPOINT`+`S3_BUCKET`+`S3_ACCESS_KEY_ID`+`S3_SECRET_ACCESS_KEY` (bundled MinIO locally, managed S3 in prod) |
| App/worker restarts early with `ECONNREFUSED :5432` | started before Postgres ready — benign, self-heals |
| `insufficient storage resources` (NATS JetStream) | file store too small → raise `nats.config.jetstream.fileStore.pvc.size` (non-fatal) |
| Sandbox pod `ImagePullBackOff` (manifest unknown, or "no matching manifest for linux/arm64") | overrode `sandbox-env.image.tag` with a stale/nonexistent tag — the daemon image is `studio-sandbox-go` and old `studio-sandbox` tags don't exist in it → drop the override and use the chart's own pin (multi-arch) |
| `SandboxClaim` create → `403 Forbidden ... serviceaccount:deco-studio:default cannot create` | Studio ran as SA `default` but sandbox RBAC is granted to SA `deco-studio` → set `serviceAccount.create: true` so Studio runs as `deco-studio` (the umbrella does this) |
| `SandboxClaim` stuck, condition `ReconcilerError: environment variable override is not allowed ... "DAEMON_TOKEN"` | Studio has no sentinel token → it cold-provisions (`warmpool: none`) and injects `DAEMON_TOKEN`, which the template rejects → set the SAME token on both sides: `sandbox-env.sentinel.token` and `STUDIO_SANDBOX_SENTINEL_TOKEN` (flips Studio to warm-pool mode; the umbrella wires both) |
| Monitoring dashboard 500 / `UNKNOWN_TABLE: studio_monitoring_logs` | ClickHouse connects fine but the view isn't provisioned → the script creates it after ClickHouse + `otel_logs` are ready; if you ran raw helm, apply the DDL from `apps/api/src/monitoring/clickhouse-setup.md` |
| ClickHouse torn down / `UPGRADE FAILED` after a re-run with observability | disabling the `clickhouse-cluster` CR on a running release makes the operator delete ClickHouse → only two-phase when the CRD is ABSENT (first install); the script does this — never do `--set clickhouse-cluster.enabled=false` on a live release |
| `helm install` fails "must be installed into the 'agent-sandbox-system' namespace" | installing `sandbox-operator` as a subchart under another release namespace → set `sandbox-operator.allowForeignNamespace=true` (operator resources are pinned to agent-sandbox-system regardless); the umbrella does this |
| `kind: SandboxTemplate` / CRD not found on install | operator's CRDs must exist before the CR → the operator ships them in `crds/` (installed before templates), so a single umbrella release works; standalone, install the operator + wait for the CRD first |
| Namespace stuck / "object has been deleted" on re-install | previous `uninstall` still Terminating → wait for it to clear before recreating |

Always show real evidence (`kubectl get pods`, `logs`, `get events
--sort-by=.lastTimestamp`) before concluding.

## 5. Updates (re-running / upgrading)

The script is **idempotent** — to update, just run it again:

```bash
./selfhost/scripts/local-k8s.sh
```

What that does, safely, on a re-run:
- **Deps track `deploy/`**: `helm dependency build || helm dependency update`
  re-resolves the local `file://` charts, so template/values changes in
  `deploy/helm/**` (and chart version bumps) flow through — no manual edits. The
  umbrella pins dependency versions as `"*"` for exactly this.
- **`helm upgrade --install`**: reconciles to the current chart. New image tags,
  values, and resources roll out. First image pull can take minutes.
- **Non-destructive observability**: the ClickHouse two-phase runs ONLY on the
  first install (CRD absent). On re-runs the CR stays enabled — ClickHouse is
  never torn down. The monitoring view is re-applied (`CREATE OR REPLACE`).
- **Self-heal**: not-ready sandbox pool pods are bounced to pick up corrected
  secrets/templates.

To pick up a **new Studio image**, bump the tag (or repull `latest`) and re-run;
Helm rolls the Deployments. To change a toggle (warm pool, observability), re-run
with the env var (`WARMPOOL=0`, `OBSERVABILITY=0`).

One caveat NOT auto-caught: if a `deploy/` chart **renames or removes** a values
key the umbrella/overlays set, nothing errors — the wiring silently no-ops.
After pulling a big `deploy/helm/**` change, `helm template` the umbrella and
skim for dropped values before trusting a re-run.

## 6. Teardown

```bash
./selfhost/scripts/local-k8s.sh uninstall          # k8s (everything)
docker compose -f deploy/docker-compose/docker-compose.postgres.yml down -v   # compose
```

The uninstall removes both namespaces but leaves the cluster-scoped CRDs
(agent-sandbox + clickhouse.com). For a truly clean slate:

```bash
kubectl get crd -o name | grep -E 'agents.x-k8s.io|clickhouse.com' | xargs -r kubectl delete
```

## Notes

- Bundled Postgres/MinIO are dev-only; production points at managed services.
- The official chart (`deploy/helm/studio`) stays lean — no bundled DB/object
  store. Batteries-included lives in Compose and `selfhost/`.
- Full reference: https://docs.decocms.com (Studio → Self-hosting) and
  `selfhost/README.md`.
