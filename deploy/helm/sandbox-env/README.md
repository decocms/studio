# sandbox-env Helm chart

Studio-side resources that consume the agent-sandbox operator. Install one
release per environment (dev / staging / prod / ...) — every resource name
is suffixed with `envName` so multiple releases coexist in the shared
`agent-sandbox-system` namespace without collisions.

Renders:

- `SandboxTemplate` `studio-sandbox-<envName>`
- `Role` + `RoleBinding` `studio-sandbox-runner-<envName>` (for the mesh
  ServiceAccount of THIS env's studio install)
- `NetworkPolicy` `studio-sandbox-<envName>` (per-env podSelector)
- `SandboxWarmPool` `studio-sandbox-<envName>` (optional)
- `Gateway` + `Certificate` `agent-sandbox-preview-<envName>` (optional;
  per-claim HTTPRoutes are minted by the mesh runner, not by this chart)

Requires the [`sandbox-operator`](../sandbox-operator/) chart to already be
installed (it ships the CRDs + controller).

## Prerequisites

- `sandbox-operator` chart installed in `agent-sandbox-system`.
- Kubernetes 1.30+ (for `spec.hostUsers: false` user namespace remap).
- The studio release for THIS environment must point its mesh runner at
  the env-suffixed SandboxTemplate by setting
  `STUDIO_SANDBOX_TEMPLATE_NAME=studio-sandbox-<envName>` in the studio
  chart's `configMap.meshConfig`. Without that override the runner falls
  back to `studio-sandbox` (no suffix) and claim creation fails with
  `sandboxtemplate not found`.
- The studio release must also set `STUDIO_ENV=<envName>` (same envName)
  so mesh stamps `studio.decocms.com/env=<envName>` on every SandboxClaim,
  pod, and HTTPRoute it creates. The housekeeper's default selectors
  scope sweeps to that env label — without it the housekeeper matches
  zero claims and reaps nothing. Single-env installs that don't enable
  the housekeeper can leave `STUDIO_ENV` unset (the label is then
  omitted and behavior is unchanged).

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
  --version 0.5.0 \
  --namespace agent-sandbox-system \
  --set envName=staging \
  --set mesh.namespace=deco-studio-staging \
  --set mesh.serviceAccountName=deco-studio-staging \
  --set mesh.serviceName=deco-studio-staging \
  --set mesh.servicePort=80
```

Then point the studio (chart-deco-studio) release for the same env at
this runner:

```yaml
# in your studio values.yaml (for the staging install)
configMap:
  meshConfig:
    STUDIO_SANDBOX_RUNNER: "agent-sandbox"
    STUDIO_ENV: "staging"
    STUDIO_SANDBOX_TEMPLATE_NAME: "studio-sandbox-staging"
    STUDIO_SANDBOX_PREVIEW_URL_PATTERN: "https://{handle}.preview.staging.example.com"
    # Per-claim HTTPRoute attaches to this Gateway. Both required whenever
    # previewGateway.enabled=true — without them mesh falls back to its
    # in-process preview proxy, which the chart no longer wires up.
    # NAMESPACE must match `previewGateway.namespace` from the chart values
    # (no default — different gateway controllers live in different
    # namespaces, and a wrong default would silently fail to attach).
    STUDIO_SANDBOX_PREVIEW_GATEWAY_NAME: "agent-sandbox-preview-staging"
    STUDIO_SANDBOX_PREVIEW_GATEWAY_NAMESPACE: "istio-system"
```

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
    targetRevision: 0.5.0
    helm:
      values: |
        envName: staging
        mesh:
          namespace: deco-studio-staging
          serviceAccountName: deco-studio-staging
          serviceName: deco-studio-staging
          servicePort: 80
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
  --version 0.5.0 \
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
├── values.yaml                          # tunables + envName + mesh.* cross-refs
├── examples/
│   └── values-kind.yaml                 # local dev overrides
└── templates/
    ├── _helpers.tpl
    ├── validations.yaml                 # envName + Gateway API + cert-manager preflight
    ├── sandbox-template.yaml            # SandboxTemplate (per-env)
    ├── sandbox-warm-pool.yaml           # SandboxWarmPool (optional)
    ├── sandbox-network-policy.yaml      # NetworkPolicy on sandbox pods (per-env)
    ├── sandbox-rbac.yaml                # Role + cross-ns RoleBinding to mesh SA
    ├── sandbox-preview-cert.yaml        # cert-manager Certificate (optional)
    └── sandbox-preview-gateway.yaml     # Gateway only — per-claim HTTPRoutes are minted by mesh
```

## Values

See `values.yaml` for the full set. The most-tuned ones:

| Key | Default | Notes |
| --- | --- | --- |
| `envName` | _(required)_ | DNS-label suffix on every resource name |
| `image.repository` | `ghcr.io/decocms/studio/studio-sandbox` | studio-sandbox image |
| `image.tag` | chart `appVersion` | bump in lockstep with packages/sandbox/package.json |
| `resources.*` | 0.5/2 CPU, 1/4Gi RAM | per sandbox pod |
| `nodeSelector` / `tolerations` / `affinity` | `{}` | for sandbox isolation NodePool |
| `topologySpreadConstraints` | `[]` | spread sandbox pods across AZs; see `values.yaml` for the recommended config |
| `hostUsers` | `false` | userns remap; flip to `true` if kernel/containerd doesn't support userns |
| `readOnlyRootFilesystem` | `true` | RO rootfs + emptyDirs on /app, /tmp, /home |
| `networkPolicy.enabled` | `true` | locks down ingress/egress |
| `warmPool.enabled` / `warmPool.size` | `false` / `0` | only after measuring cold-start pain |
| `previewGateway.enabled` | `false` | wildcard `*.preview.<domain>` Gateway + cert |
| `mesh.namespace` | `deco-studio` | studio release namespace (this env's) |
| `mesh.serviceAccountName` | `deco-studio` | mesh ServiceAccount that gets the RoleBinding |
| `mesh.serviceName` | `deco-studio` | _deprecated, unused since per-claim HTTPRoutes_ |
| `mesh.servicePort` | `80` | _deprecated, unused since per-claim HTTPRoutes_ |
| `mesh.podSelectorLabels` | `chart-deco-studio` / `deco-studio` | for the NetworkPolicy ingress rule |
