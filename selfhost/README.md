# Self-hosting deco Studio

Everything for running Studio on your own infrastructure. The **artifacts** live
under [`deploy/`](../deploy/) (the official Helm chart and the Docker Compose
stack); this folder is the **experience** around them — dev dependencies,
example values, scripts, and the install skill.

## Pick your path

| Tier | How | Dependencies | Best for |
|------|-----|--------------|----------|
| **Local — Compose** | [`examples/docker-compose`](examples/docker-compose) (`docker compose -f … up`) | all bundled (Postgres + NATS + MinIO) | trying it out, single host |
| **Local — Kubernetes** | one `helm install` of the [umbrella](examples/k8s-local) (or `./selfhost/scripts/local-k8s.sh`) | all bundled (dev Postgres + MinIO + NATS + sandbox) | testing on a real cluster (Rancher/kind) |
| **Production — Kubernetes** | `helm install` the [chart](../deploy/helm/studio) directly — see [`production/`](production) | **external/managed** Postgres + S3 + NATS + ClickHouse | staging / production |

## No managed Kubernetes? Run one locally

You don't need EKS/GKE/AKS to run the Kubernetes path — any local cluster works
(all Studio images are multi-arch, so Apple Silicon is fine):

| Runtime | Notes |
|---------|-------|
| **Rancher Desktop** | k3s under the hood; ships Traefik + local-path StorageClass. Great default. |
| **Docker Desktop** | Enable Kubernetes in settings. |
| **k3d** | k3s in Docker — fast, scriptable multi-node (`k3d cluster create studio`). |
| **kind** | Kubernetes in Docker — CI-friendly. |
| **minikube** | Classic; `minikube start`. |
| **Colima / OrbStack** | Lightweight VMs on macOS with a bundled Kubernetes. |

Any of these gives you a default StorageClass and a single node — enough for the
local-Kubernetes path below. For a prod-*like* topology (multiple nodes, zones),
`k3d cluster create studio --agents 3` is the easiest.

## The design

- **The official chart ([`deploy/helm/studio`](../deploy/helm/studio)) is lean.**
  It deploys Studio (nginx + API + worker) and bundles only NATS (an official
  upstream subchart). It expects **external** PostgreSQL, object storage (S3),
  and ClickHouse — pointed at via `database.url` / `S3_*` / `CLICKHOUSE_URL`.
  No bundled database or object store lives in the app chart.
- **"Install everything" is a self-host convenience, kept separate:**
  - **Compose** bundles every dependency as containers (the easy local path).
  - **Local-k8s** is an **umbrella chart** ([`examples/k8s-local`](examples/k8s-local))
    that declares the lean Studio chart, the sandbox operator, and `sandbox-env`
    as Helm `dependencies`, and adds throwaway Postgres + MinIO as its own
    templates — so one `helm install` brings up the whole stack, wired. It never
    touches the official chart; it just composes it.
- **Production** points the chart at managed services — the umbrella is not used.

### One-command local Kubernetes

```bash
helm dependency build selfhost/examples/k8s-local
helm install deco-studio selfhost/examples/k8s-local -n deco-studio --create-namespace
```

Use release name **`deco-studio`** — the Studio subchart derives its Service,
ServiceAccount, NATS, and instance-label names from it, and the sandbox RBAC is
granted to the `deco-studio` ServiceAccount. `scripts/local-k8s.sh` wraps these
two commands (plus a namespace-terminating guard, rollout wait, access hints,
and `uninstall`).

The umbrella's release namespace is `deco-studio`, but every sandbox resource is
pinned to `agent-sandbox-system` explicitly (the operator ships that Namespace
itself), so a single release legitimately spans both. The operator's standalone
namespace guard is opted out for this case via `sandbox-operator.allowForeignNamespace=true`.

## What Studio needs (dependency map)

- **Required:** PostgreSQL (DB + DBOS workflow engine); `BETTER_AUTH_SECRET`;
  `ENCRYPTION_KEY` (credential vault).
- **Bundled by the chart:** NATS (event-bus wake-ups + CLI link tunnel).
- **Required for a faithful run:** an S3-compatible object store (assets /
  buckets / org-fs). Locally = MinIO; in prod = managed S3.
- **Optional:** ClickHouse + OTel collector (monitoring dashboard), sandbox
  (code-execution + previews), OAuth/email providers. The local script installs
  the **sandbox** by default (opt out `WARMPOOL=0`); **observability is opt-in**
  (`OBSERVABILITY=1`).

## Observability (monitoring dashboard) — opt-in

`OBSERVABILITY=1 ./selfhost/scripts/local-k8s.sh` adds an in-cluster ClickHouse +
an OTel collector (sized tiny). It's **off by default** because the clickhouse.com
operator's version-probe races Job-pod GC on older k8s (e.g. Rancher Desktop's
1.25), which leaves the collector crashlooping with no ClickHouse — so it stays
out of the default first-run path. When enabled: Studio ships telemetry to the
collector (writes `otel_logs`); the dashboard reads a `studio_monitoring_logs`
view the script provisions once ClickHouse is ready (idempotent). Two notes:

- The clickhouse-operator ships its CRDs as templates (not `crds/`), so the
  script does a one-time two-phase (CR off → wait for CRD → CR on) ONLY on the
  first install; re-runs are single-pass and never tear down a running ClickHouse.
- Raw `helm install` stays lean (no ClickHouse). For observability without the
  script, layer `examples/k8s-local/observability.yaml` and do the two-phase
  yourself (or just use the script).

## Updating

