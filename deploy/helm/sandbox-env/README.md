# sandbox-env Helm chart

Studio-side resources that consume the agent-sandbox operator. Install one
release per environment (dev / staging / prod / ...) — every resource name
is suffixed with `envName` so multiple releases coexist in the shared
`agent-sandbox-system` namespace without collisions.

Renders:

- `SandboxTemplate` `studio-sandbox-<envName>` + `studio-sandbox-<envName>-medium`
  (same pod spec, roomier memory — see `mediumResources`)
- `Role` + `RoleBinding` `studio-sandbox-runner-<envName>` (for the Studio
  ServiceAccount of THIS env's studio install)
- `Secret` `studio-sandbox-sentinel-<envName>` (initial daemon token)
- `SandboxWarmPool` `studio-sandbox-<envName>` and `...-medium` (optional)
- `HorizontalPodAutoscaler` for the warm pool (optional; requires explicit metrics)
- `Deployment` `studio-sandbox-placeholder-<envName>` — node "balloon" (optional)
- `Gateway` + `Certificate` `agent-sandbox-preview-<envName>` (optional;
  per-claim HTTPRoutes are minted by the Studio runner, not by this chart)
- `CronJob` + scoped RBAC for idle-claim cleanup (optional)

Requires the [`sandbox-operator`](../sandbox-operator/) chart to already be
installed (it ships the CRDs + controller).

## Prerequisites

- `sandbox-operator` chart installed in `agent-sandbox-system`.
- Kubernetes with `spec.hostUsers: true` privileged-sidecar support (org-fs FUSE mount).
- Studio object storage configured with `S3_ENDPOINT`, `S3_BUCKET`,
  `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` (plus provider-appropriate
  `S3_REGION` and `S3_FORCE_PATH_STYLE`). Org-fs is mandatory for hosted
  sandboxes. Keep these values in the Studio Secret: the sidecar mounts org-fs
  through Studio's authenticated API and must not receive S3 credentials.
- A named ServiceAccount for the Studio release. Its namespace and name must
  match `mesh.namespace` and `mesh.serviceAccountName`; this chart grants that
  identity the runner permissions in `agent-sandbox-system`.
- The Studio release must explicitly set
  `STUDIO_SANDBOX_PROVIDER=agent-sandbox`. The default provider is the user's
  linked desktop and is not a production cluster configuration.
- The Studio release for THIS environment must point its runner at
  the env-suffixed SandboxTemplate by setting
  `STUDIO_SANDBOX_TEMPLATE_NAME=studio-sandbox-<envName>` in the studio
  chart's `configMap.meshConfig`. Without that override the runner falls
  back to `studio-sandbox` (no suffix) and claim creation fails with
  `sandboxtemplate not found`.
- The studio release must also set `STUDIO_ENV=<envName>` (same envName)
  so Studio stamps `studio.decocms.com/env=<envName>` on every SandboxClaim,
  pod, and HTTPRoute it creates. The housekeeper's default selectors
  scope sweeps to that env label — without it the housekeeper matches
  zero claims and reaps nothing. Set it for every new installation even when
  the housekeeper is initially disabled so claims remain ready for later
  cleanup and multi-environment operation.

## Sandbox isolation

The untrusted sandbox container runs non-root with privilege escalation
disabled, all capabilities dropped, `RuntimeDefault` seccomp, and a read-only
root filesystem by default. Writable `emptyDir` mounts cover `/app`, `/tmp`,
and `/home/sandbox`.

The mandatory org-fs sidecar is the only privileged container. It uses FUSE
and bidirectional mount propagation to expose organization files under
`/app/org`, which requires `hostUsers: true`. `disableFsSidecar=true` is a
debug-only escape hatch, not a supported production mode.

Egress is enforced by the `netinit` init container, not by a Kubernetes
`NetworkPolicy`. With `netinit.enabled=true`, the init container temporarily
uses `NET_ADMIN` to install iptables rules, then exits before user code starts.
The default CIDR lists cover private, link-local, shared-address, and common
cluster ranges; override them for clusters with different pod or Service
CIDRs. If another CNI or firewall owns egress, disable `netinit` and provide
equivalent controls.

## Preview gateway auth model

If you flip `previewGateway.enabled=true`, read this first.

The Host header is the *only* authorization on `*.preview.<domain>` (no
listener-level auth, matching how Vercel preview URLs work). That means
sandbox handles travel in plaintext through every CDN / LB / proxy in the
request path and will appear in their access logs. Treat handles as
URL-grade secrets — do not share in tickets, screenshots, etc.

For tighter isolation, terminate auth at the Gateway with an
`AuthorizationPolicy` (Istio) or extauth (Envoy) in front of this listener.
This chart does not do that for you.

**Multi-env note:** two envs can both enable `previewGateway` only if they
use different `previewGateway.domain` values. The resource names are
envName-suffixed but the listener hostname (`*.<domain>`) must be unique
per Gateway — two Gateways binding the same wildcard hostname conflict at
the controller level.

## Install

Published as an OCI artifact at
`oci://ghcr.io/decocms/studio/charts/sandbox-env` by
`.github/workflows/release-sandbox-charts.yaml`.

```bash
helm install sandbox-env-staging \
  oci://ghcr.io/decocms/studio/charts/sandbox-env \
  --version 0.15.3 \
  --namespace agent-sandbox-system \
  --set envName=staging \
  --set mesh.namespace=deco-studio-staging \
  --set mesh.serviceAccountName=deco-studio-staging
```

Then point the studio (chart-deco-studio) release for the same env at
this runner:

```yaml
# in your studio values.yaml (for the staging install)
serviceAccount:
  create: true
  name: deco-studio-staging
  automount: true

configMap:
  meshConfig:
    STUDIO_SANDBOX_PROVIDER: "agent-sandbox"
    STUDIO_ENV: "staging"
    STUDIO_SANDBOX_TEMPLATE_NAME: "studio-sandbox-staging"
    # The next three values are required only when previewGateway.enabled=true.
    STUDIO_SANDBOX_PREVIEW_URL_PATTERN: "https://{handle}.preview.staging.example.com"
    # Per-claim HTTPRoute attaches to this Gateway. Both required whenever
    # previewGateway.enabled=true — without them Studio falls back to its
    # in-process preview proxy, which the chart no longer wires up.
    # NAMESPACE must match `previewGateway.namespace` from the chart values
    # (no default — different gateway controllers live in different
    # namespaces, and a wrong default would silently fail to attach).
    STUDIO_SANDBOX_PREVIEW_GATEWAY_NAME: "agent-sandbox-preview-staging"
    STUDIO_SANDBOX_PREVIEW_GATEWAY_NAMESPACE: "istio-system"
```

### Warm-pool token wiring

`warmPool.enabled` is off by default. When enabling it, generate one sentinel
token and deliver the same value to both charts:

- Set `sandbox-env`'s `sentinel.token` so the template and pool pods use it.
- Put it in the Studio Secret as `STUDIO_SANDBOX_SENTINEL_TOKEN`.

Studio uses the sentinel only for the first configuration request after a pool
pod is bound, then rotates the daemon to a per-claim token. If
`sentinel.token` is omitted, this chart generates and preserves its own value,
but Studio cannot consume warm-pool pods until it receives that same value.
Keep it in a Secret, never `configMap.meshConfig`.

### Node placeholder ("balloon") — warm-pool warms pods, this warms nodes

`warmPool` pre-warms sandbox **pods** (image pull + kubelet start + daemon
boot), but every warm-pool pod still needs a **node**. When the pool refills
after a burst, its HPA/KEDA scaler grows it, or a cold claim lands beyond the
pool, the new pods go `Pending` and wait on Karpenter to provision a node —
tens of seconds of user-visible latency that `warmPool` alone can't remove.

`nodePlaceholder` (off by default) runs low-priority "balloon" pods that hold
`replicas` sandbox-slots of capacity on already-running nodes. A real sandbox /
warm-pool pod preempts one instantly (priority-based), takes the freed slot on
the warm node, and Karpenter re-provisions a node for the evicted balloon in
the background. Net effect: the **user-facing** claim never waits on node
provisioning.

Requirements and behavior:

- **Placement defaults to the sandbox pod's own `nodeSelector` / `tolerations`**
  so the warm capacity lands on the same taint-isolated sandbox NodePool. A
  balloon on the general pool would do nothing for the sandbox pool. Override
  `nodePlaceholder.nodeSelector` / `.tolerations` only to pin elsewhere.
- **`priorityClassName` must be a low / negative-priority class** so real
  sandbox pods (priority 0) preempt it. Defaults to `placeholder-priority`
  (the class the existing sites balloon uses on eks-serverless); self-hosters
  must create an equivalent (`value: -10`, `globalDefault: false`).
- **Size `replicas` once per NodePool.** Prod and staging share the sandbox
  NodePool, so the balloon in one env warms nodes the other also uses — don't
  double-count.
- **Costs a real sandbox slot's worth of idle capacity per replica.** Unlike
  the general-pool placeholder, this idle node is not amortized by other
  workloads (the pool is taint-isolated). Enable only after confirming the
  claim-latency tail is node provisioning (Pod-created → Node-assigned), not
  daemon boot / install / mount — otherwise a bigger `warmPool` or `depsCache`
  is the right lever instead.

### ArgoCD Application (one per env)

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: sandbox-env-staging
  namespace: argocd
spec:
  project: default
  source:
    repoURL: ghcr.io/decocms/studio/charts
    chart: sandbox-env
    targetRevision: 0.15.3
    helm:
      values: |
        envName: staging
        mesh:
          namespace: deco-studio-staging
          serviceAccountName: deco-studio-staging
  destination:
    server: https://kubernetes.default.svc
    namespace: agent-sandbox-system
  syncPolicy:
    syncOptions:
      - ServerSideApply=true
```

Repeat the `Application` per env, varying `metadata.name` and `envName`.

### Upgrading an existing release to enable the housekeeper

`helm upgrade --reuse-values` does NOT pull in defaults for newly-added
values keys, so an upgrade that flips `housekeeper.enabled=true` on a
release installed before the housekeeper landed will fail with
`nil pointer evaluating interface {}.repository`. Use
`--reset-then-reuse-values` (Helm 3.14+) instead, or re-pass the full
values file:

```bash
helm upgrade sandbox-env-staging \
  oci://ghcr.io/decocms/studio/charts/sandbox-env \
  --version 0.15.3 \
  --namespace agent-sandbox-system \
  --reset-then-reuse-values \
  --set housekeeper.enabled=true
```

ArgoCD users are unaffected — `Application.spec.source.helm.values` is a
re-render from scratch, not a merge.

## Layout

```
sandbox-env/
├── Chart.yaml
├── values.yaml                          # tunables + envName + legacy mesh.* cross-refs
├── examples/
│   └── values-kind.yaml                 # local dev overrides
└── templates/
    ├── _helpers.tpl
    ├── validations.yaml                 # envName + Gateway API + cert-manager preflight
    ├── sandbox-template.yaml            # SandboxTemplate (per-env)
    ├── sandbox-warm-pool.yaml           # SandboxWarmPool (optional)
    ├── sandbox-warmpool-hpa.yaml         # Warm-pool HPA (optional)
    ├── sandbox-node-placeholder.yaml    # Node "balloon" Deployment (optional)
    ├── sandbox-sentinel-secret.yaml      # Initial daemon token
    ├── sandbox-rbac.yaml                # Role + cross-ns RoleBinding to Studio SA
    ├── sandbox-preview-cert.yaml        # cert-manager Certificate (optional)
    ├── sandbox-preview-gateway.yaml     # Gateway only — per-claim HTTPRoutes are minted by Studio
    └── sandbox-housekeeper.yaml         # Idle cleanup CronJob + RBAC (optional)
```

## Values

See `values.yaml` for the full set. The most-tuned ones:

> Compatibility: `mesh.*` is the legacy public values key for references to
> the Studio release. It remains supported so existing values files continue
> to upgrade safely; a future chart major may rename it to `studio.*`.

| Key | Default | Notes |
| --- | --- | --- |
| `envName` | _(required)_ | DNS-label suffix on every resource name |
| `image.repository` | `ghcr.io/decocms/studio/studio-sandbox-go` | sandbox image (Go daemon — the implementation IS the image) |
| `image.tag` | chart `appVersion` | bump in lockstep with packages/sandbox/package.json |
| `resources.*` | 0.5/2 CPU, 2/4Gi RAM | per sandbox pod |
| `mediumResources.*` | 3/6Gi RAM | deep-merged over `resources.*` into a second `<name>-medium` SandboxTemplate; Studio sends `cloneOnly` (Claude Code dispatch) claims to `<STUDIO_SANDBOX_TEMPLATE_NAME>-medium`, so this chart must be upgraded before the Studio release that names it |
| `nodeSelector` / `tolerations` / `affinity` | `{}` | for sandbox isolation NodePool |
| `topologySpreadConstraints` | `[]` | spread sandbox pods across AZs; see `values.yaml` for the recommended config |
| `disruptionProtection.doNotDisrupt` | `false` | annotate pods with Karpenter's `do-not-disrupt` to block voluntary node consolidation/drift while a sandbox is claimed; trades cluster cost/upgrade cadence for session safety |
| `readOnlyRootFilesystem` | `true` | RO rootfs + emptyDirs on /app, /tmp, /home |
| `netinit.enabled` | `true` | installs the iptables egress policy before user code starts |
| `telemetry.enabled` | `false` | let the daemon export OTLP metrics: opens ONE extra egress destination (the collector) and sets `OTEL_EXPORTER_OTLP_ENDPOINT` |
| `telemetry.otlp.ip` / `telemetry.otlp.port` | `""` / `4318` | collector **ClusterIP** and port. Must be an IP — sandboxes use `dnsPolicy: None`, so in-cluster DNS names do not resolve. Goes stale if the Service is recreated |
| `disableFsSidecar` | `false` | debug-only opt-out from the mandatory privileged org-fs sidecar |
| `depsCache.enabled` / `depsCache.golden` | `false` / `false` | opt-in node-local dependency caches |
| `depsCache.remote.enabled` / `depsCache.remote.pvcName` | `false` / `""` | opt-in L2 cross-node golden archive on an RWX PVC, mounted read-only |
| `warmPool.enabled` / `warmPool.size` | `false` / `0` | only after measuring cold-start pain |
| `warmPool.autoscaling.enabled` | `false` | HPA; requires at least one explicit metric |
| `nodePlaceholder.enabled` / `nodePlaceholder.replicas` | `false` / `2` | node "balloon": warm NODE capacity so warm-pool refill / cold claims skip the Karpenter wait; placement defaults to the sandbox `nodeSelector`/`tolerations` |
| `previewGateway.enabled` | `false` | wildcard `*.preview.<domain>` Gateway + cert |
| `housekeeper.enabled` | `false` | idle-claim and orphan cleanup CronJob |
| `housekeeper.renewActiveSeconds` | `120` | renew a claim's `shutdownTime` while its daemon is still serving traffic (keeps directly-opened preview URLs alive); `0` disables |
| `mesh.namespace` | `deco-studio` | studio release namespace (this env's) |
| `mesh.serviceAccountName` | `deco-studio` | Studio ServiceAccount that gets the RoleBinding |
| `mesh.serviceName` | `deco-studio` | _deprecated, unused since per-claim HTTPRoutes_ |
| `mesh.servicePort` | `80` | _deprecated, unused since per-claim HTTPRoutes_ |
| `mesh.podSelectorLabels` | `chart-deco-studio` / `deco-studio` | _deprecated, unused since chart-managed NetworkPolicy removal_ |