Re-run the script any time — it's idempotent (`helm upgrade --install`) and
tracks the `deploy/` charts via `file://` deps pinned as `"*"`, so template,
values, and chart-version changes flow through with no manual edits. See the
skill's "Updates" section for the full story (and the one caveat: a renamed/
removed values key won't error — `helm template` after big `deploy/` changes).

## Developing Studio (not just running it)

- **App logic (UI / tools / API)** — plain `bun run dev` (embedded Postgres, Vite
  hot reload). Fastest loop; no cluster. See [`../CLAUDE.md`](../CLAUDE.md).
- **Sandbox / preview / k8s behavior** — [`examples/dev-hybrid`](examples/dev-hybrid):
  `bun run dev` on your host, but Postgres/NATS/MinIO **and the real
  agent-sandbox operator** come from the k8s-local install (the app in-cluster is
  scaled to 0). mesh drives the cluster's sandbox via your kubeconfig +
  API-server port-forward, so code-exec/previews work — which the laptop-only
  loop can't do.
- **The artifact itself (chart/image)** — build a local image and
  `helm upgrade --set image.tag=…`; closest to prod, slowest loop.

## Sandbox (code-execution + previews)

The sandbox is a separate layer — the `sandbox-operator` (agent-sandbox operator
+ CRDs) and `sandbox-env` charts under [`deploy/helm`](../deploy/helm), plus
Studio wiring (`STUDIO_SANDBOX_PROVIDER=agent-sandbox`). Core Studio (agents,
connections, MCP proxy) runs fine without it; enable it for the *full* install.

The umbrella installs the sandbox layer as part of the one `helm install`: the
operator, `sandbox-env` (wired inline in [`examples/k8s-local/values.yaml`](examples/k8s-local/values.yaml)),
and the Studio `STUDIO_SANDBOX_*` config. Previews run in-process locally (no
Gateway/ingress).

**Warm pool** (pre-spawned sandbox pods for zero cold-start) is **on by default**
in the umbrella (size 1) — safe now that `studio-sandbox` 1.17.3 is multi-arch.
It pre-spawns one real runtime pod, so disable it to save laptop resources with
`--set sandbox-env.warmPool.enabled=false` (or `WARMPOOL=0 ./selfhost/scripts/local-k8s.sh`);
resize with `WARMPOOL_SIZE=N`.

**Production posture** — everything the hardened sandbox needs is already in the
`sandbox-env` chart; [`production/values-sandbox-env-prod.yaml`](production/values-sandbox-env-prod.yaml)
shows it with placeholders (nothing environment-specific baked in):
- **Egress lockdown** (`netinit`): an iptables init container REJECTs
  in-cluster/link-local CIDRs and allows only 443 + 53 outbound — untrusted code
  can't reach your Services. This is the sandbox's "outbound proxy/firewall".
- **Node isolation:** pin sandbox pods to a dedicated tainted NodePool so an
  escape lands away from mesh/Postgres/NATS.
- **Zone spread**, **warm pool** (+ optional HPA), and **sentinel token**.
- **Preview URLs:** wildcard `*.<domain>` via an Istio Gateway + cert-manager
  (needs Gateway API CRDs + a DNS-01 issuer — off in the example until those
  exist).

> **Architecture:** the whole sandbox layer — operator
> (`agent-sandbox-controller`), `orgfs-sidecar`, and the `studio-sandbox` runtime
> image — is multi-arch (arm64 + amd64) from `studio-sandbox` tag **1.17.3**
> onward, which the umbrella pins. So creating and *running* a code-exec/preview
> sandbox works natively on Apple Silicon. (Older tags were amd64-only; if you
> pin one, running a sandbox on arm64 will `CrashLoop` on the image gate.)

## Access & teardown

- **Port-forward is the reliable path on any cluster:**
  `kubectl -n deco-studio port-forward svc/deco-studio 8080:80` → `http://localhost:8080`.
- The Service is `type: LoadBalancer:80`, so `http://studio.localhost` **also**
  works *when the LB actually claims host :80*. On **stock Rancher Desktop** k3s
  ships **Traefik**, whose servicelb already owns :80 — so Studio's LB stays
  `<pending>` and `studio.localhost` hits Traefik (404). To use the URL: disable
  Traefik (`rdctl set --kubernetes.options.traefik=false`) or front Studio with an
  ingress. The install script detects this and prints the right path.
- `./selfhost/scripts/local-k8s.sh uninstall` removes **everything** (Studio,
  dev deps, sandbox operator/env, namespaces).

## Layout

```
selfhost/
├── README.md              # this file
├── examples/                            # LOCAL only
│   ├── k8s-local/                       # batteries-included umbrella chart
│   │   ├── Chart.yaml                   #   deps: chart-deco-studio + sandbox-operator + sandbox-env
│   │   ├── values.yaml                  #   wires it all (dev deps, SA, sandbox, previews)
│   │   └── templates/dev-deps.yaml      #   throwaway Postgres + MinIO
│   ├── docker-compose/                  # compose example (includes the deploy/ stack)
│   │   ├── compose.yaml
│   │   └── .env.example
│   └── dev-hybrid/                      # `bun dev` on the host vs the cluster's backends + sandbox
│       └── dev-hybrid.sh
├── production/                          # PRODUCTION references (external deps, hardened)
│   └── values-sandbox-env-prod.yaml     #   prod-hardened sandbox-env
├── scripts/
│   └── local-k8s.sh            # thin wrapper: helm dep build + install + teardown
└── skills/
    └── self-host-studio/       # LLM-guided install skill
```

The umbrella keeps the official chart ([`deploy/helm/studio`](../deploy/helm/studio))
lean — it composes it as a dependency rather than adding bundled infra to it —
while offering a single `helm install` for self-hosters who want everything on
Kubernetes.
